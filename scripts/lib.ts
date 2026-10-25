// Harness helpers for the failure suite: fresh databases, worker processes we can SIGKILL, polling.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';

export const PG_ADMIN = process.env.PG_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres';
export const EXTERNALS = process.env.FAKE_PROVIDER_URL ?? 'http://127.0.0.1:7801';
export const LOG_DIR = process.env.SUITE_LOG_DIR ?? path.resolve('.suite-logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function dbUrl(name: string, base = PG_ADMIN): string {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function freshDb(name: string): Promise<{ url: string; db: pg.Pool }> {
  const admin = new pg.Client({ connectionString: PG_ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = dbUrl(name);
  return { url, db: new pg.Pool({ connectionString: url, max: 3 }) };
}

export async function applyOpsSchema(db: pg.Pool) {
  await db.query(fs.readFileSync(path.resolve('sql/001_ops_schema.sql'), 'utf8'));
}

export async function resetExternals() {
  await fetch(`${EXTERNALS}/reset`, { method: 'POST' });
}
export async function setFaults(f: Record<string, unknown>) {
  await fetch(`${EXTERNALS}/faults`, { method: 'POST', body: JSON.stringify(f) });
}
export async function providerStats(): Promise<{ attempts: number; committed: number; deduped: number; faults: number; uniqueEffects: number }> {
  return (await fetch(`${EXTERNALS}/stats`)).json();
}

export type Worker = {
  id: string;
  port: number;
  proc: ChildProcess;
  log: string;
  exited: Promise<number | null>;
  kill: (sig?: NodeJS.Signals) => Promise<number | null>;
  http: (method: string, p: string, body?: unknown) => Promise<{ status: number; body: any }>;
};

const spawned = new Set<ChildProcess>();
export async function killAllWorkers() {
  for (const p of spawned) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  spawned.clear();
  await sleep(300);
}

export async function startWorker(opts: { id: string; port: number; dbUrl: string; env?: Record<string, string>; logName?: string; expectBoot?: boolean }): Promise<Worker> {
  const log = path.join(LOG_DIR, `${opts.logName ?? opts.id}.log`);
  const out = fs.openSync(log, 'w');
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: opts.dbUrl,
      EXECUTOR_ID: opts.id,
      PORT: String(opts.port),
      HEARTBEAT_MS: '1000',
      DEAD_AFTER_MS: '5000',
      DISABLE_SCHEDULES: '1',
      ...opts.env,
    },
    stdio: ['ignore', out, out],
  });
  spawned.add(proc);
  const exited = new Promise<number | null>((r) => proc.on('exit', (code, sig) => r(code ?? (sig ? 128 : null))));
  const w: Worker = {
    id: opts.id,
    port: opts.port,
    proc,
    log,
    exited,
    kill: async (sig = 'SIGKILL') => {
      proc.kill(sig);
      return exited;
    },
    http: async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${opts.port}${p}`, { method, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
  if (opts.expectBoot === false) return w;
  await waitFor(`${opts.id} boot`, async () => fs.readFileSync(log, 'utf8').includes(`http on :${opts.port}`), 30_000, () => proc.exitCode !== null);
  return w;
}

export async function waitFor(what: string, cond: () => Promise<boolean> | boolean, timeoutMS = 30_000, abort?: () => boolean): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMS) {
    if (await cond()) return Date.now() - t0;
    if (abort?.()) throw new Error(`aborted while waiting for ${what}`);
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMS}ms waiting for ${what}`);
}

export function mockCalls(file: string): { wf: string; turn: number; pid: string }[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = /wf=(\S+) turn=(\d+) (\d+):/.exec(l)!;
      return { wf: m[1], turn: Number(m[2]), pid: m[3] };
    });
}

export async function one<T = any>(db: pg.Pool, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query(sql, params)).rows[0] as T;
}
export async function all<T = any>(db: pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

export type Classification = 'PASS' | 'PASS WITH ADAPTER' | 'ARCHITECTURAL PROBLEM' | 'FAIL' | 'NOT TESTED';
export type Result = { id: string; title: string; classification: Classification; metrics: Record<string, unknown>; notes: string[] };
