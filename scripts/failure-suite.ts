// Failure suite, handoff items 1-8 (t8 shells out to scripts/upgrade-test.sh).
// Usage: npx tsx scripts/failure-suite.ts [t1 t1b t2 t3 t3b t4a t4b t4c t4d t5 t6 t7 t8 t9 t9b t9c]
// Needs: local Postgres (PG_ADMIN_URL) and `npx tsx src/externals.ts` running.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  LOG_DIR, all, killAllWorkers, applyOpsSchema, dbUrl, freshDb, mockCalls, one, providerStats, resetExternals, setFaults, sleep, startWorker, waitFor,
  type Result,
} from './lib.js';
import { assertListenNotifyWorks, assertNotTransactionPooler } from '../src/config.js';

const AGENT = 'spike-agent';

async function runState(db: pg.Pool, wf: string) {
  return (await one(db, `select run_state from ops.v_runs where workflow_id = $1`, [wf]))?.run_state as string | undefined;
}
async function trigger(w: { http: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: any }> }, requestId: string) {
  const r = await w.http('POST', `/agents/${AGENT}/run`, { requestId });
  if (r.status !== 202) throw new Error(`trigger failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.workflowID as string;
}
async function actionsFor(db: pg.Pool, wf: string) {
  return all(db, `select id, logical_action, status, idempotency_key, result, error from ops.actions where source_workflow_id = $1 order by logical_action`, [wf]);
}
function logFile(name: string) {
  const f = path.join(LOG_DIR, name);
  fs.rmSync(f, { force: true });
  return f;
}
function callsPerTurn(calls: { wf: string; turn: number }[], wf: string) {
  const out: Record<number, number> = {};
  for (const c of calls.filter((c) => c.wf === wf)) out[c.turn] = (out[c.turn] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------------------------
async function t1(): Promise<Result> {
  const { url, db } = await freshDb('spike_t1');
  const mock = logFile('t1.mock');
  const env = { MOCK_DELAY_MS: '800', MOCK_CALL_LOG: mock, RAILWAY_DEPLOYMENT_ID: 'dep-1111', RAILWAY_REPLICA_ID: 'rep-aaaa' };
  let a = await startWorker({ id: 't1-boot1', port: 7810, dbUrl: url, env });
  const wf = await trigger(a, 'r1');
  await waitFor('model turn 2 in flight', () => mockCalls(mock).some((c) => c.turn === 2));
  await a.kill('SIGKILL');
  const stateAtKill = await one(db, `select status, executor_id from dbos.workflow_status where workflow_uuid = $1`, [wf]);
  const actionsAtKill = (await actionsFor(db, wf)).length;
  a = await startWorker({ id: 't1-boot2', port: 7810, dbUrl: url, env });
  const recoverMs = await waitFor('recovered run terminal', async () => (await runState(db, wf)) === 'succeeded', 30_000);
  const actions = await actionsFor(db, wf);
  const runs = await one(db, `select count(*)::int n, max(outcome) outcome from ops.runs where workflow_id = $1`, [wf]);
  const v = await one(db, `select run_state, recovery_attempts, executor_id from ops.v_runs where workflow_id = $1`, [wf]);
  const turns = callsPerTurn(mockCalls(mock), wf);
  const executors = await all(db, `select executor_id, railway_deployment_id, railway_replica_id, reaped_by from ops.executors order by started_at`);
  await a.kill('SIGTERM');
  const ok = v.run_state === 'succeeded' && v.executor_id === 't1-boot2' && actions.length === 3 && runs.n === 1 && turns[0] === 1 && turns[1] === 1;
  return {
    id: 't1', title: 'Kill mid-agent-loop; the restarted process (same replica, NEW executor ID) takes over', classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: { stateAtKill, actionsAtKill, recoverMs, finalState: v, executors, actions: actions.length, distinctKeys: new Set(actions.map((x) => x.idempotency_key)).size, runLedgerRows: runs.n, modelCallsPerTurn: turns },
    notes: [
      'A restart is a new process, so it is a new executor; Railway replica/deployment IDs are recorded as metadata only.',
      'Takeover is by the heartbeat sweep (DEAD_AFTER_MS), not DBOS launch recovery. Completed model calls (turns 0,1) replayed from checkpoints.',
    ],
  };
}

async function t1b(): Promise<Result> {
  const { url, db } = await freshDb('spike_t1b');
  const mock = logFile('t1b.mock');
  const env = { MOCK_DELAY_MS: '800', MOCK_CALL_LOG: mock };
  const a = await startWorker({ id: 't1b-a', port: 7810, dbUrl: url, env });
  const wf = await trigger(a, 'r1');
  await waitFor('model turn 2 in flight', () => mockCalls(mock).some((c) => c.turn === 2));
  await a.kill('SIGKILL');
  const killedAt = Date.now();
  const b = await startWorker({ id: 't1b-b', port: 7811, dbUrl: url, env });
  await waitFor('replacement finished run', async () => (await runState(db, wf)) === 'succeeded', 45_000);
  const recoverMs = Date.now() - killedAt;
  const ex = await one(db, `select reaped_by, reaped_count from ops.executors where executor_id = 't1b-a'`);
  const v = await one(db, `select run_state, executor_id, recovery_attempts from ops.v_runs where workflow_id = $1`, [wf]);
  const actions = await actionsFor(db, wf);
  const turns = callsPerTurn(mockCalls(mock), wf);
  await b.kill('SIGTERM');
  const ok = v.run_state === 'succeeded' && v.executor_id === 't1b-b' && actions.length === 3 && turns[0] === 1 && turns[1] === 1;
  return {
    id: 't1b', title: 'Kill mid-agent-loop, NEW container (different executor ID) takes over',
    classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: { recoverMsFromKill: recoverMs, reaped: ex, finalState: v, actions: actions.length, modelCallsPerTurn: turns },
    notes: [
      'DBOS alone would NOT recover this: launch recovery only reclaims PENDING rows for its own executor ID.',
      'Adapter = ops.executors heartbeat + atomic reap + public DBOS.resumeWorkflows() (same workflow ID, checkpoints kept).',
      'Recovery latency ≈ DEAD_AFTER_MS (5s in suite) + sweep interval.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
async function t2(): Promise<Result> {
  const { url, db } = await freshDb('spike_t2');
  await resetExternals();
  const marker = logFile('t2.crash-marker');
  let a = await startWorker({ id: 't2-a', port: 7810, dbUrl: url, env: { CRASH_AFTER_PROVIDER_CALL: marker } });
  const wf = await trigger(a, 'r1');
  await waitFor('reasoning run done', async () => (await runState(db, wf)) === 'succeeded');
  const acts = await actionsFor(db, wf);
  const byType = Object.fromEntries(acts.map((x) => [x.logical_action, x]));
  const approve1 = await a.http('POST', `/actions/${byType['crm.note'].id}/approve`, { by: 'rone' });
  const approve2 = await a.http('POST', `/actions/${byType['calendar.hold'].id}/approve`, { by: 'rone' }).catch((e) => ({ status: -1, body: String(e) }));
  const rejectR = await a.http('POST', `/actions/${byType['email.draft'].id}/reject`, { by: 'rone' }).catch((e) => ({ status: -1, body: String(e) }));
  const exitCode = await Promise.race([a.exited, sleep(15_000).then(() => 'still-running')]);
  const atCrash = await providerStats();
  a = await startWorker({ id: 't2-b', port: 7810, dbUrl: url });
  // If the crash beat the 2nd approval/reject, do them now: approval must be retry-safe.
  for (const [k, op] of [['calendar.hold', 'approve'], ['email.draft', 'reject']] as const) {
    const cur = await one(db, `select status from ops.actions where id = $1`, [byType[k].id]);
    if (cur.status === 'pending_approval') await a.http('POST', `/actions/${byType[k].id}/${op}`, { by: 'rone' });
  }
  await waitFor('both approved actions executed', async () => {
    const r = await actionsFor(db, wf);
    return r.filter((x) => x.status === 'executed').length === 2;
  });
  // Rule 2: DBOS dedupes a second start under the same workflow ID.
  const client = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: 'dbos', applicationName: 'rone-agent-base' });
  const dup = await client.enqueue({ queueName: 'executor', workflowName: 'executeAction', workflowID: byType['crm.note'].idempotency_key }, byType['crm.note'].id);
  await dup.getResult().catch(() => undefined);
  await client.destroy();
  const reapprove = await a.http('POST', `/actions/${byType['crm.note'].id}/approve`, { by: 'rone' });
  await sleep(1500);
  const stats = await providerStats();
  const final = await actionsFor(db, wf);
  const execWfs = await all(db, `select workflow_id, run_state, recovery_attempts from ops.v_runs where kind = 'executor' order by workflow_id`);
  await a.kill('SIGTERM');
  const ok = stats.uniqueEffects === 2 && final.filter((x) => x.status === 'executed').length === 2 && final.some((x) => x.status === 'rejected');
  return {
    id: 't2', title: 'Kill executor after external call, before local checkpoint', classification: ok ? 'PASS' : 'FAIL',
    metrics: {
      crashExit: exitCode, providerAtCrash: atCrash, providerFinal: stats,
      requestAttemptsVsUniqueEffects: `${stats.attempts} attempts → ${stats.uniqueEffects} committed effects (${stats.deduped} deduplicated by provider)`,
      approvals: { approve1: approve1.status, approve2: approve2.status, reject: rejectR.status, reapproveAfterExecuted: reapprove.status },
      executorWorkflows: execWfs, finalActions: final.map((x) => ({ a: x.logical_action, s: x.status })),
    },
    notes: [
      'Executor workflow IDs equal the action idempotency keys; a second enqueue under the same ID returned the existing workflow.',
      'The post-call/pre-checkpoint window is real: the provider saw the same key twice. Exactly-once effect came from the provider-side Idempotency-Key, as rule 3 says.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
async function t3(): Promise<Result> {
  const { url, db } = await freshDb('spike_t3');
  await applyOpsSchema(db);
  await db.query(`update ops.agents set schedule = '*/2 * * * * *' where id = $1`, [AGENT]);
  const mock = logFile('t3.mock');
  const env = { MOCK_DELAY_MS: '1000', MOCK_CALL_LOG: mock, DISABLE_SCHEDULES: '0' };
  const oldW = await startWorker({ id: 't3-old', port: 7810, dbUrl: url, env });
  await sleep(4000);
  const long = await trigger(oldW, 'deploy-inflight');
  await waitFor('in-flight run on old', () => mockCalls(mock).some((c) => c.wf === long && c.turn === 1));
  const newW = await startWorker({ id: 't3-new', port: 7811, dbUrl: url, env });
  const overlapSamples: string[] = [];
  for (let i = 0; i < 6; i++) {
    overlapSamples.push((await one(db, `select executor_id from dbos.workflow_status where workflow_uuid = $1`, [long])).executor_id);
    await sleep(300);
  }
  await waitFor('in-flight run mid-loop (turn 3)', () => mockCalls(mock).some((c) => c.wf === long && c.turn === 3));
  const pendingOnOldAtKill = (await all(db, `select workflow_uuid from dbos.workflow_status where executor_id = 't3-old' and status = 'PENDING'`)).map((r) => r.workflow_uuid);
  await oldW.kill('SIGKILL');
  const killedAt = Date.now();
  await waitFor('in-flight run settled by new', async () => (await runState(db, long)) === 'succeeded', 45_000);
  const takeoverMs = Date.now() - killedAt;
  const client = await DBOSClient.create({ systemDatabaseUrl: url, systemDatabaseSchemaName: 'dbos', applicationName: 'rone-agent-base' });
  await client.pauseSchedule(`agent-${AGENT}`);
  await client.destroy();
  await waitFor('every workflow terminal', async () =>
    (await one(db, `select count(*)::int n from ops.v_runs where run_state not in ('succeeded', 'failed', 'cancelled')`)).n === 0, 45_000).catch(() => undefined);
  await newW.kill('SIGTERM');

  const sched = await all(db, `select workflow_id, run_state, executor_id from ops.v_runs where workflow_id like 'sched-%' order by workflow_id`);
  const calls = mockCalls(mock);
  const doubled: Record<string, number[]> = {};
  for (const wf of new Set(calls.map((c) => c.wf))) {
    const t = callsPerTurn(calls, wf);
    const d = Object.entries(t).filter(([, n]) => n > 1).map(([k]) => Number(k));
    if (d.length) doubled[wf] = d;
  }
  const occurrenceSeconds = sched.map((s) => s.workflow_id.slice(-24));
  const dupActions = await one(db, `select count(*)::int n from (select source_workflow_id, logical_action from ops.actions group by 1, 2 having count(*) > 1) x`);
  const longRow = await one(db, `select run_state, executor_id, recovery_attempts from ops.v_runs where workflow_id = $1`, [long]);
  const longRuns = await one(db, `select count(*)::int n from ops.runs where workflow_id = $1`, [long]);
  const nonTerminal = sched.filter((s) => !['succeeded', 'failed'].includes(s.run_state));
  const onlyKillVictimsDoubled = Object.keys(doubled).every((wf) => pendingOnOldAtKill.includes(wf));
  const ok = overlapSamples.every((e) => e === 't3-old') && longRow.run_state === 'succeeded' && longRow.executor_id === 't3-new'
    && longRuns.n === 1 && dupActions.n === 0 && nonTerminal.length === 0
    && new Set(occurrenceSeconds).size === occurrenceSeconds.length && onlyKillVictimsDoubled;
  return {
    id: 't3', title: 'Rolling deploy: old+new overlap with schedules running, then old disappears (SIGKILL)',
    classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: {
      overlapExecutorSamples: overlapSamples, pendingOnOldAtKill, takeoverMs, inflightRun: longRow, inflightLedgerRows: longRuns.n,
      scheduledOccurrences: sched.length, distinctOccurrences: new Set(occurrenceSeconds).size,
      byExecutor: sched.reduce((m: Record<string, number>, s) => ((m[s.executor_id] = (m[s.executor_id] ?? 0) + 1), m), {}),
      nonTerminalAtEnd: nonTerminal, duplicateActionGroups: dupActions.n, modelTurnsRunMoreThanOnce: doubled,
    },
    notes: [
      'Two live schedulers never produced two runs for one occurrence (ID = sched-<name>-<scheduled ISO>).',
      'During overlap the new container never claimed the old one\'s PENDING work (unique executor IDs).',
      'Turns re-run more than once are only the calls in flight when the old container was killed; completed ones replayed from checkpoints.',
    ],
  };
}

async function t3b(): Promise<Result> {
  const { url, db } = await freshDb('spike_t3b');
  const mock = logFile('t3b.mock');
  const env = { MOCK_DELAY_MS: '1200', MOCK_CALL_LOG: mock, DRAIN_TIMEOUT_MS: '20000' };
  const oldW = await startWorker({ id: 't3b-old', port: 7810, dbUrl: url, env });
  const wf = await trigger(oldW, 'drain-me');
  await waitFor('run in flight', () => mockCalls(mock).some((c) => c.wf === wf && c.turn === 1));
  const newW = await startWorker({ id: 't3b-new', port: 7811, dbUrl: url, env });
  const t0 = Date.now();
  oldW.proc.kill('SIGTERM');
  const code = await oldW.exited;
  const drainMs = Date.now() - t0;
  const v = await one(db, `select run_state, executor_id, recovery_attempts from ops.v_runs where workflow_id = $1`, [wf]);
  const ex = await one(db, `select stopped_at is not null stopped, reaped_at is not null reaped from ops.executors where executor_id = 't3b-old'`);
  const turns = callsPerTurn(mockCalls(mock), wf);
  await newW.kill('SIGTERM');
  const ok = v.run_state === 'succeeded' && v.executor_id === 't3b-old' && Object.values(turns).every((n) => n === 1);
  return {
    id: 't3b', title: 'Rolling deploy: old gets SIGTERM and drains in-flight work before exiting', classification: ok ? 'PASS' : 'FAIL',
    metrics: { exitCode: code, drainMs, finalState: v, oldExecutor: ex, modelCallsPerTurn: turns },
    notes: ['DBOS.shutdown({workflowCompletionTimeoutMS}) finished the in-flight run on the old container; nothing re-ran.'],
  };
}

// ---------------------------------------------------------------------------------------------
async function versionScenario(name: string, oldEnv: Record<string, string>, newEnv: Record<string, string>) {
  const { url, db } = await freshDb(`spike_${name}`);
  await resetExternals();
  const a = await startWorker({ id: `${name}-old`, port: 7810, dbUrl: url, env: { ...oldEnv, HANG_IN_MARK_EXECUTED_MS: '15000' } });
  const wf = await trigger(a, 'r1');
  await waitFor('reasoning run done', async () => (await runState(db, wf)) === 'succeeded');
  const acts = Object.fromEntries((await actionsFor(db, wf)).map((x) => [x.logical_action, x]));
  await a.http('POST', `/actions/${acts['crm.note'].id}/approve`);
  await waitFor('callProvider checkpointed (old now hanging in markExecuted)', async () =>
    (await all(db, `select 1 from dbos.operation_outputs where workflow_uuid = $1 and function_name = 'callProvider'`, [acts['crm.note'].idempotency_key])).length === 1);
  await a.kill('SIGKILL');
  const b = await startWorker({ id: `${name}-new`, port: 7811, dbUrl: url, env: newEnv });
  await b.http('POST', `/actions/${acts['calendar.hold'].id}/approve`);
  const settle = await waitFor('both settle', async () => {
    const r = await all(db, `select status from ops.actions where id = any($1)`, [[acts['crm.note'].id, acts['calendar.hold'].id]]);
    return r.every((x) => ['executed', 'failed'].includes(x.status));
  }, 25_000).catch((e) => String(e.message));
  const final = await all(db, `select logical_action, status, error from ops.actions where id = any($1) order by logical_action`, [[acts['crm.note'].id, acts['calendar.hold'].id]]);
  const steps = async (k: string) =>
    (await all(db, `select function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id`, [acts[k].idempotency_key])).map((r) => r.function_name);
  const wfs = await all(db, `select workflow_id, run_state, dbos_status, app_version, executor_id, error_class from ops.v_runs where kind = 'executor' order by workflow_id`);
  const attention = await all(db, `select kind, ref, detail from ops.attention_queue where kind in ('run_stuck', 'queued_too_long', 'run_failed', 'action_failed', 'action_stuck', 'no_executor_for_version')`);
  const dbosErr = await one(db, `select error from dbos.workflow_status where workflow_uuid = $1`, [acts['crm.note'].idempotency_key]);
  return { db, url, b, acts, settle, final, oldSteps: await steps('crm.note'), newSteps: await steps('calendar.hold'), wfs, attention, dbosErr, stats: await providerStats() };
}

async function t4d(): Promise<Result> {
  // Review's "nasty case": old container on old code + new container on patched code, overlapping;
  // a workflow started under old code; old gets SIGTERM but its drain window is shorter than the work;
  // the new executor takes it over and must resume the OLD branch.
  const { url, db } = await freshDb('spike_t4d');
  await resetExternals();
  const oldW = await startWorker({ id: 't4d-old', port: 7810, dbUrl: url, env: { SPIKE_CODE_VARIANT: '1', HANG_IN_MARK_EXECUTED_MS: '15000', DRAIN_TIMEOUT_MS: '2000' } });
  const wf = await trigger(oldW, 'r1');
  await waitFor('reasoning run done', async () => (await runState(db, wf)) === 'succeeded');
  const acts = Object.fromEntries((await actionsFor(db, wf)).map((x) => [x.logical_action, x]));
  await oldW.http('POST', `/actions/${acts['crm.note'].id}/approve`);
  await waitFor('callProvider checkpointed; old now inside markExecuted', async () =>
    (await all(db, `select 1 from dbos.operation_outputs where workflow_uuid = $1 and function_name = 'callProvider'`, [acts['crm.note'].idempotency_key])).length === 1);
  const newW = await startWorker({ id: 't4d-new', port: 7811, dbUrl: url, env: { SPIKE_CODE_VARIANT: '2' } });
  const t0 = Date.now();
  oldW.proc.kill('SIGTERM');
  const oldExit = await oldW.exited;
  const drainMs = Date.now() - t0;
  const atOldExit = await one(db, `select status, executor_id from dbos.workflow_status where workflow_uuid = $1`, [acts['crm.note'].idempotency_key]);
  await waitFor('new executor finished the old-code workflow', async () =>
    (await one(db, `select status from ops.actions where id = $1`, [acts['crm.note'].id])).status === 'executed', 45_000);
  const takeoverMs = Date.now() - t0;
  await newW.http('POST', `/actions/${acts['calendar.hold'].id}/approve`);
  await waitFor('new work on patched code', async () => (await one(db, `select status from ops.actions where id = $1`, [acts['calendar.hold'].id])).status === 'executed');
  const steps = async (k: string) =>
    (await all(db, `select function_name from dbos.operation_outputs where workflow_uuid = $1 order by function_id`, [acts[k].idempotency_key])).map((r) => r.function_name);
  const oldSteps = await steps('crm.note');
  const newSteps = await steps('calendar.hold');
  const stats = await providerStats();
  const oldRow = await one(db, `select executor_id, run_state from ops.v_runs where workflow_id = $1`, [acts['crm.note'].idempotency_key]);
  const exec = await one(db, `select stopped_at is not null as drained_flag, reaped_by from ops.executors where executor_id = 't4d-old'`);
  await newW.kill('SIGTERM');
  const ok = oldExit === 0 && atOldExit.status === 'PENDING' && oldRow.executor_id === 't4d-new' && oldRow.run_state === 'succeeded'
    && !oldSteps.includes('auditBeforeCall') && !oldSteps.some((n: string) => n.startsWith('DBOS.patch'))
    && newSteps.includes('auditBeforeCall') && stats.attempts === 2 && stats.uniqueEffects === 2;
  return {
    id: 't4d', title: 'Old code drains (SIGTERM, short window) while patched new code overlaps; new takes over and resumes the OLD branch',
    classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: { oldExitCode: oldExit, drainMs, workflowAtOldExit: atOldExit, takeoverMs, oldExecutor: exec, oldWorkflowFinal: oldRow, oldWorkflowSteps: oldSteps, newWorkflowSteps: newSteps, provider: stats },
    notes: [
      'Drain timed out with the workflow mid-step, so it stayed PENDING under the old executor; the new (patched) executor reaped it and DBOS.patch() returned false at the patch point, so the old step sequence resumed.',
      'callProvider was replayed from its checkpoint: 2 provider attempts total for 2 actions, no re-call.',
    ],
  };
}

async function t4a(): Promise<Result> {
  const r = await versionScenario('t4a', { SPIKE_CODE_VARIANT: '1' }, { SPIKE_CODE_VARIANT: '2' });
  await r.b.kill('SIGTERM');
  const ok = r.final.every((x) => x.status === 'executed') && !r.oldSteps.includes('auditBeforeCall') && r.newSteps.includes('auditBeforeCall') && r.stats.uniqueEffects === 2;
  return {
    id: 't4a', title: 'Deploy a step-inserting code change while work is mid-flight (patching mode + DBOS.patch)',
    classification: ok ? 'PASS' : 'FAIL',
    metrics: { settleMs: r.settle, final: r.final, oldWorkflowSteps: r.oldSteps, newWorkflowSteps: r.newSteps, executorRuns: r.wfs, provider: r.stats },
    notes: ['Old execution replayed its original step sequence on new code; new executions took the patched branch. Nothing stranded.'],
  };
}

async function t4b(): Promise<Result> {
  const r = await versionScenario('t4b', { SPIKE_CODE_VARIANT: '1' }, { SPIKE_CODE_VARIANT: '2-unpatched' });
  await r.b.kill('SIGTERM');
  const oldFailed = r.final.find((x) => x.logical_action === 'crm.note')?.status !== 'executed';
  const surfaced = r.attention.some((a) => a.kind === 'action_stuck') && r.wfs.some((w) => w.error_class === 'unclassified_workflow_error');
  return {
    id: 't4b', title: 'Same change WITHOUT DBOS.patch (the mistake rule 4 forbids)',
    classification: oldFailed && surfaced ? 'PASS' : 'FAIL',
    metrics: { settleMs: r.settle, final: r.final, oldWorkflowSteps: r.oldSteps, executorRuns: r.wfs, attention: r.attention, dbosError: String(r.dbosErr?.error ?? '').slice(0, 300) },
    notes: [
      'Expected-negative control: DBOS detects the step-sequence mismatch on replay and refuses to continue, instead of silently doing the wrong thing.',
      'Classification is PASS if the unpatched change is caught and surfaced in health; it confirms the discipline is enforced, not optional.',
    ],
  };
}

async function t4c(): Promise<Result> {
  const r = await versionScenario('t4c', { DBOS_VERSIONING: 'build', BUILD_VERSION: 'build-v1' }, { DBOS_VERSIONING: 'build', BUILD_VERSION: 'build-v2' });
  await sleep(3000);
  const stranded = await all(r.db, `select workflow_id, run_state, app_version from ops.v_runs where kind = 'executor' and run_state in ('queued', 'running')`);
  const strandedWhileOnlyV2 = stranded.length;
  const attentionWhileOnlyV2 = await all(r.db, `select kind, ref, detail from ops.attention_queue where kind = 'no_executor_for_version'`);
  await r.b.kill('SIGTERM');
  // Only an executor running the OLD build can finish old-build work.
  const v1again = await startWorker({ id: 't4c-old-again', port: 7812, dbUrl: r.url, env: { DBOS_VERSIONING: 'build', BUILD_VERSION: 'build-v1' } });
  const drained = await waitFor('old-build work finished by an old-build executor', async () =>
    (await all(r.db, `select 1 from ops.actions where id = $1 and status = 'executed'`, [r.acts['crm.note'].id])).length === 1, 25_000).catch((e) => String(e.message));
  await v1again.kill('SIGTERM');
  return {
    id: 't4c', title: 'Same deploy in build-version mode (DBOS__APPVERSION = build ID)',
    classification: strandedWhileOnlyV2 > 0 && attentionWhileOnlyV2.length > 0 ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: { finalWithOnlyV2Alive: r.final, strandedWhileOnlyV2: stranded, attentionWhileOnlyV2, newApprovalUnderV2: r.final.find((x) => x.logical_action === 'calendar.hold'), drainedByOldBuildMs: drained },
    notes: [
      'Hard rule 4 as written (version = build) strands an old build\'s in-flight work once the old container is gone: v2 executors will not dequeue v1 rows, even after resume.',
      'Approval-enqueued work with no appVersion went to the latest version and ran fine — stranding only hits work that had already started.',
      'Recovery requires keeping/starting an old-build executor until drained (or cross-version fork/rewind, which breaks the ID = idempotency-key rule).',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
async function t5(): Promise<Result> {
  const { url, db } = await freshDb('spike_t5');
  await resetExternals();
  const out: Record<string, unknown> = {};
  const mock = logFile('t5.mock');

  let w = await startWorker({ id: 't5-auth', port: 7810, dbUrl: url, env: { MOCK_FAIL: 'auth', MOCK_CALL_LOG: mock } });
  const wAuth = await trigger(w, 'auth');
  await waitFor('auth failure terminal', async () => (await runState(db, wAuth)) === 'failed');
  out.modelAuth = { ...(await one(db, `select run_state, error_class, error_message from ops.v_runs where workflow_id = $1`, [wAuth])), modelCalls: mockCalls(mock).filter((c) => c.wf === wAuth).length };
  out.healthAfterAuth = await one(db, `select health_state, last_error_class from ops.agent_health where agent_id = $1`, [AGENT]);
  await w.kill('SIGTERM');

  w = await startWorker({ id: 't5-overload', port: 7810, dbUrl: url, env: { MOCK_FAIL: 'overloaded', MOCK_CALL_LOG: mock } });
  const wOv = await trigger(w, 'overloaded');
  await waitFor('overload failure terminal', async () => (await runState(db, wOv)) === 'failed', 45_000);
  out.modelOverloaded = { ...(await one(db, `select run_state, error_class from ops.v_runs where workflow_id = $1`, [wOv])), modelCalls: mockCalls(mock).filter((c) => c.wf === wOv).length };
  await w.kill('SIGTERM');

  w = await startWorker({ id: 't5-ok', port: 7810, dbUrl: url, env: { MOCK_CALL_LOG: mock } });
  const wOk = await trigger(w, 'ok');
  await waitFor('ok run', async () => (await runState(db, wOk)) === 'succeeded');
  out.healthAfterRecovery = await one(db, `select health_state from ops.agent_health where agent_id = $1`, [AGENT]);
  const acts = Object.fromEntries((await actionsFor(db, wOk)).map((x) => [x.logical_action, x]));

  await setFaults({ failNext: 2, status: 503 });
  await w.http('POST', `/actions/${acts['crm.note'].id}/approve`);
  await waitFor('transient provider fault absorbed', async () => (await one(db, `select status from ops.actions where id = $1`, [acts['crm.note'].id])).status === 'executed', 20_000);
  out.executorTransient = await providerStats();

  await setFaults({ failNext: 99, status: 503 });
  await w.http('POST', `/actions/${acts['calendar.hold'].id}/approve`);
  await waitFor('hard provider outage → failed', async () => (await one(db, `select status from ops.actions where id = $1`, [acts['calendar.hold'].id])).status === 'failed', 30_000);
  out.executorHardDown = await one(db, `select a.status, a.error, v.run_state, v.error_class from ops.actions a join ops.v_runs v on v.workflow_id = a.idempotency_key where a.id = $1`, [acts['calendar.hold'].id]);
  await setFaults({ failNext: 0 });

  await db.query(`update ops.connections set status = 'expired', last_error = 'refresh token expired' where id = 'fake_provider:spike'`);
  const wConn = await trigger(w, 'conn');
  await waitFor('connection failure terminal', async () => (await runState(db, wConn)) === 'failed');
  out.connectionExpired = { ...(await one(db, `select run_state, error_class from ops.v_runs where workflow_id = $1`, [wConn])), modelCalls: mockCalls(mock).filter((c) => c.wf === wConn).length };
  out.healthWhenBlocked = await one(db, `select health_state, blocked_connections from ops.agent_health where agent_id = $1`, [AGENT]);
  out.attention = await all(db, `select kind, ref, detail from ops.attention_queue where kind <> 'approval_needed' order by kind`);
  await w.kill('SIGTERM');

  const m = out as any;
  const ok = m.modelAuth.error_class === 'provider_auth' && m.modelAuth.modelCalls === 1
    && m.modelOverloaded.error_class === 'provider_unavailable' && m.modelOverloaded.modelCalls === 3
    && m.executorTransient.uniqueEffects === 1 && m.executorHardDown.error_class === 'provider_unavailable'
    && m.connectionExpired.error_class === 'connection_unavailable' && m.connectionExpired.modelCalls === 0
    && m.healthWhenBlocked.health_state === 'blocked' && m.healthAfterAuth.health_state === 'failing';
  return {
    id: 't5', title: 'Provider / connection failures → error classification and health state', classification: ok ? 'PASS' : 'FAIL',
    metrics: out,
    notes: ['Non-retryable auth errors fail fast (1 call); retryable overload retries to the durableCalls limit; an expired required connection blocks before any model spend.'],
  };
}

async function t6(): Promise<Result> {
  const db = new pg.Pool({ connectionString: dbUrl('spike_t5') });
  const deps = await all(db, `
    select distinct dependent.relname as ops_object, referenced.relname as dbos_object
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid
      join pg_class dependent on dependent.oid = r.ev_class
      join pg_namespace dn on dn.oid = dependent.relnamespace
      join pg_class referenced on referenced.oid = d.refobjid
      join pg_namespace rn on rn.oid = referenced.relnamespace
     where dn.nspname = 'ops' and rn.nspname = 'dbos'`);
  const defs = await all(db, `select viewname, definition ~* 'dbos\\.' as mentions_dbos from pg_views where schemaname = 'ops'`);
  const client = await DBOSClient.create({ systemDatabaseUrl: dbUrl('spike_t5'), systemDatabaseSchemaName: 'dbos' });
  const api = await client.listWorkflows({});
  await client.destroy();
  const apiCounts: Record<string, number> = {};
  for (const w of api.filter((w) => ['agentRun', 'scheduledAgentRun', 'executeAction'].includes(w.workflowName))) apiCounts[w.status] = (apiCounts[w.status] ?? 0) + 1;
  const viewCounts = Object.fromEntries((await all(db, `select dbos_status, count(*)::int n from ops.v_runs group by 1`)).map((r) => [r.dbos_status, r.n]));
  const health = await all(db, `select * from ops.agent_health`);
  await db.end();
  const ok = deps.length === 0 && defs.filter((d) => d.viewname !== 'v_runs').every((d) => !d.mentions_dbos) && JSON.stringify(apiCounts) === JSON.stringify(Object.fromEntries(Object.entries(viewCounts).sort()));
  return {
    id: 't6', title: 'ops.v_runs feeds health + attention without coupling them to DBOS internals', classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: { pgDependOpsOnDbos: deps, viewsMentioningDbos: defs, statusCountsDbosApi: apiCounts, statusCountsVRuns: viewCounts, health },
    notes: [
      'Zero pg_depend edges from ops.* to dbos.*: DBOS migrations can never be blocked by our views.',
      'Only ops.dbos_workflows() names a dbos table; agent_health/attention_queue read v_runs only.',
      'v_runs status counts match the public DBOSClient.listWorkflows() API exactly.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
async function t7(): Promise<Result> {
  const { url, db } = await freshDb('spike_t7');
  const tx = dbUrl('spike_t7_tx', 'postgres://postgres@127.0.0.1:6432/postgres');
  const sess = dbUrl('spike_t7_sess', 'postgres://postgres@127.0.0.1:6432/postgres');
  const m: Record<string, unknown> = {};
  try { assertNotTransactionPooler('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres'); m.guardOn6543 = 'NOT refused'; } catch (e) { m.guardOn6543 = `refused: ${(e as Error).message.slice(0, 80)}`; }
  try { assertNotTransactionPooler('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres'); m.guardOnSession5432 = 'allowed'; } catch { m.guardOnSession5432 = 'refused'; }
  m.listenProbeDirect = await assertListenNotifyWorks(url).then(() => 'ok', (e) => `fail: ${e.message}`);
  m.listenProbeSessionPooler = await assertListenNotifyWorks(sess).then(() => 'ok', (e) => `fail: ${e.message}`);
  m.listenProbeTxPooler = await assertListenNotifyWorks(tx).then(() => 'ok', (e) => `fail: ${e.message.slice(0, 90)}`);

  const refused = await startWorker({ id: 't7-guarded-tx', port: 7810, dbUrl: tx, expectBoot: false });
  m.workerOnTxPoolerWithGuard = { exitCode: await Promise.race([refused.exited, sleep(15_000).then(() => 'still running')]) };

  // Session pooler: full crash/recover + approval path.
  const mock = logFile('t7.mock');
  let a = await startWorker({ id: 't7-sess', port: 7810, dbUrl: sess, env: { MOCK_DELAY_MS: '600', MOCK_CALL_LOG: mock } });
  const wf = await trigger(a, 'sess');
  await waitFor('turn 2 in flight', () => mockCalls(mock).some((c) => c.wf === wf && c.turn === 2));
  await a.kill('SIGKILL');
  a = await startWorker({ id: 't7-sess2', port: 7810, dbUrl: sess, env: { MOCK_CALL_LOG: mock } });
  await waitFor('recovered via session pooler', async () => (await runState(db, wf)) === 'succeeded');
  const act = (await actionsFor(db, wf))[0];
  const t0 = Date.now();
  await a.http('POST', `/actions/${act.id}/approve`);
  await waitFor('executed via session pooler', async () => (await one(db, `select status from ops.actions where id = $1`, [act.id])).status === 'executed');
  m.sessionPooler = { crashRecovery: 'succeeded', approvalToExecutedMs: Date.now() - t0, dbosSelfTestWarning: fs.readFileSync(a.log, 'utf8').includes('self-test failed') };
  await a.kill('SIGTERM');

  // What happens if someone bypasses the guard on a transaction pooler?
  const { url: url2, db: db2 } = await freshDb('spike_t7b');
  void url2;
  const txb = dbUrl('spike_t7b_tx', 'postgres://postgres@127.0.0.1:6432/postgres');
  const u = await startWorker({ id: 't7-unsafe-tx', port: 7811, dbUrl: txb, env: { UNSAFE_SKIP_CONNECTION_GUARD: '1' }, expectBoot: false });
  const booted = await waitFor('unsafe boot', () => fs.readFileSync(u.log, 'utf8').includes('http on :7811'), 30_000).then(() => true, () => false);
  let unsafe: Record<string, unknown> = { booted, dbosSelfTestWarning: fs.readFileSync(u.log, 'utf8').includes('self-test failed') };
  if (booted) {
    const wf2 = await trigger(u, 'tx');
    const done = await waitFor('run via tx pooler', async () => (await runState(db2, wf2)) === 'succeeded', 30_000).then((ms) => ms, (e) => e.message);
    unsafe = { ...unsafe, runCompletedMs: done };
  }
  m.transactionPoolerWithGuardBypassed = unsafe;
  await u.kill('SIGTERM');
  await db2.end();

  const ok = String(m.guardOn6543).startsWith('refused') && m.guardOnSession5432 === 'allowed' && m.listenProbeSessionPooler === 'ok'
    && String(m.listenProbeTxPooler).startsWith('fail') && (m.workerOnTxPoolerWithGuard as any).exitCode !== 'still running';
  return {
    id: 't7', title: 'Supabase-style connection modes: direct / session pooler / transaction pooler (pgbouncer stand-in)',
    classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: m,
    notes: [
      'Stand-in: local pgbouncer in session and transaction pool modes. Supabase\'s pooler is Supavisor; re-run t7 against the real project before locking.',
      'DBOS 5.3 itself only WARNS behind a transaction pooler and falls back to polling; our startup guard turns that silent degradation into a refusal.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
async function t8(): Promise<Result> {
  const chain = process.env.DBOS_CHAIN ?? '5.1.10 5.2.11 5.3.0';
  const r = spawnSync('bash', ['scripts/upgrade-test.sh'], {
    env: { ...process.env, DBOS_CHAIN: chain, UPGRADE_WORKDIR: path.join(LOG_DIR, 'upgrade') }, encoding: 'utf8', timeout: 600_000,
  });
  const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => /^==|migrations|recovered result|UPGRADE TEST/.test(l));
  const pass = r.status === 0 && lines.some((l) => l.includes('UPGRADE TEST: PASS'));
  return {
    id: 't8', title: `Upgrade DBOS under live data (${chain.replace(/ /g, ' → ')})`, classification: pass ? 'PASS' : 'FAIL',
    metrics: { exitCode: r.status, transcript: lines },
    notes: [
      'Each hop: a workflow is SIGKILLed mid-flight under the old DBOS, then the new DBOS launches (running its migrations) and finishes it.',
      'npm only carries the latest patch of each 5.x minor (5.0.2, 5.1.10, 5.2.11, 5.3.0), so this is two consecutive minor hops rather than a same-minor patch hop.',
      '5.1.10 → 5.2.11 includes a real schema migration (122 → 123) applied with ops views in place; 5.2.11 → 5.3.0 has none.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// H1. Zombie executor: a process that is alive but unheard. Two shapes:
//   t9  'partition' — only its heartbeat writes fail; the process and its workflow keep running.
//   t9b 'stall'     — the whole process freezes (SIGSTOP) past DEAD_AFTER_MS, a peer reaps it and resumes the
//                     workflow, then the zombie wakes up (SIGCONT) mid-way through the peer's run.
// Pass = one outcome owned by the peer, no duplicated effects, the zombie fences itself out (exit 70) and
// never writes over the peer, and health/attention never claim a failure at any sampled moment.
async function zombie(mode: 'partition' | 'stall' | 'stall-no-lease'): Promise<Result> {
  const id = { partition: 't9', stall: 't9b', 'stall-no-lease': 't9c' }[mode];
  const { url, db } = await freshDb(`spike_${id}`);
  const mock = logFile(`${id}.mock`);
  const env = { MOCK_DELAY_MS: '2500', MOCK_CALL_LOG: mock };
  // t9c: no lease, and a slow heartbeat so the woken zombie reaches its next checkpoint before its next heartbeat:
  // only DBOS's checkpoint-ownership fence and our catch blocks stand in its way.
  const z = await startWorker({ id: `${id}-zombie`, port: 7810, dbUrl: url, env: mode === 'stall-no-lease' ? { ...env, LEASE_FRACTION: '0', HEARTBEAT_MS: '15000' } : env });
  const wf = await trigger(z, 'zombie-1');
  await waitFor('zombie in model turn 1', () => mockCalls(mock).some((c) => c.wf === wf && c.turn === 1));
  let zombieExitedAt: number | undefined;
  void z.exited.then(() => { zombieExitedAt = Date.now(); });
  if (mode === 'partition') {
    // Reject only the zombie's heartbeat (a write that moves last_seen_at); everything else still works.
    await db.query(`
      create or replace function ops.t9_partition() returns trigger language plpgsql as $$
      begin
        if old.executor_id = '${id}-zombie' and new.last_seen_at is distinct from old.last_seen_at then
          raise exception 't9: heartbeat partitioned';
        end if;
        return new;
      end $$;
      create trigger t9_partition before update on ops.executors for each row execute function ops.t9_partition();`);
  } else {
    z.proc.kill('SIGSTOP');
  }
  const silencedAt = Date.now();
  const b = await startWorker({ id: `${id}-b`, port: 7811, dbUrl: url, env });

  // Sample what the owner would see on the phone the whole way through.
  const samples: { t: number; health: string; lastOutcome: string | null; items: string[] }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const h = await one(db, `select health_state, last_outcome from ops.agent_health where agent_id = $1`, [AGENT]);
      const items = (await all(db, `select kind, ref from ops.attention_queue where kind in ('run_failed', 'run_stuck', 'executor_unreaped', 'action_failed')`))
        .map((r) => `${r.kind}:${r.ref}`);
      samples.push({ t: Date.now() - silencedAt, health: h?.health_state, lastOutcome: h?.last_outcome ?? null, items });
      await sleep(400);
    }
  })();

  await waitFor('zombie reaped', async () => (await one(db, `select reaped_by from ops.executors where executor_id = $1`, [`${id}-zombie`])).reaped_by === `${id}-b`, 30_000);
  const reapedAt = Date.now();
  if (mode !== 'partition') {
    await waitFor('peer running the resumed workflow', () => mockCalls(mock).some((c) => c.wf === wf && c.pid === String(b.proc.pid)), 20_000);
    z.proc.kill('SIGCONT'); // wake the zombie while the peer is mid-run
  }
  const exitCode = await Promise.race([z.exited, sleep(25_000).then(() => 'still running')]);
  await waitFor('run succeeded', async () => (await runState(db, wf)) === 'succeeded', 60_000);
  await sleep(3000);
  sampling = false; await sampler;

  const v = await one(db, `select run_state, executor_id, recovery_attempts from ops.v_runs where workflow_id = $1`, [wf]);
  const actions = await actionsFor(db, wf);
  const runs = await one(db, `select count(*)::int n, max(outcome) outcome, max(error_message) err from ops.runs where workflow_id = $1`, [wf]);
  const calls = mockCalls(mock).filter((c) => c.wf === wf);
  const zPid = String(z.proc.pid), bPid = String(b.proc.pid);
  const byPid = { zombie: calls.filter((c) => c.pid === zPid).map((c) => c.turn), peer: calls.filter((c) => c.pid === bPid).map((c) => c.turn) };
  const zombieLog = fs.readFileSync(z.log, 'utf8').split('\n');
  const fenceLine = zombieLog.find((l) => l.includes('FENCED')) ?? null;
  const conflictLines = zombieLog.filter((l) => /no longer owned/.test(l)).length;
  const final = samples.at(-1)!;
  const lied = samples.filter((s) => s.lastOutcome === 'failed' || s.health === 'failing' || s.items.some((i) => i.startsWith('run_failed') || i.startsWith('action_failed')));
  const fencedBeforeReap = mode === 'partition' ? zombieExitedAt !== undefined && zombieExitedAt < reapedAt : true;
  const ok = v.run_state === 'succeeded' && v.executor_id === `${id}-b` && runs.n === 1 && runs.outcome === 'succeeded'
    && actions.length === 3 && new Set(actions.map((a) => a.idempotency_key)).size === 3
    && exitCode === 70 && fencedBeforeReap && (mode !== 'stall-no-lease' || conflictLines > 0)
    && lied.length === 0 && final.health === 'healthy' && final.items.length === 0;
  await b.kill('SIGTERM');
  return {
    id, title: {
      partition: 'H1: zombie executor, heartbeat partitioned while the process keeps running',
      stall: 'H1: zombie executor, process frozen past the reap, then wakes mid-way through the peer\'s run',
      'stall-no-lease': 'H1: same stall with the lease disabled: DBOS rejects the zombie\'s checkpoint and it stands down',
    }[mode],
    classification: ok ? 'PASS WITH ADAPTER' : 'FAIL',
    metrics: {
      reapMsAfterSilence: reapedAt - silencedAt, zombieExitMsAfterSilence: zombieExitedAt ? zombieExitedAt - silencedAt : null,
      fencedBeforeReap, zombieExit: exitCode, fenceLine, conflictLines,
      finalState: v, runLedger: runs, actions: actions.length, distinctKeys: new Set(actions.map((a) => a.idempotency_key)).size,
      modelTurnsByProcess: byPid, healthSamples: samples.length, healthTimeline: [...new Set(samples.map((s) => s.health))],
      misleadingSamples: lied.slice(0, 5), final,
    },
    notes: mode === 'stall-no-lease' ? [
      'Defence in depth: with no lease, the woken zombie finishes its in-flight model call and tries to checkpoint it. DBOS rejects it (DBOSWorkflowConflictError: no longer owned), our catch rethrows it untouched (no failed run recorded), DBOS parks that execution to adopt the owner\'s outcome, and the zombie\'s next heartbeat sees it was reaped and exits 70.',
    ] : mode === 'partition' ? [
      'Partition = a test trigger that rejects only the zombie heartbeat write; its process, workflow and queue polling keep running.',
      'Before the lease, the zombie kept running past its reap and dequeued the workflow its replacement had just resumed: two executions of one workflow in one process; the AI SDK durable-call guard failed the legitimate one, and our catch block recorded the run as failed. Now the zombie exits once it has been silent for 60% of DEAD_AFTER_MS, before any peer may reap it.',
    ] : [
      'The frozen process cannot dequeue, so the peer owns the resumed workflow. On waking, the zombie checks its lease before anything else and exits (code 70); any checkpoint it attempts first is rejected by DBOS (workflow no longer owned), and our catch blocks now rethrow that untouched instead of recording a failed run.',
    ],
  };
}
const t9 = () => zombie('partition');
const t9b = () => zombie('stall');
const t9c = () => zombie('stall-no-lease');

// ---------------------------------------------------------------------------------------------
const TESTS: Record<string, () => Promise<Result>> = { t1, t1b, t2, t3, t3b, t4a, t4b, t4c, t4d, t5, t6, t7, t8, t9, t9b, t9c };
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TESTS);
const resultsPath = path.resolve('docs/spike-results.json');
const results: Record<string, Result> = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};

for (const id of selected) {
  const t0 = Date.now();
  console.log(`\n=== ${id} ===`);
  try {
    const r = await TESTS[id]();
    results[id] = r;
    console.log(`${r.classification}  ${r.title}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(JSON.stringify(r.metrics, null, 2));
  } catch (err) {
    results[id] = { id, title: id, classification: 'FAIL', metrics: { error: (err as Error).message }, notes: ['harness error'] };
    console.log(`FAIL (harness): ${(err as Error).stack}`);
  } finally {
    await killAllWorkers();
  }
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
}
const failed = selected.filter((id) => results[id]?.classification === 'FAIL' || results[id]?.classification === 'ARCHITECTURAL PROBLEM');
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nall ${selected.length} selected tests passed`);
process.exit(failed.length ? 1 : 0);
