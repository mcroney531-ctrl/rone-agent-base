// Who may call the API. Two kinds of caller:
//   machine  — `Authorization: Bearer <API_TOKEN>` (scripts, CI, curl)
//   owner    — a Supabase Auth session (magic link on the phone). Supabase proves the email;
//              we then allow exactly one email (OWNER_EMAIL). Anyone else with a valid session gets 403.
// Tokens are verified by asking Supabase Auth itself (GET /auth/v1/user), so this works with both
// legacy HS256 and asymmetric signing keys and never needs a JWT secret here.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const API_TOKEN = process.env.API_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL?.trim().toLowerCase();

export const mobileAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY && OWNER_EMAIL);
export function publicAuthConfig() {
  return { supabaseUrl: SUPABASE_URL ?? null, supabaseKey: SUPABASE_KEY ?? null };
}

export type Caller = { kind: 'machine' } | { kind: 'owner'; email: string };
export type AuthResult = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; error: string };

function isApiToken(header: string): boolean {
  if (!API_TOKEN) return false;
  const got = Buffer.from(header);
  const want = Buffer.from(`Bearer ${API_TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
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

export const callerLabel = (c: Caller) => (c.kind === 'owner' ? `owner:${c.email}` : 'api');
