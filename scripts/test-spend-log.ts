// Model usage / spend log V1: one row per REAL provider call, with provider, model, agent, run, tokens (incl. cache)
// and estimated cost; totals per run / agent / day come from views. Observation only (no caps, no alerts).
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-spend-log.ts
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, all, freshDb, killAllWorkers, mockCalls, one, resetExternals, startWorker, waitFor } from './lib.js';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const { url, db } = await freshDb('spike_spend_log');
await resetExternals();
const mockLog = path.join(LOG_DIR, 'spend.mock');
const failFile = path.join(LOG_DIR, 'spend-fail.mode');
fs.rmSync(mockLog, { force: true });
fs.writeFileSync(failFile, '');
const env = { MOCK_CALL_LOG: mockLog, MOCK_FAIL_FILE: failFile };
let w = await startWorker({ id: 'sp-1', port: 7896, dbUrl: url, env });

let seq = 0;
async function start(agent = 'spike-agent') {
  const r = await w.http('POST', `/agents/${agent}/run`, { requestId: `sp-${++seq}` });
  return r.body.workflowID as string;
}
const done = (wf: string, ms = 45_000) => waitFor(`run ${wf}`, async () => ['succeeded', 'failed'].includes((await one(db, `select run_state from ops.v_runs where workflow_id = $1`, [wf]))?.run_state), ms);
const callsOf = (wf: string) => all(db, `select * from ops.model_calls where run_id = $1 order by id`, [wf]);

try {
  // ---- an unpriced model is logged, never shown as $0 ----
  const wf1 = await start(); await done(wf1);
  const c1 = await callsOf(wf1);
  const paid1 = mockCalls(mockLog).filter((c) => c.wf === wf1).length;
  check('one row per real model call, with provider, model, agent and run', c1.length === paid1 && paid1 === 5
    && c1.every((c) => c.provider === 'mock' && c.model === 'scripted-spike' && c.agent_id === 'spike-agent' && c.run_id === wf1), { paid1, c1 });
  check('…with token counts and the DBOS step of each call', c1.length > 0 && c1.every((c) => c.input_tokens === 100 && c.output_tokens === 20 && c.cache_read_tokens === 0)
    && new Set(c1.map((c) => c.step_id)).size === c1.length, c1.map((c) => [c.step_id, c.input_tokens, c.output_tokens]));
  check('a model with no price row gets cost NULL (unpriced), not $0', c1.length > 0 && c1.every((c) => c.estimated_cost_usd === null && c.price_id === null));
  const r1 = await one(db, `select calls, unpriced_calls, estimated_cost_usd from ops.v_spend_runs where run_id = $1`, [wf1]);
  check('the per-run view counts unpriced calls', r1.calls === 5 && r1.unpriced_calls === 5 && r1.estimated_cost_usd === null, r1);

  // ---- priced: cost = tokens x price ----
  await db.query(`insert into ops.model_prices (provider, model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok)
                  values ('mock', 'scripted-spike', now() - interval '1 day', 2, 10, 0.1, 2.5)`);
  const wf2 = await start(); await done(wf2);
  const c2 = await callsOf(wf2);
  check('a priced call is costed: 100 in x $2/M + 20 out x $10/M = $0.0004', c2.length === 5 && c2.every((c) => Number(c.estimated_cost_usd) === 0.0004 && c.price_id !== null), c2.map((c) => c.estimated_cost_usd));
  const r2 = await one(db, `select calls, unpriced_calls, estimated_cost_usd from ops.v_spend_runs where run_id = $1`, [wf2]);
  check('per-run total = sum of its calls ($0.002)', Number(r2.estimated_cost_usd) === 0.002 && r2.unpriced_calls === 0, r2);

  // ---- a price change applies to new calls only ----
  await db.query(`insert into ops.model_prices (provider, model, effective_from, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok)
                  values ('mock', 'scripted-spike', now(), 4, 20, 0.2, 5)`);
  const wf3 = await start(); await done(wf3);
  const c2again = await callsOf(wf2);
  const c3 = await callsOf(wf3);
  check('a new price is used for later calls ($0.0008) while earlier calls keep their cost', c3.every((c) => Number(c.estimated_cost_usd) === 0.0008)
    && c2again.every((c) => Number(c.estimated_cost_usd) === 0.0004), { c3: c3.map((c) => c.estimated_cost_usd) });

  // ---- a failed call (no answer) is not logged; the run still is ----
  fs.writeFileSync(failFile, 'credits');
  const wf4 = await start(); await done(wf4);
  fs.writeFileSync(failFile, '');
  check('a refused call (credits) adds no usage row', (await callsOf(wf4)).length === 0);

  // ---- crash mid-run: replayed checkpoints are not logged again ----
  await w.kill('SIGTERM');
  w = await startWorker({ id: 'sp-2', port: 7897, dbUrl: url, env: { ...env, MOCK_DELAY_MS: '800' } });
  const wf5 = await start();
  await waitFor('model turn 2 in flight', () => mockCalls(mockLog).some((c) => c.wf === wf5 && c.turn === 2));
  await w.kill('SIGKILL');
  w = await startWorker({ id: 'sp-3', port: 7898, dbUrl: url, env });
  await done(wf5);
  const c5 = await callsOf(wf5);
  const started5 = mockCalls(mockLog).filter((c) => c.wf === wf5).length;
  check('after a crash and recovery: one row per ANSWERED call (5), none for replayed checkpoints or the call killed in flight',
    c5.length === 5 && started5 === 6 && new Set(c5.map((c) => c.step_id)).size === 5, { rows: c5.length, started5 });

  // ---- derived totals ----
  const day = await one(db, `select calls, runs, estimated_cost_usd, unpriced_calls from ops.v_spend_daily where day_utc = (now() at time zone 'UTC')::date`);
  const agentDay = await one(db, `select calls, runs from ops.v_spend_agent_daily where agent_id = 'spike-agent' and day_utc = (now() at time zone 'UTC')::date`);
  const total = await one(db, `select count(*)::int n, sum(estimated_cost_usd) s from ops.model_calls`);
  check('daily and per-agent daily views add up to the call log', day.calls === total.n && Number(day.estimated_cost_usd) === Number(total.s)
    && agentDay.calls === total.n && agentDay.runs === 4, { day, agentDay, total });

  // ---- cache tokens are priced at their own rates (unit check of the cost SQL) ----
  process.env.DATABASE_URL = url;
  const { recordModelCall, toCallUsage } = await import('../src/usageLog.js');
  const u = toCallUsage({ inputTokens: { total: 1_100_000, cacheRead: 600_000, cacheWrite: 400_000 }, outputTokens: { total: 50_000, reasoning: 30_000 } },
    'anthropic.messages', 'claude-sonnet-5-5', null, null);
  check('uncached input is derived when the provider omits it; provider name normalised', u.input === 100_000 && u.provider === 'anthropic' && u.reasoning === 30_000, u);
  await recordModelCall(u);
  const cc = await one(db, `select estimated_cost_usd, agent_id from ops.model_calls where model = 'claude-sonnet-5-5' order by id desc limit 1`);
  // 0.1M x $2 + 0.05M x $10 + 0.6M x $0.10 + 0.4M x $2.50 = 0.2 + 0.5 + 0.06 + 1.0
  check('Sonnet 5.5 cost uses input, output, cache-read and cache-write prices ($1.76)', Number(cc.estimated_cost_usd) === 1.76 && cc.agent_id === null, cc);
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall spend log checks passed');
process.exit(failures.length ? 1 : 0);
