// Stand-ins for the outside world, run as a separate process so killing the worker never kills them.
//   POST /effects  fake provider that honors Idempotency-Key and logs EVERY attempt
//   POST /mcp      stateless streamable-HTTP MCP server with one tool (lookup_contact)
//   GET  /stats    attempts vs unique committed effects (what the crash-window test measures)
//   POST /faults   inject provider failures: {"failNext": 3, "status": 503}
import http from 'node:http';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = Number(process.env.EXTERNALS_PORT ?? process.env.PORT ?? 7801);
const db = new pg.Pool({ connectionString: process.env.FAKE_PROVIDER_DATABASE_URL ?? process.env.DATABASE_URL });

await db.query(`
  create schema if not exists fake_provider;
  create table if not exists fake_provider.attempts (
    id bigserial primary key, idempotency_key text, body jsonb, outcome text, at timestamptz default now());
  create table if not exists fake_provider.effects (
    idempotency_key text primary key, body jsonb not null, committed_at timestamptz default now());
`);

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
          await db.query(`insert into fake_provider.attempts (idempotency_key, body, outcome) values (null, $1, 'rejected_no_key')`, [body]);
          return send(res, 400, { error: 'Idempotency-Key header required' });
        }
        if (faults.delayMs) await new Promise((r) => setTimeout(r, faults.delayMs));
        if (faults.failNext > 0) {
          faults.failNext--;
          await db.query(`insert into fake_provider.attempts (idempotency_key, body, outcome) values ($1, $2, 'injected_fault')`, [key, body]);
          return send(res, faults.status, { error: `injected fault (${faults.status})` });
        }
        const ins = await db.query(
          `insert into fake_provider.effects (idempotency_key, body) values ($1, $2)
           on conflict (idempotency_key) do nothing returning committed_at`,
          [key, body],
        );
        const outcome = ins.rowCount === 1 ? 'committed' : 'deduplicated';
        await db.query(`insert into fake_provider.attempts (idempotency_key, body, outcome) values ($1, $2, $3)`, [key, body, outcome]);
        return send(res, 200, { effectId: key, outcome });
      }

      if (path === '/stats') {
        const a = await db.query(`select count(*)::int n, count(*) filter (where outcome = 'committed')::int committed,
                                         count(*) filter (where outcome = 'deduplicated')::int deduped,
                                         count(*) filter (where outcome = 'injected_fault')::int faults from fake_provider.attempts`);
        const e = await db.query(`select count(*)::int n from fake_provider.effects`);
        return send(res, 200, { attempts: a.rows[0].n, ...a.rows[0], uniqueEffects: e.rows[0].n });
      }

      if (path === '/faults' && req.method === 'POST') {
        faults = { ...faults, ...((await readBody(req)) as object) };
        return send(res, 200, faults);
      }

      if (path === '/reset' && req.method === 'POST') {
        await db.query('truncate fake_provider.attempts, fake_provider.effects');
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
