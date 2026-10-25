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

// Unique per container (hard rule 5). Railway restarts of the same replica keep RAILWAY_REPLICA_ID,
// so a crash-restart self-recovers at launch; a new deployment gets a new ID and its predecessor's
// PENDING work is reclaimed by the dead-executor sweep (src/recovery.ts).
export const EXECUTOR_ID =
  process.env.EXECUTOR_ID ?? process.env.RAILWAY_REPLICA_ID ?? `${os.hostname()}-${randomUUID().slice(0, 8)}`;

if (process.env.DBOS__VMID) {
  throw new Error('DBOS__VMID is set; executor identity must be unique per container. Use EXECUTOR_ID / RAILWAY_REPLICA_ID.');
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
