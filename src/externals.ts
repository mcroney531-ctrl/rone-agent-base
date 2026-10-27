// Stand-ins for the outside world, run as a separate process so killing the worker never kills them.
//   POST /effects  fake provider that honors Idempotency-Key and logs EVERY attempt
//   POST /mcp      stateless streamable-HTTP MCP server with one tool (lookup_contact)
//   GET  /stats    attempts vs unique committed effects (what the crash-window test measures)
//   POST /faults   inject provider failures: {"failNext": 3, "status": 503}
//   /google/*      fake Google OAuth + Calendar (consent, token, userinfo, calendars, events, revoke)
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

// ---------- fake Google: enough of OAuth + Calendar to exercise the CONNECTIONS lifecycle in CI ----------
import { randomUUID } from 'node:crypto';
const G = {
  codes: new Map<string, { refresh: string; scope: string }>(),
  refresh: new Map<string, { revoked: boolean; scope: string }>(),
  access: new Set<string>(),
  calendars: new Map<string, { id: string; summary: string }>(),
  events: [] as Record<string, unknown>[],                                   // the user's primary calendar (read-only to us)
  appEvents: new Map<string, Map<string, Record<string, unknown>>>(),       // events on app-created calendars
  stats: { authCodes: 0, refreshes: 0, calendarsCreated: 0, eventsInserted: 0, eventsUpdated: 0, eventsDeleted: 0, primaryWrites: 0 },
};
const freshStats = () => ({ authCodes: 0, refreshes: 0, calendarsCreated: 0, eventsInserted: 0, eventsUpdated: 0, eventsDeleted: 0, primaryWrites: 0 });

// Overlap test like Google's timeMin/timeMax (all-day events compare by date at UTC midnight: close enough here).
function inWindow(e: Record<string, any>, timeMin?: string | null, timeMax?: string | null) {
  const start = Date.parse(e.start?.dateTime ?? e.start?.date);
  const end = Date.parse(e.end?.dateTime ?? e.end?.date);
  return (!timeMax || start < Date.parse(timeMax)) && (!timeMin || end > Date.parse(timeMin));
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

async function fakeGoogle(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<boolean> {
  const p = u.pathname;
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const authed = G.access.has(bearer);

  if (p === '/google/auth') {
    // Simulates the user approving consent: bounce straight back to redirect_uri with a code.
    const code = randomUUID();
    const scope = (u.searchParams.get('scope') ?? '').split(' ').filter((s) => s.startsWith('https://')).join(' ');
    G.codes.set(code, { refresh: `rt-${randomUUID()}`, scope });
    G.stats.authCodes++;
    const back = new URL(u.searchParams.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', u.searchParams.get('state') ?? '');
    res.writeHead(302, { location: back.toString() }).end();
    return true;
  }
  if (p === '/google/token' && req.method === 'POST') {
    const f = await readForm(req);
    const issue = (refresh: string, scope: string, includeRefresh: boolean) => {
      const access = `at-${randomUUID()}`;
      G.access.add(access);
      send(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer', scope, ...(includeRefresh ? { refresh_token: refresh } : {}) });
    };
    if (f.get('grant_type') === 'authorization_code') {
      const c = G.codes.get(f.get('code') ?? '');
      if (!c) return send(res, 400, { error: 'invalid_grant', error_description: 'bad code' }), true;
      G.codes.delete(f.get('code')!);
      G.refresh.set(c.refresh, { revoked: false, scope: c.scope });
      return issue(c.refresh, c.scope, true), true;
    }
    if (f.get('grant_type') === 'refresh_token') {
      G.stats.refreshes++;
      const r = G.refresh.get(f.get('refresh_token') ?? '');
      if (!r || r.revoked) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), true;
      return issue(f.get('refresh_token')!, r.scope, false), true;
    }
    return send(res, 400, { error: 'unsupported_grant_type' }), true;
  }
  if (p === '/google/admin/revoke' && req.method === 'POST') {
    for (const r of G.refresh.values()) r.revoked = true;
    G.access.clear();
    return send(res, 200, { revoked: G.refresh.size }), true;
  }
  if (p === '/google/admin/state') {
    const appEvents = Object.fromEntries([...G.appEvents].map(([cal, evs]) => [cal, [...evs.values()]]));
    return send(res, 200, { ...G.stats, calendars: [...G.calendars.values()], appEvents }), true;
  }
  if (p === '/google/admin/reset' && req.method === 'POST') {
    G.calendars.clear(); G.appEvents.clear(); G.events = []; G.stats = freshStats();
    return send(res, 200, { ok: true }), true;
  }
  if (p === '/google/admin/events' && req.method === 'POST') {
    G.events = ((await readBody(req)) as Record<string, unknown>[]) ?? [];
    return send(res, 200, { events: G.events.length }), true;
  }
  if (!p.startsWith('/google/userinfo') && !p.startsWith('/google/calendar/')) return false;
  if (!authed) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } }), true;
  if (p === '/google/userinfo') return send(res, 200, { email: 'rone@example.com', email_verified: true }), true;

  if (p === '/google/calendar/v3/users/me/calendarList') {
    return send(res, 200, { items: [...G.calendars.values()].map((c) => ({ ...c, accessRole: 'owner' })) }), true;
  }
  const m = /^\/google\/calendar\/v3\/calendars(?:\/([^/]+))?(\/events)?(?:\/([^/]+))?$/.exec(p);
  if (!m) return send(res, 404, { error: { code: 404 } }), true;
  const calId = m[1] ? decodeURIComponent(m[1]) : undefined;
  const eventId = m[3] ? decodeURIComponent(m[3]) : undefined;
  if (!calId && req.method === 'POST') {
    const body = (await readBody(req)) as { summary: string };
    const cal = { id: `${randomUUID()}@group.calendar.google.com`, summary: body.summary };
    G.calendars.set(cal.id, cal);
    G.appEvents.set(cal.id, new Map());
    G.stats.calendarsCreated++;
    return send(res, 200, cal), true;
  }
  if (calId && !m[2]) {
    const cal = G.calendars.get(calId);
    return send(res, cal ? 200 : 404, cal ?? { error: { code: 404 } }), true;
  }
  if (!calId) return send(res, 404, { error: { code: 404 } }), true;

  if (calId === 'primary') {
    // calendar.readonly: any write to the primary calendar is a scope violation.
    if (req.method !== 'GET') return G.stats.primaryWrites++, send(res, 403, { error: { code: 403, message: 'Insufficient Permission' } }), true;
    if (eventId) {
      const ev = G.events.find((e) => e.id === eventId);
      return send(res, ev ? 200 : 404, ev ?? { error: { code: 404 } }), true;
    }
    return send(res, 200, { items: G.events.filter((e) => inWindow(e, u.searchParams.get('timeMin'), u.searchParams.get('timeMax'))) }), true;
  }

  const evs = G.appEvents.get(calId);
  if (!evs) return send(res, 404, { error: { code: 404 } }), true;
  if (!eventId && req.method === 'GET') {
    const items = [...evs.values()].filter((e) => e.status !== 'cancelled' && inWindow(e, u.searchParams.get('timeMin'), u.searchParams.get('timeMax')));
    return send(res, 200, { items }), true;
  }
  if (!eventId && req.method === 'POST') {
    const body = (await readBody(req)) as Record<string, unknown>;
    const id = String(body.id ?? randomUUID().replace(/-/g, ''));
    if (!/^[a-v0-9]{5,1024}$/.test(id)) return send(res, 400, { error: { code: 400, message: 'Invalid resource id value.' } }), true;
    if (evs.has(id)) return send(res, 409, { error: { code: 409, message: 'The requested identifier already exists.' } }), true;
    const ev = { ...body, id, status: body.status ?? 'confirmed', htmlLink: `https://calendar.example/event?eid=${id}` };
    evs.set(id, ev);
    G.stats.eventsInserted++;
    return send(res, 200, ev), true;
  }
  const cur = eventId ? evs.get(eventId) : undefined;
  if (req.method === 'GET') return send(res, cur ? 200 : 404, cur ?? { error: { code: 404 } }), true;
  if (req.method === 'PUT') {
    if (!cur) return send(res, 404, { error: { code: 404 } }), true;
    const ev = { ...(await readBody(req) as Record<string, unknown>), id: eventId, htmlLink: cur.htmlLink };
    evs.set(eventId!, ev);
    G.stats.eventsUpdated++;
    return send(res, 200, ev), true;
  }
  if (req.method === 'DELETE') {
    if (!cur) return send(res, 404, { error: { code: 404 } }), true;
    if (cur.status === 'cancelled') return send(res, 410, { error: { code: 410, message: 'Resource has been deleted' } }), true;
    cur.status = 'cancelled'; // Google keeps the ID; a later PUT revives it
    G.stats.eventsDeleted++;
    return res.writeHead(204).end(), true;
  }
  return send(res, 404, { error: { code: 404 } }), true;
}

const PUSHES: { id: string; headers: Record<string, string>; body: string }[] = [];

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
      const reqUrl = new URL(req.url ?? '/', 'http://x');
      const path = reqUrl.pathname;
      if (path.startsWith('/google/') && (await fakeGoogle(req, res, reqUrl))) return;
      // Fake push service: records encrypted Web Push deliveries; endpoint id 'gone' answers 410.
      if (path.startsWith('/push/')) {
        if (path === '/push/admin/received') return send(res, 200, PUSHES);
        if (path === '/push/admin/reset' && req.method === 'POST') { PUSHES.length = 0; return send(res, 200, { ok: true }); }
        const id = path.split('/')[3]; // /push/recv/<id>
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        if (id === 'gone') return send(res, 410, { error: 'subscription expired' });
        PUSHES.push({ id, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString('base64') });
        return res.writeHead(201).end();
      }
      // Fake Supabase Auth: just enough of GET /auth/v1/user to test the owner guard.
      if (path === '/supabase/auth/v1/user') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!req.headers.apikey) return send(res, 401, { message: 'No API key found in request' });
        const users: Record<string, string> = { 'owner-session': 'Owner@Example.com', 'other-session': 'someone@else.com' };
        return users[token] ? send(res, 200, { id: token, email: users[token] }) : send(res, 403, { code: 403, msg: 'invalid JWT' });
      }

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
