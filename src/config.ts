import os from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export const APP_NAME = 'rone-agent-base';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

export const DATABASE_URL = required('DATABASE_URL');

// Supabase: direct (db.<ref>.supabase.co:5432) or session pooler (*.pooler.supabase.com:5432).
// Transaction pooler (port 6543) breaks LISTEN/NOTIFY and session state that DBOS relies on.
export function assertNotTransactionPooler(url: string): void {
  const u = new URL(url);
  if (u.port === '6543' || u.searchParams.get('pgbouncer') === 'true') {
    throw new Error(
      `Refusing to start: ${u.hostname}:${u.port} looks like a transaction-mode pooler. ` +
        'Use the direct connection or the session pooler (port 5432).',
    );
  }
}

// Runtime proof, not a URL heuristic: a transaction pooler silently drops LISTEN registrations.
export async function assertListenNotifyWorks(url: string, timeoutMS = 3000): Promise<void> {
  const listener = new pg.Client({ connectionString: url });
  const notifier = new pg.Client({ connectionString: url });
  await listener.connect();
  await notifier.connect();
  const channel = `ops_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  try {
    const received = new Promise<void>((resolve) => listener.on('notification', (m) => m.channel === channel && resolve()));
    await listener.query(`LISTEN ${channel}`);
    await notifier.query(`NOTIFY ${channel}`);
    const timedOut = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LISTEN/NOTIFY probe timed out after ${timeoutMS}ms — not a session-capable connection`)), timeoutMS),
    );
    await Promise.race([received, timedOut]);
  } finally {
    await listener.end().catch(() => undefined);
    await notifier.end().catch(() => undefined);
  }
}

// One executor = one process (hard rule 5, and DBOS's own definition of executorID). Every boot gets a
// fresh ID, so nothing depends on how Railway's IDs behave across restarts or overlapping deploys: a
// restarted process is a new executor, and the dead one's PENDING work is taken over by the heartbeat
// sweep (src/recovery.ts). Railway IDs are recorded as metadata only (ops.executors).
export const BOOT_ID = randomUUID();
export const PROCESS_META = {
  hostname: os.hostname(),
  pid: process.pid,
  railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
  railwayReplicaId: process.env.RAILWAY_REPLICA_ID ?? null,
  gitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
};
// EXECUTOR_ID override is for the local failure suite; it must still be unique per process start
// (registerExecutor refuses a reused ID).
export const EXECUTOR_ID =
  process.env.EXECUTOR_ID ??
  [PROCESS_META.railwayDeploymentId?.slice(0, 8), PROCESS_META.railwayReplicaId?.slice(0, 8), BOOT_ID].filter(Boolean).join('-');

if (process.env.DBOS__VMID) {
  throw new Error('DBOS__VMID is set; executor identity must be unique per process. Leave it unset.');
}

// 'patching' (default): constant DBOS version, breaking changes gated by DBOS.patch().
// 'build': version = build ID; work from an old version only runs on an old-version executor.
export const VERSIONING = (process.env.DBOS_VERSIONING ?? 'patching') as 'patching' | 'build';
export const BUILD_VERSION = process.env.BUILD_VERSION ?? process.env.RAILWAY_GIT_COMMIT_SHA;

export const HTTP_PORT = Number(process.env.PORT ?? 7800);
export const FAKE_PROVIDER_URL = process.env.FAKE_PROVIDER_URL ?? 'http://127.0.0.1:7801';

export const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 5000);
export const DEAD_AFTER_MS = Number(process.env.DEAD_AFTER_MS ?? 30000);
export const DRAIN_TIMEOUT_MS = Number(process.env.DRAIN_TIMEOUT_MS ?? 20000);
