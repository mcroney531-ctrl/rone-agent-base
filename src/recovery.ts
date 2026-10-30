// Railway recovery adapter (open question → pattern A + B).
//
// DBOS only auto-recovers, at launch, PENDING work whose executor_id equals its OWN executor ID.
// Every process boots with a fresh ID (src/config.ts), so a dead process's PENDING workflows —
// whether it crashed, was restarted, or was an old deployment — are orphaned until a live
// executor takes them over. This module:
//   - heartbeats this executor into ops.executors
//   - lets exactly one live executor claim a dead one (atomic UPDATE ... WHERE reaped_at IS NULL)
//   - resumes the dead executor's PENDING workflows with the public DBOS.resumeWorkflows() API,
//     which re-enqueues them under the SAME workflow ID and keeps their checkpoints
//   - fences: an executor that finds itself reaped exits instead of racing its own replacement
//   - lease: an executor that cannot renew its heartbeat for most of DEAD_AFTER_MS exits before a peer
//     could reap it. Otherwise a live-but-unheard executor keeps running and can even dequeue the very
//     workflows its replacement just resumed, so two executions of one workflow share a process
//     (found by failure-suite t9 / H1).
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pool } from './db.js';
import { DEAD_AFTER_MS, EXECUTOR_ID, HEARTBEAT_MS, LEASE_FRACTION, PROCESS_META } from './config.js';

export async function registerExecutor(): Promise<void> {
  const m = PROCESS_META;
  const { rowCount } = await pool.query(
    `insert into ops.executors (executor_id, app_version, hostname, pid, railway_deployment_id, railway_replica_id, git_sha)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (executor_id) do nothing`,
    [EXECUTOR_ID, DBOS.applicationVersion, m.hostname, m.pid, m.railwayDeploymentId, m.railwayReplicaId, m.gitSha],
  );
  if (rowCount !== 1) throw new Error(`executor ID ${EXECUTOR_ID} was already used by another process; IDs must be unique per process`);
}

// Exit before a peer could consider us dead: peers reap after DEAD_AFTER_MS of silence, so stop at 60% of it.
const LEASE_MS = Math.floor(DEAD_AFTER_MS * LEASE_FRACTION);
let lastRenewedAt = Date.now();

function checkLease(): void {
  const silentMs = Date.now() - lastRenewedAt;
  if (LEASE_MS > 0 && silentMs > LEASE_MS) {
    console.error(`[recovery] FENCED: heartbeat not renewed for ${silentMs}ms (lease ${LEASE_MS}ms); exiting before a peer takes over our work`);
    process.exit(70);
  }
}

async function heartbeat(): Promise<void> {
  checkLease(); // first, before anything else gets to run after a stall
  const { rows } = await pool.query(
    `update ops.executors set last_seen_at = now() where executor_id = $1 returning reaped_at, reaped_by`,
    [EXECUTOR_ID],
  );
  if (rows[0]?.reaped_at) {
    console.error(`[recovery] FENCED: this executor was reaped by ${rows[0].reaped_by}; exiting so work is not run twice`);
    process.exit(70);
  }
  if (rows[0]) lastRenewedAt = Date.now();
}

export async function sweepDeadExecutors(): Promise<{ reaped: string[]; resumed: number }> {
  const { rows: dead } = await pool.query(
    `update ops.executors set reaped_at = now(), reaped_by = $1
      where executor_id <> $1 and reaped_at is null
        and last_seen_at < now() - ($2::int * interval '1 millisecond')
      returning executor_id, app_version`,
    [EXECUTOR_ID, DEAD_AFTER_MS],
  );
  let resumed = 0;
  for (const d of dead) {
    const pending = await DBOS.listWorkflows({ status: 'PENDING', executorId: d.executor_id });
    const ids = pending.map((w) => w.workflowID);
    if (ids.length) await DBOS.resumeWorkflows(ids);
    resumed += ids.length;
    if (d.app_version !== DBOS.applicationVersion && ids.length) {
      console.warn(
        `[recovery] resumed ${ids.length} workflow(s) from ${d.executor_id} at version ${d.app_version}; ` +
          `this executor runs ${DBOS.applicationVersion} and will not dequeue them (versioned mode)`,
      );
    }
    await pool.query(`update ops.executors set reaped_count = $2 where executor_id = $1`, [d.executor_id, ids.length]);
    console.log(`[recovery] reaped dead executor ${d.executor_id}: resumed ${ids.length} PENDING workflow(s)`);
  }
  return { reaped: dead.map((d) => d.executor_id), resumed };
}

export function startLivenessLoops(): () => void {
  lastRenewedAt = Date.now();
  const hb = setInterval(() => heartbeat().catch((e) => { console.error('[recovery] heartbeat failed:', e.message); checkLease(); }), HEARTBEAT_MS);
  const sweep = setInterval(
    () => sweepDeadExecutors().catch((e) => console.error('[recovery] sweep failed:', e.message)),
    Math.max(HEARTBEAT_MS * 2, 5000),
  );
  return () => {
    clearInterval(hb);
    clearInterval(sweep);
  };
}

export async function markStopped(): Promise<void> {
  await pool.query(`update ops.executors set stopped_at = now(), last_seen_at = now() where executor_id = $1`, [EXECUTOR_ID]);
}
