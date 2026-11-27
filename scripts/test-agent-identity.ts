// Managed inventory writes, step 1: the scoped `claude-credentials` identity and its default-deny allowlist.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-agent-identity.ts
import { EXTERNALS, freshDb, killAllWorkers, one, startWorker } from './lib.js';

const PORT = 7860;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const AGENT = 'agent-token-0123456789abcdefghijklmnopqrstuvwxyz';
const ROTATED = 'rotated-token-0123456789abcdefghijklmnopqrstuvw';
const OWNER = 'owner-session';
const baseEnv = {
  API_TOKEN: 'api-secret', SUPABASE_URL: `${EXTERNALS}/supabase`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OWNER_EMAIL: 'owner@example.com',
  CONNECTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const { url, db } = await freshDb('spike_agent_identity');
const boot = (agentToken: string | undefined, id: string) =>
  startWorker({ id, port: PORT, dbUrl: url, env: { ...baseEnv, ...(agentToken === undefined ? {} : { CREDENTIALS_AGENT_TOKEN: agentToken }) } });
const call = async (method: string, path: string, auth?: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: parsed };
};
const bearer = (t: string) => `Bearer ${t}`;
const enc = encodeURIComponent;

const seenSoFar = async () => (await (await fetch(`${EXTERNALS}/supabase/admin/seen`)).json()) as string[];
const seenBefore = (await seenSoFar()).length; // externals outlive this script; only look at what this run caused

try {
  let w = await boot(AGENT, 'agent-id-1');

  // ---- whoami: which identity a request arrived as ----
  const asAgent = await call('GET', '/credentials/whoami', bearer(AGENT));
  const asOwner = await call('GET', '/credentials/whoami', bearer(OWNER));
  const asMachine = await call('GET', '/credentials/whoami', bearer('api-secret'));
  const asNobody = await call('GET', '/credentials/whoami');
  check('whoami: agent token → claude-credentials', asAgent.status === 200 && asAgent.body.identity === 'claude-credentials', asAgent);
  check('whoami: owner → owner, API token → machine, none → 401', asOwner.body.identity === 'owner' && asMachine.body.identity === 'machine' && asNobody.status === 401,
    [asOwner, asMachine, asNobody.status]);
  check('whoami never echoes the token', !JSON.stringify(asAgent.body).includes(AGENT), asAgent.body);

  // ---- near misses are not the agent ----
  const nearMisses = [bearer(AGENT + 'x'), bearer(AGENT.slice(0, -1)), `bearer ${AGENT}`, AGENT, bearer(` ${AGENT}`)];
  const missResults = await Promise.all(nearMisses.map((h) => call('GET', '/credentials/whoami', h)));
  check('near-miss tokens (extra/missing char, wrong case scheme, no scheme, padding) are never the agent',
    missResults.every((r) => r.body?.identity !== 'claude-credentials' && r.status !== 200), missResults.map((r) => r.status));

  // ---- default deny: everything not on the allowlist ----
  const seeded = await one(db, `insert into ops.connections (id, provider, status, managed_by, kind, display_name, expires_at)
    values ('cred:seed', 'manual', 'active', 'manual', 'api_key', 'Seed key', now() + interval '60 days') returning id`);
  const id = enc(seeded.id);
  const denied: [string, string, unknown?][] = [
    ['GET', '/credentials'],
    ['POST', '/credentials', { display_name: 'Sneaky', kind: 'api_key', expires_at: '2030-01-01' }],
    ['GET', `/credentials/${id}`],
    ['PATCH', `/credentials/${id}`, { expires_at: null }],
    ['PATCH', `/credentials/${id}`, { notes: 'x', removed_at: '2026-01-01T00:00:00Z' }],
    ['DELETE', `/credentials/${id}`],
    ['POST', `/credentials/${id}/consumers`, { consumer: 'x', confidence: 'confirmed' }],
    ['POST', `/credentials/${id}/checks`, { scope: 'x', result: 'y' }],
    ['GET', '/attention'],
    ['POST', `/attention/credential_expiry/${id}/not_needed`, {}],
    ['GET', '/health'],
    ['GET', '/connections'],
    ['POST', '/agents/spike-agent/run', { requestId: 'agent-should-not' }],
    ['GET', '/devices'],
    ['GET', '/credentials/whoami/extra'],
    ['POST', '/credentials/whoami'],
  ];
  const deniedResults = await Promise.all(denied.map(([m, p, b]) => call(m, p, bearer(AGENT), b)));
  check('agent identity is refused (403) on every route outside the allowlist', deniedResults.every((r) => r.status === 403),
    denied.map(([m, p], i) => `${m} ${p} → ${deniedResults[i]!.status}`).filter((_, i) => deniedResults[i]!.status !== 403));
  const after = await one(db, `select count(*)::int n, bool_and(removed_at is null) live, bool_and(expires_at is not null) dated, coalesce(max(notes), '') notes
    from ops.connections where managed_by = 'manual'`);
  const runs = await one(db, `select count(*)::int n from ops.runs where workflow_id like '%agent-should-not%'`);
  check('refused calls changed nothing (no new row, not retired, deadline kept, no run started)',
    after.n === 1 && after.live && after.dated && after.notes === '' && runs.n === 0, { after, runs });

  // The same routes still work for the owner, so the 403s are about identity, not broken routes.
  check('owner can still list credentials (control)', (await call('GET', '/credentials', bearer(OWNER))).status === 200);

  // ---- the agent token never leaves for Supabase ----
  // (Once revoked, below, the old token is just an unknown bearer and is checked against Supabase like any other.)
  const seen = (await seenSoFar()).slice(seenBefore);
  check('a live agent token is never sent to Supabase Auth', !seen.includes(AGENT), seen.filter((t) => t.startsWith('agent')));

  // ---- revocation: unset, too short, rotated ----
  await w.kill();
  w = await boot(undefined, 'agent-id-2');
  const unset = await call('GET', '/credentials/whoami', bearer(AGENT));
  check('revoked (variable removed): old agent token → 401', unset.status === 401, unset);
  await w.kill();

  w = await boot('too-short-token', 'agent-id-3');
  const short = await call('GET', '/credentials/whoami', bearer('too-short-token'));
  check('a token under 32 characters is ignored (fails closed → 401)', short.status === 401, short);
  await w.kill();

  w = await boot(ROTATED, 'agent-id-4');
  const oldTok = await call('GET', '/credentials/whoami', bearer(AGENT));
  const newTok = await call('GET', '/credentials/whoami', bearer(ROTATED));
  check('rotated: old token → 401, new token → claude-credentials', oldTok.status === 401 && newTok.body.identity === 'claude-credentials', [oldTok.status, newTok.body]);
  await w.kill();
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
process.exit(failures.length ? 1 : 0);
