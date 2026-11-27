// Model-provider health: Anthropic out of credits (or rejecting the key) becomes ONE Needs You item per outage,
// across runs and agents, and clears itself on the next successful call. Failed runs keep their history but their
// individual "Run failed" cards are folded into the provider item. Other failures (overload) are untouched.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-provider-health.ts
import fs from 'node:fs';
import path from 'node:path';
import { AttentionItemSchema } from '../src/compat.js';
import { LOG_DIR, all, freshDb, killAllWorkers, one, resetExternals, startWorker, waitFor } from './lib.js';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const { url, db } = await freshDb('spike_provider_health');
await resetExternals();
const failFile = path.join(LOG_DIR, 'provider-fail.mode');
const setFail = (mode: '' | 'credits' | 'auth' | 'overloaded') => fs.writeFileSync(failFile, mode);
setFail('');
const w = await startWorker({ id: 'ph-1', port: 7895, dbUrl: url, env: { MOCK_FAIL_FILE: failFile } });

let seq = 0;
async function run(agent = 'spike-agent') {
  const r = await w.http('POST', `/agents/${agent}/run`, { requestId: `ph-${++seq}` });
  const wf = r.body.workflowID as string;
  await waitFor(`run ${wf}`, async () => ['succeeded', 'failed'].includes((await one(db, `select run_state from ops.v_runs where workflow_id = $1`, [wf]))?.run_state), 45_000);
  return one(db, `select workflow_id, run_state, error_class, error_message from ops.v_runs where workflow_id = $1`, [wf]);
}
const attention = async () => (await w.http('GET', '/attention')).body as { type: string; ref: string; title: string; summary: string; actions: { id: string; label: string; url?: string }[] }[];
const status = () => one(db, `select state, since, failures, last_error from ops.provider_status where provider = 'anthropic'`);

try {
  const ok0 = await run();
  check('baseline: a run succeeds and the provider is ok', ok0.run_state === 'succeeded' && (await status()).state === 'ok', { ok0, st: await status() });

  // ---- credits run out: several failed runs, ONE item ----
  setFail('credits');
  const f1 = await run(); const f2 = await run(); const f3 = await run();
  const st = await status();
  check('a credits refusal fails the run with its own class (provider_billing), history kept', [f1, f2, f3].every((r) => r.run_state === 'failed' && r.error_class === 'provider_billing'), [f1, f2, f3]);
  check('the provider is marked credits_exhausted, counting every failed call', st.state === 'credits_exhausted' && st.failures >= 3 && /credit balance/.test(st.last_error), st);
  let items = await attention();
  const prov = items.filter((i) => i.type === 'provider_problem');
  check('Needs You shows exactly ONE "Claude credits unavailable" item for the outage', prov.length === 1 && prov[0].title === 'Claude credits unavailable', prov);
  check('…saying how many runs were affected, with a link to billing (no purchasing)', /3 run\(s\)/.test(prov[0]?.summary ?? '')
    && prov[0]?.actions.some((a) => a.url === 'https://console.anthropic.com/settings/billing'), prov[0]);
  check('…and the individual failed runs do not each add a "Run failed" card', !items.some((i) => i.type === 'run_failed'), items.map((i) => i.type));
  check('every item still parses through the app contract', items.every((i) => AttentionItemSchema.safeParse(i).success));
  const outage = await one(db, `select kind, ended_at, failures from ops.provider_outages where provider = 'anthropic' order by id desc limit 1`);
  check('one open outage is recorded', outage.kind === 'credits_exhausted' && outage.ended_at === null, outage);

  // ---- service restored: the next successful call clears it ----
  setFail('');
  const ok1 = await run();
  items = await attention();
  const closed = await one(db, `select ended_at from ops.provider_outages where provider = 'anthropic' order by id desc limit 1`);
  check('the next successful call clears the item automatically', ok1.run_state === 'succeeded' && (await status()).state === 'ok'
    && !items.some((i) => i.type === 'provider_problem') && closed.ended_at !== null, { ok1, st: await status(), closed });
  check('…the outage\'s failed runs stay out of Needs You after recovery (still in run history)', !items.some((i) => i.type === 'run_failed')
    && (await one(db, `select count(*)::int n from ops.runs where error_class = 'provider_billing' and outcome = 'failed'`)).n === 3);

  // ---- a rejected key is the same pattern, worded for keys ----
  setFail('auth');
  const a1 = await run();
  items = await attention();
  const keyItem = items.find((i) => i.type === 'provider_problem');
  check('a rejected API key → one "Claude API key rejected" item linking to API keys', a1.error_class === 'provider_auth' && keyItem?.title === 'Claude API key rejected'
    && keyItem.actions.some((a) => a.url === 'https://console.anthropic.com/settings/keys') && !items.some((i) => i.type === 'run_failed'), { a1, keyItem });
  // "Got it" hides it for this outage only
  await w.http('POST', `/attention/provider_problem/anthropic/dismiss`, { requestId: 'got-it' });
  check('"Got it" hides it for the rest of this outage', !(await attention()).some((i) => i.type === 'provider_problem'));
  setFail('');
  await run();
  setFail('credits');
  await run();
  check('a NEW outage after recovery raises the item again', (await attention()).some((i) => i.type === 'provider_problem' && i.title === 'Claude credits unavailable'));
  setFail('');
  await run();

  // ---- other failures are not provider outages ----
  setFail('overloaded');
  const o1 = await run();
  items = await attention();
  check('an overload (retried, then failed) is NOT a provider outage: its own "Run failed" card, provider stays ok',
    o1.error_class === 'provider_unavailable' && (await status()).state === 'ok' && items.some((i) => i.type === 'run_failed' && i.ref === o1.workflow_id)
    && !items.some((i) => i.type === 'provider_problem'), { o1, st: await status(), types: items.map((i) => i.type) });
  setFail('');
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall provider health checks passed');
process.exit(failures.length ? 1 : 0);
