// Who may call the API. Two kinds of caller:
//   machine  — `Authorization: Bearer <API_TOKEN>` (scripts, CI, curl)
//   owner    — a Supabase Auth session (magic link on the phone). Supabase proves the email;
//              we then allow exactly one email (OWNER_EMAIL). Anyone else with a valid session gets 403.
//   agent    — `Authorization: Bearer <CREDENTIALS_AGENT_TOKEN>`: the scoped identity Claude uses to maintain the
//              credential inventory. Default-deny: it may call only the routes in AGENT_ALLOWED; everything else 403.
//              The token is attached by the Claude environment's network-secret proxy, so Claude never holds it.
// Tokens are verified by asking Supabase Auth itself (GET /auth/v1/user), so this works with both
// legacy HS256 and asymmetric signing keys and never needs a JWT secret here.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const API_TOKEN = process.env.API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim().toLowerCase();

// A short or empty agent token is refused outright (fail closed): the identity simply doesn't exist.
const AGENT_TOKEN_MIN = 32;
const RAW_AGENT_TOKEN = process.env.CREDENTIALS_AGENT_TOKEN?.trim();
const AGENT_TOKEN = RAW_AGENT_TOKEN && RAW_AGENT_TOKEN.length >= AGENT_TOKEN_MIN ? RAW_AGENT_TOKEN : undefined;
if (RAW_AGENT_TOKEN && !AGENT_TOKEN) console.warn(`[auth] CREDENTIALS_AGENT_TOKEN ignored: shorter than ${AGENT_TOKEN_MIN} characters`);
export const AGENT_ID = 'claude-credentials';

export const mobileAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY && OWNER_EMAIL);
export function publicAuthConfig() {
  return { supabaseUrl: SUPABASE_URL ?? null, supabaseKey: SUPABASE_KEY ?? null };
}

export type Caller = { kind: 'machine' } | { kind: 'owner'; email: string } | { kind: 'agent'; id: typeof AGENT_ID };
export type AuthResult = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; error: string };

function bearerIs(header: string, token: string | undefined): boolean {
  if (!token) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
const isApiToken = (header: string) => bearerIs(header, API_TOKEN);

// The agent identity's explicit allowlist. Anything not listed is refused, including routes added later.
// Each entry is a method and an exact path shape; ':id' matches one segment that is not a reserved word.
const AGENT_ALLOWED: [string, string][] = [
  ['GET', 'credentials/whoami'],
  ['GET', 'credentials'],
  ['POST', 'credentials'],
  ['GET', 'credentials/:id'],
  ['PATCH', 'credentials/:id'],
  ['GET', 'credentials/:id/events'],
  ['POST', 'credentials/:id/consumers'],
  ['POST', 'credentials/:id/checks'],
  // Deliberately absent: DELETE credentials/:id (retire), DELETE credentials/:id/consumers/:id, every
  // other route (Needs You actions, agents, devices, connections...). src/credentials.ts refuses retire and
  // consumer removal for the agent as well.
];
const RESERVED = new Set(['whoami', 'events', 'consumers', 'checks']);
export function agentAllowed(method: string | undefined, parts: string[]): boolean {
  return AGENT_ALLOWED.some(([m, shape]) => {
    if (m !== method) return false;
    const want = shape.split('/');
    return want.length === parts.length && want.every((w, i) => (w === ':id' ? parts[i] !== '' && !RESERVED.has(parts[i]!) : w === parts[i]));
  });
}

// Short cache so a screen that makes five calls costs one Supabase round trip. Sessions revoked in
// Supabase stop working here within CACHE_MS.
const CACHE_MS = 60_000;
const cache = new Map<string, { email: string | null; until: number }>();

async function supabaseEmail(token: string): Promise<string | null> {
  const hit = cache.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY!, authorization: `Bearer ${token}` } });
  const email = res.ok ? (((await res.json()) as { email?: string }).email ?? null) : null;
  if (res.ok || res.status === 401 || res.status === 403) {
    if (cache.size > 500) cache.clear();
    cache.set(token, { email: email?.toLowerCase() ?? null, until: Date.now() + CACHE_MS });
  } else {
    throw new Error(`Supabase Auth unavailable (${res.status})`);
  }
  return email?.toLowerCase() ?? null;
}

export async function authenticate(req: http.IncomingMessage): Promise<AuthResult> {
  const header = req.headers.authorization ?? '';
  // Checked first, so the agent token is never forwarded to Supabase as if it were a session.
  if (bearerIs(header, AGENT_TOKEN)) return { ok: true, caller: { kind: 'agent', id: AGENT_ID } };
  // Local dev with no API_TOKEN and no mobile auth: open, as before.
  if (!API_TOKEN && !mobileAuthConfigured) return { ok: true, caller: { kind: 'machine' } };
  if (isApiToken(header)) return { ok: true, caller: { kind: 'machine' } };
  const token = /^Bearer (.+)$/.exec(header)?.[1];
  if (!token || !mobileAuthConfigured) return { ok: false, status: 401, error: 'unauthorized' };
  const email = await supabaseEmail(token);
  if (!email) return { ok: false, status: 401, error: 'session invalid or expired' };
  if (email !== OWNER_EMAIL) return { ok: false, status: 403, error: 'this account is not authorized' };
  return { ok: true, caller: { kind: 'owner', email } };
}

export const callerLabel = (c: Caller) => (c.kind === 'owner' ? `owner:${c.email}` : c.kind === 'agent' ? `agent:${c.id}` : 'api');
