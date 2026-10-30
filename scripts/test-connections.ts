// CONNECTIONS lifecycle test against the fake Google in src/externals.ts.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-connections.ts
import { randomBytes } from 'node:crypto';
import { EXTERNALS, freshDb, killAllWorkers, one, startWorker } from './lib.js';

const PORT = 7830;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

// Plays the browser: open the consent URL, follow Google's redirect to our callback.
async function consent(authUrl: string): Promise<{ status: number; body: string; callback: string }> {
  const g = await fetch(authUrl, { redirect: 'manual' });
  const callback = g.headers.get('location')!;
  const cb = await fetch(callback);
  return { status: cb.status, body: await cb.text(), callback };
}

const { url, db } = await freshDb('spike_conn');
const workerEnv = {
    CONNECTION_KEY: randomBytes(32).toString('base64'),
    GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
    GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
    GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
};
const w = await startWorker({ id: 'conn-1', port: PORT, dbUrl: url, env: workerEnv });

try {
  const start = await w.http('POST', '/connections/google', { id: 'google:primary' });
  check('start returns a Google consent URL', start.status === 200 && String(start.body.authUrl).startsWith(`${EXTERNALS}/google/auth?`), start);
  const params = new URL(start.body.authUrl).searchParams;
  check('consent asks for offline access + least-privilege calendar scopes',
    params.get('access_type') === 'offline' && params.get('prompt') === 'consent'
      && /calendar\.readonly/.test(params.get('scope')!) && /calendar\.app\.created/.test(params.get('scope')!)
      && !/auth\/calendar(\s|$)/.test(params.get('scope')!), params.get('scope'));

  const pendingRow = await one(db, `select status from ops.connections where id = 'google:primary'`);
  check('connection is pending before consent', pendingRow.status === 'pending', pendingRow);

  const cb = await consent(start.body.authUrl);
  check('callback completes and names the account', cb.status === 200 && cb.body.includes('rone@example.com'), cb);

  const conn = await one(db, `select status, account_label, scopes from ops.connections where id = 'google:primary'`);
  check('connection active with account + granted scopes', conn.status === 'active' && conn.account_label === 'rone@example.com' && conn.scopes.length === 3
    && conn.scopes.includes('https://www.googleapis.com/auth/gmail.modify'), conn); // calendar.readonly, calendar.app.created, gmail.modify

  const secret = await one(db, `select ciphertext, key_version from ops.connection_secrets where connection_id = 'google:primary'`);
  check('refresh token stored encrypted (no plaintext)', secret && !Buffer.from(secret.ciphertext).toString('utf8').includes('rt-'), { key_version: secret?.key_version });

  const replay = await fetch(cb.callback);
  check('replayed OAuth callback (same state) is rejected', replay.status === 400, replay.status);

  const forged = await fetch(`http://127.0.0.1:${PORT}/oauth/google/callback?code=x&state=forged`);
  check('forged state is rejected', forged.status === 400, forged.status);

  const auto = await one(db, `select metadata->>'agentOpsCalendarId' as cal from ops.connections where id = 'google:primary'`);
  check('Agent Ops calendar created automatically right after consent', Boolean(auto?.cal), auto);

  const health = await w.http('POST', '/connections/google:primary/check');
  check('health check refreshes the token', health.body.ok === true, health.body);

  const cal1 = await w.http('POST', '/connections/google:primary/agent-ops-calendar');
  const cal2 = await w.http('POST', '/connections/google:primary/agent-ops-calendar');
  const gstate = await (await fetch(`${EXTERNALS}/google/admin/state`)).json();
  check('Agent Ops calendar created once, reused after', cal1.body.created === false && cal2.body.created === false && cal1.body.calendarId === auto.cal
    && cal1.body.calendarId === cal2.body.calendarId && gstate.calendarsCreated === 1, { cal1: cal1.body, cal2: cal2.body, gstate });

  await fetch(`${EXTERNALS}/google/admin/revoke`, { method: 'POST' });
  const afterRevoke = await w.http('POST', '/connections/google:primary/check');
  const revoked = await one(db, `select status, last_error from ops.connections where id = 'google:primary'`);
  check('revoked refresh token → reauth_required', afterRevoke.body.ok === false && revoked.status === 'reauth_required' && /invalid_grant/.test(revoked.last_error), { afterRevoke: afterRevoke.body, revoked });

  const health2 = await w.http('GET', '/health');
  const item = health2.body.attention.find((a: { kind: string; ref: string }) => a.kind === 'connection_problem' && a.ref === 'google:primary');
  check('Attention Queue shows "Reauthorization needed"', item && /^Reauthorization needed/.test(item.detail), health2.body.attention);

  const again = await w.http('POST', '/connections/google', { id: 'google:primary' });
  const cb2 = await consent(again.body.authUrl);
  const healed = await one(db, `select status, last_error from ops.connections where id = 'google:primary'`);
  const health3 = await w.http('GET', '/health');
  check('re-auth heals the same connection and clears the attention item', cb2.status === 200 && healed.status === 'active' && healed.last_error === null
    && !health3.body.attention.some((a: { ref: string }) => a.ref === 'google:primary'), { healed, attention: health3.body.attention });

  const cal3 = await w.http('POST', '/connections/google:primary/agent-ops-calendar');
  check('Agent Ops calendar survives re-auth (no duplicate)', cal3.body.created === false && cal3.body.calendarId === cal1.body.calendarId, cal3.body);

  // Boot path: metadata lost, worker restarts → it adopts the existing calendar instead of creating a second one.
  await db.query(`update ops.connections set metadata = metadata - 'agentOpsCalendarId' where id = 'google:primary'`);
  const before = (await (await fetch(`${EXTERNALS}/google/admin/state`)).json()).calendarsCreated;
  await w.kill('SIGTERM');
  const w2 = await startWorker({ id: 'conn-2', port: PORT, dbUrl: url, env: workerEnv });
  let adopted: { cal?: string } | undefined;
  for (let i = 0; i < 50 && !adopted?.cal; i++) {
    adopted = await one(db, `select metadata->>'agentOpsCalendarId' as cal from ops.connections where id = 'google:primary'`);
    if (!adopted?.cal) await new Promise((r) => setTimeout(r, 200));
  }
  const after = (await (await fetch(`${EXTERNALS}/google/admin/state`)).json()).calendarsCreated;
  check('worker boot re-adopts the existing Agent Ops calendar (no duplicate)', adopted?.cal === cal1.body.calendarId && after === before, { adopted, before, after });

  const bad = await w2.http('POST', '/connections/google', { id: 'not-google' });
  check('connection ids are validated', bad.status === 400, bad);
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall connection checks passed');
process.exit(failures.length ? 1 : 0);
