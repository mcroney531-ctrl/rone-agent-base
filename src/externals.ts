// Stand-ins for the outside world, run as a separate process so killing the worker never kills them.
//   POST /effects  fake provider that honors Idempotency-Key and logs EVERY attempt
//   POST /mcp      stateless streamable-HTTP MCP server with one tool (lookup_contact)
//   GET  /stats    attempts vs unique committed effects (what the crash-window test measures)
//   POST /faults   inject provider failures: {"failNext": 3, "status": 503}
// Storage: Postgres (fake_provider schema) when FAKE_PROVIDER_DATABASE_URL is set, otherwise in memory —
// deployed, it must not spend the Supabase session pooler's small connection budget.
import http from 'node:http';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.EXTERNALS_PORT ?? process.env.PORT ?? 7801);
type Outcome = 'committed' | 'deduplicated' | 'injected_fault' | 'rejected_no_key';
type Stats = { attempts: number; n: number; committed: number; deduped: number; faults: number; uniqueEffects: number };
type Store = {
  attempt(key: string | null, body: unknown, outcome: Outcome): Promise<void>;
  commit(key: string, body: unknown): Promise<boolean>;
  stats(): Promise<Stats>;
  reset(): Promise<void>;
};

async function pgStore(url: string): Promise<Store> {
  const db = new pg.Pool({ connectionString: url, max: 2 });
  await db.query(`
    create schema if not exists fake_provider;
    create table if not exists fake_provider.attempts (
      id bigserial primary key, idempotency_key text, body jsonb, outcome text, at timestamptz default now());
    create table if not exists fake_provider.effects (
      idempotency_key text primary key, body jsonb not null, committed_at timestamptz default now());
  `);
  return {
    attempt: async (key, body, outcome) => {
      await db.query(`insert into fake_provider.attempts (idempotency_key, body, outcome) values ($1, $2, $3)`, [key, body, outcome]);
    },
    commit: async (key, body) =>
      (await db.query(`insert into fake_provider.effects (idempotency_key, body) values ($1, $2) on conflict (idempotency_key) do nothing`, [key, body])).rowCount === 1,
    stats: async () => {
      const a = await db.query(`select count(*)::int n, count(*) filter (where outcome = 'committed')::int committed,
                                       count(*) filter (where outcome = 'deduplicated')::int deduped,
                                       count(*) filter (where outcome = 'injected_fault')::int faults from fake_provider.attempts`);
      const e = await db.query(`select count(*)::int n from fake_provider.effects`);
      return { attempts: a.rows[0].n, ...a.rows[0], uniqueEffects: e.rows[0].n };
    },
    reset: async () => {
      await db.query('truncate fake_provider.attempts, fake_provider.effects');
    },
  };
}

function memoryStore(): Store {
  let attempts: Outcome[] = [];
  let effects = new Set<string>();
  return {
    attempt: async (_key, _body, outcome) => void attempts.push(outcome),
    commit: async (key) => (effects.has(key) ? false : (effects.add(key), true)),
    stats: async () => {
      const count = (o: Outcome) => attempts.filter((x) => x === o).length;
      return { attempts: attempts.length, n: attempts.length, committed: count('committed'), deduped: count('deduplicated'), faults: count('injected_fault'), uniqueEffects: effects.size };
    },
    reset: async () => {
      attempts = [];
      effects = new Set();
    },
  };
}

const storeUrl = process.env.FAKE_PROVIDER_DATABASE_URL;
const store = storeUrl ? await pgStore(storeUrl) : memoryStore();
console.log(`[externals] store: ${storeUrl ? 'postgres' : 'memory'}`);

let faults = { failNext: 0, status: 503, delayMs: 0 };

const CONTACTS: Record<string, { name: string; email: string; company: string }> = {
  ada: { name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Engines Ltd' },
};

function mcpServer(): McpServer {
  const server = new McpServer({ name: 'spike-test-mcp', version: '0.1.0' });
  server.registerTool(
    'lookup_contact',
    { description: 'Look up a contact by short handle', inputSchema: { handle: z.string() } },
    async ({ handle }) => {
      const c = CONTACTS[handle.toLowerCase()];
      return { content: [{ type: 'text', text: c ? JSON.stringify(c) : `no contact "${handle}"` }], isError: !c };
    },
  );
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;

      if (path === '/mcp') {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const server = mcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (path === '/effects' && req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        const body = await readBody(req);
        if (typeof key !== 'string' || !key) {
          await store.attempt(null, body, 'rejected_no_key');
          return send(res, 400, { error: 'Idempotency-Key header required' });
        }
        if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
        if (faults.failNext > 0) {
          faults.failNext--;
          await store.attempt(key, body, 'injected_fault');
          return send(res, faults.status, { error: `injected fault (${faults.status})` });
        }
        const outcome: Outcome = (await store.commit(key, body)) ? 'committed' : 'deduplicated';
        await store.attempt(key, body, outcome);
        return send(res, 200, { effectId: key, outcome });
      }

      if (path === '/stats') {
        return send(res, 200, await store.stats());
      }

      if (path === '/faults' && req.method === 'POST') {
        faults = { ...faults, ...((await readBody(req)) as object) };
        return send(res, 200, faults);
      }

      if (path === '/reset' && req.method === 'POST') {
        await store.reset();
        faults = { failNext: 0, status: 503, delayMs: 0 };
        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[externals]', err);
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    }
  })
  .listen(PORT, () => console.log(`[externals] listening on :${PORT}`));
