// Pause/resume against real schedules: a paused agent's occurrences are skipped (and recorded as skipped),
// resuming lets the next ones run. Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-pause.ts
import fs from 'node:fs';
import path from 'node:path';
import { applyOpsSchema, freshDb, killAllWorkers, one, sleep, startWorker } from './lib.js';

const PORT = 7860;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const { url, db } = await freshDb('spike_pause');
await applyOpsSchema(db);
await db.query(fs.readFileSync(path.resolve('sql/010_agent_pause.sql'), 'utf8'));
// Every 2 seconds, and paused before the worker ever starts.
await db.query(`update ops.agents set schedule = '*/2 * * * * *', paused_at = now(), paused_by = 'test' where id = 'spike-agent'`);
const w = await startWorker({ id: 'pause-1', port: PORT, dbUrl: url, env: { API_TOKEN: 'api-secret', DISABLE_SCHEDULES: '0' } });
const call = async (method: string, p: string) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json() };
};
const schedRuns = async () => (await one(db, `select count(*)::int n from ops.runs where agent_id = 'spike-agent' and trigger_type = 'schedule'`)).n;

try {
  await sleep(7000);
  const occurrences = (await one(db, `select count(*)::int n from dbos.workflow_status where workflow_uuid like 'sched-agent-spike-agent-%'`)).n;
  const skipped = await one(db, `select last_skipped_at from ops.agents where id = 'spike-agent'`);
  check('while paused, scheduled occurrences fire but start no agent run', occurrences >= 2 && (await schedRuns()) === 0, { occurrences, runs: await schedRuns() });
  check('…and the latest skipped occurrence is recorded', Boolean(skipped.last_skipped_at), skipped);

  const r = await call('POST', '/agents/spike-agent/resume');
  await sleep(6000);
  const after = await schedRuns();
  check('after resume, the next occurrences run', r.status === 200 && after >= 1, { resume: r, after });

  await call('POST', '/agents/spike-agent/pause');
  await sleep(2500); // let an occurrence that started just before the pause finish
  const atPause = await schedRuns();
  await sleep(5000);
  check('pausing again stops new scheduled runs', (await schedRuns()) === atPause, { atPause, now: await schedRuns() });
} finally {
  await w.kill('SIGTERM').catch(() => undefined);
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall pause checks passed');
process.exit(failures.length ? 1 : 0);
