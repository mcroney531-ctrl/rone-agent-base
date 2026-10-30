// Google as the first CONNECTIONS provider. OAuth as the account owner (not a service account), offline
// access for a refresh token, least-privilege scopes:
//   calendar.readonly     read the real calendar (source of truth for the schedule; never written)
//   calendar.app.created  create the Agent Ops calendar and manage events ONLY on calendars this app made
//   gmail.modify          Inbox Triage: read mail, add Agent Ops/* labels, create drafts. Google lets this scope
//                         send mail too; "never send" is enforced at the capability boundary instead
//                         (src/connections/gmail.ts exposes no send/delete/trash/archive method at all).
// Endpoints are env-overridable so the whole lifecycle runs against a fake Google in CI.
import { OpsError } from '../errors.js';
import {
  consumeOAuthState, ensurePending, getConnection, listConnections, loadSecret, markActive, markChecked, markReauthRequired,
  mergeMetadata, newOAuthState, saveSecret,
} from './store.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/gmail.modify',
];

const cfg = () => ({
  clientId: required('GOOGLE_CLIENT_ID'),
  clientSecret: required('GOOGLE_CLIENT_SECRET'),
  redirectUri: required('GOOGLE_REDIRECT_URI'),
  authUrl: process.env.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  userinfoUrl: process.env.GOOGLE_USERINFO_URL ?? 'https://openidconnect.googleapis.com/v1/userinfo',
  calendarBase: process.env.GOOGLE_CALENDAR_BASE ?? 'https://www.googleapis.com/calendar/v3',
});

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new OpsError('validation', `${name} is not set`);
  return v;
}

export async function startGoogleAuth(connectionId: string): Promise<string> {
  const c = cfg();
  await ensurePending(connectionId, 'google');
  const state = await newOAuthState(connectionId);
  const u = new URL(c.authUrl);
  u.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // always re-issue a refresh token, including on re-auth
    include_granted_scopes: 'true',
    state,
  }).toString();
  return u.toString();
}

async function tokenRequest(body: Record<string, string>) {
  const c = cfg();
  const res = await fetch(c.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  return { ok: res.ok, status: res.status, json };
}

export async function completeGoogleAuth(code: string, state: string): Promise<{ connectionId: string; account: string }> {
  const connectionId = await consumeOAuthState(state);
  if (!connectionId) throw new OpsError('validation', 'unknown, expired or already-used OAuth state');
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: cfg().redirectUri });
  if (!t.ok) throw new OpsError('provider_unavailable', `token exchange failed (${t.status}): ${t.json.error ?? 'unknown'}`);
  if (!t.json.refresh_token) throw new OpsError('validation', 'Google returned no refresh token; consent must include offline access');

  const granted = (t.json.scope ?? '').split(' ').filter(Boolean);
  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !granted.includes(s));
  if (missing.length) throw new OpsError('validation', `consent did not grant: ${missing.join(', ')}`);

  const who = await fetch(cfg().userinfoUrl, { headers: { authorization: `Bearer ${t.json.access_token}` } });
  const account = who.ok ? ((await who.json()) as { email?: string }).email ?? 'unknown' : 'unknown';

  await saveSecret(connectionId, t.json.refresh_token);
  cacheToken(connectionId, t.json.access_token, Number(t.json.expires_in ?? 3600));
  await markActive(connectionId, { accountLabel: account, scopes: granted });
  return { connectionId, account };
}

// Access tokens live ~1h and are cheap to mint, so they stay in memory; only the refresh token is stored.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
function cacheToken(id: string, token: string, expiresInS: number) {
  tokenCache.set(id, { token, expiresAt: Date.now() + (expiresInS - 60) * 1000 });
}

export async function googleAccessToken(connectionId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const cached = tokenCache.get(connectionId);
  if (cached && !opts.forceRefresh && cached.expiresAt > Date.now()) return cached.token;

  const conn = await getConnection(connectionId);
  if (!conn) throw new OpsError('connection_unavailable', `no connection ${connectionId}`);
  if (conn.status !== 'active') throw new OpsError('connection_unavailable', `connection ${connectionId} is ${conn.status}`);
  const refresh = await loadSecret(connectionId);
  if (!refresh) {
    await markReauthRequired(connectionId, 'no stored refresh token');
    throw new OpsError('connection_unavailable', `connection ${connectionId} has no credential`);
  }

  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  if (t.ok) {
    cacheToken(connectionId, t.json.access_token, Number(t.json.expires_in ?? 3600));
    await markChecked(connectionId);
    return t.json.access_token;
  }
  // invalid_grant: revoked, expired (Testing-mode 7-day expiry), or password change. Needs a human.
  if (t.json.error === 'invalid_grant' || t.json.error === 'unauthorized_client') {
    tokenCache.delete(connectionId);
    await markReauthRequired(connectionId, `${t.json.error}: ${t.json.error_description ?? 'refresh token rejected'}`);
    throw new OpsError('connection_unavailable', `connection ${connectionId} needs re-authorization`);
  }
  await markChecked(connectionId, `token refresh ${t.status}: ${t.json.error ?? 'unknown'}`);
  throw new OpsError('provider_unavailable', `Google token refresh failed (${t.status})`);
}

export async function checkGoogleConnection(connectionId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await googleAccessToken(connectionId, { forceRefresh: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export class CalendarApiError extends OpsError {
  constructor(errorClass: OpsError['errorClass'], public readonly status: number, message: string) {
    super(errorClass, message);
  }
}
const isStatus = (e: unknown, ...codes: number[]) => e instanceof CalendarApiError && codes.includes(e.status);

export async function calendarFetch<T>(connectionId: string, path: string, init: RequestInit = {}): Promise<T> {
  const call = async (token: string) =>
    fetch(`${cfg().calendarBase}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  let res = await call(await googleAccessToken(connectionId));
  if (res.status === 401) res = await call(await googleAccessToken(connectionId, { forceRefresh: true }));
  if (!res.ok) {
    const cls = res.status === 401 || res.status === 403 ? 'provider_auth' : res.status === 429 || res.status >= 500 ? 'provider_unavailable' : 'validation';
    throw new CalendarApiError(cls, res.status, `Calendar API ${init.method ?? 'GET'} ${path} → ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const AGENT_OPS_SUMMARY = 'Agent Ops';

// Idempotent: reuses the stored calendar while it still exists, otherwise creates exactly one.
export async function ensureAgentOpsCalendar(connectionId: string): Promise<{ calendarId: string; created: boolean }> {
  const conn = await getConnection(connectionId);
  const known = conn?.metadata?.agentOpsCalendarId as string | undefined;
  if (known) {
    try {
      await calendarFetch(connectionId, `/calendars/${encodeURIComponent(known)}`);
      return { calendarId: known, created: false };
    } catch (e) {
      if (!isStatus(e, 404)) throw e;
    }
  }
  // Adopt an existing Agent Ops calendar we own before creating one, so lost metadata never duplicates it.
  const list = await calendarFetch<{ items?: { id: string; summary?: string; accessRole?: string }[] }>(connectionId, '/users/me/calendarList?minAccessRole=owner');
  const existing = (list.items ?? []).find((c) => c.summary === AGENT_OPS_SUMMARY && c.accessRole === 'owner');
  if (existing) {
    await mergeMetadata(connectionId, { agentOpsCalendarId: existing.id });
    return { calendarId: existing.id, created: false };
  }
  const cal = await calendarFetch<{ id: string }>(connectionId, '/calendars', {
    method: 'POST',
    body: JSON.stringify({
      summary: AGENT_OPS_SUMMARY,
      description: 'Commands, status and reminders written by agents. Your primary calendar stays read-only to them.',
    }),
  });
  await mergeMetadata(connectionId, { agentOpsCalendarId: cal.id });
  return { calendarId: cal.id, created: true };
}

export type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string };
  attendees?: { email: string; responseStatus?: string; self?: boolean; organizer?: boolean; resource?: boolean }[];
  organizer?: { email?: string; self?: boolean };
  recurringEventId?: string;
  eventType?: string;                 // default | focusTime | outOfOffice | workingLocation | birthday | fromGmail
  attachments?: { fileUrl?: string; title?: string }[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  transparency?: string;              // 'transparent' = shows as free
  htmlLink?: string;
  status?: string;
};

export async function getEvent(connectionId: string, calendarId: string, eventId: string): Promise<CalendarEvent> {
  return calendarFetch<CalendarEvent>(connectionId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
}

// Writes go only to calendars this app created (calendar.app.created). Event IDs are chosen by us and
// deterministic, so the ID itself is the provider-side idempotency key: a retried write can't duplicate.
type EventBody = Omit<CalendarEvent, 'id'>;
const eventPath = (calendarId: string, eventId?: string) =>
  `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

// Create-or-replace (the brief mirror). PUT also revives an event the user deleted (Google keeps the ID).
export async function upsertEvent(connectionId: string, calendarId: string, eventId: string, body: EventBody): Promise<{ id: string; created: boolean }> {
  const full = { ...body, status: 'confirmed' };
  try {
    await calendarFetch(connectionId, eventPath(calendarId, eventId), { method: 'PUT', body: JSON.stringify(full) });
    return { id: eventId, created: false };
  } catch (e) {
    if (!isStatus(e, 404)) throw e;
  }
  try {
    await calendarFetch(connectionId, eventPath(calendarId), { method: 'POST', body: JSON.stringify({ ...full, id: eventId }) });
    return { id: eventId, created: true };
  } catch (e) {
    if (!isStatus(e, 409)) throw e; // lost a race with a concurrent insert: replace it instead
    await calendarFetch(connectionId, eventPath(calendarId, eventId), { method: 'PUT', body: JSON.stringify(full) });
    return { id: eventId, created: false };
  }
}

// Create once (holds). A second attempt with the same ID returns the existing event untouched.
export async function insertEventOnce(connectionId: string, calendarId: string, eventId: string, body: EventBody): Promise<{ id: string; created: boolean; htmlLink?: string }> {
  try {
    const ev = await calendarFetch<CalendarEvent>(connectionId, eventPath(calendarId), { method: 'POST', body: JSON.stringify({ ...body, id: eventId }) });
    return { id: eventId, created: true, htmlLink: ev?.htmlLink };
  } catch (e) {
    if (!isStatus(e, 409)) throw e;
    const ev = await getEvent(connectionId, calendarId, eventId);
    return { id: eventId, created: false, htmlLink: ev.htmlLink };
  }
}

export async function deleteEvent(connectionId: string, calendarId: string, eventId: string): Promise<void> {
  try {
    await calendarFetch(connectionId, eventPath(calendarId, eventId), { method: 'DELETE' });
  } catch (e) {
    if (!isStatus(e, 404, 410)) throw e; // already gone
  }
}

export async function listEvents(connectionId: string, calendarId: string, timeMin: string, timeMax: string, timeZone?: string): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', ...(timeZone ? { timeZone } : {}) });
  const r = await calendarFetch<{ items?: CalendarEvent[] }>(connectionId, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
  return (r.items ?? []).filter((e) => e.status !== 'cancelled');
}

// Every active Google connection gets its Agent Ops calendar without a manual step: called right after
// consent and at worker boot. Best-effort: a failure is logged and recorded, never blocks the caller.
export async function ensureAgentOpsCalendars(connectionIds?: string[]): Promise<void> {
  const ids = connectionIds ?? (await listConnections())
    .filter((c) => c.provider === 'google' && c.status === 'active' && !c.metadata?.agentOpsCalendarId)
    .map((c) => c.id);
  for (const id of ids) {
    try {
      const { calendarId, created } = await ensureAgentOpsCalendar(id);
      console.log(`[connections] ${id}: Agent Ops calendar ${created ? 'created' : 'present'} (${calendarId})`);
    } catch (e) {
      console.error(`[connections] ${id}: could not ensure Agent Ops calendar: ${(e as Error).message}`);
      await markChecked(id, `agent ops calendar: ${(e as Error).message}`);
    }
  }
}
