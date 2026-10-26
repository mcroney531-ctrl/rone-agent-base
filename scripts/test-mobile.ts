// Mobile #1a: single-owner auth + the generic "Needs You" inbox API.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-mobile.ts
import { EXTERNALS, freshDb, killAllWorkers, one, startWorker } from './lib.js';

const PORT = 7850;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const { url, db } = await freshDb('spike_mobile');
const w = await startWorker({
  id: 'mobile-1', port: PORT, dbUrl: url,
  env: {
    API_TOKEN: 'api-secret', SUPABASE_URL: `${EXTERNALS}/supabase`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OWNER_EMAIL: 'owner@example.com',
    CONNECTION_KEY: Buffer.alloc(32, 7).toString('base64'), GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`, GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`,
  },
});
const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, body: parsed };
};
const OWNER = 'owner-session';
const enc = encodeURIComponent;

try {
  // ---- the shell is public, the data is not ----
  const shell = await call('GET', '/app');
  const cfg = await call('GET', '/app/config');
  check('app shell + public config served without auth (no secrets in config)', shell.status === 200 && /Needs You/.test(shell.body)
    && cfg.body.supabaseUrl === `${EXTERNALS}/supabase` && cfg.body.supabaseKey === 'sb_publishable_test' && Object.keys(cfg.body).length === 2, cfg.body);

  const noAuth = await call('GET', '/attention');
  const badSession = await call('GET', '/attention', 'expired-session');
  const otherUser = await call('GET', '/attention', 'other-session');
  const machine = await call('GET', '/attention', 'api-secret');
  const owner = await call('GET', '/attention', OWNER);
  check('no token → 401, invalid session → 401', noAuth.status === 401 && badSession.status === 401, [noAuth.status, badSession.status]);
  check('valid Supabase session for a different email → 403', otherUser.status === 403, otherUser);
  check('owner session (email matched case-insensitively) and API token → 200', owner.status === 200 && machine.status === 200, [owner.status, machine.status]);
  check('old routes are guarded the same way', (await call('GET', '/health')).status === 401 && (await call('GET', '/health', OWNER)).status === 200);

  // ---- seed one item of several producers ----
  const act = await one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
    values ('spike-agent', 'seed-wf', 'crm.note', 'ada@example.com', '{"note":"hello"}', 'low', 'seed:crm.note:1') returning id`);
  const failed = await one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key, status, error)
    values ('spike-agent', 'seed-wf', 'email.draft', 'ada@example.com', '{}', 'medium', 'seed:email.draft:1', 'failed', 'provider_unavailable: 503') returning id`);
  await db.query(`update ops.connections set status = 'reauth_required', last_error = 'invalid_grant: revoked', account_label = 'owner@example.com' where id = 'google:primary'`);
  const tomorrow = await one(db, `select ((now() at time zone 'America/New_York')::date + 1)::text as d`);
  const brief = await one(db, `insert into ops.briefs (agent_id, brief_date, timezone, time_min, time_max, connection_id, source_workflow_id, headline, items, considered)
    values ('calendar-prep', $1, 'America/New_York', now(), now() + interval '1 day', 'google:primary', 'seed-brief', '2 worth preparing for',
            '[{"eventId":"e1","title":"Acme review","localStart":"10:00 AM","why":"x","prep":[]},{"eventId":"e2","title":"Intro: Lee","localStart":"3:00 PM","why":"y","prep":[]}]', 4)
    returning id`, [tomorrow.d]);

  const list = (await call('GET', '/attention', OWNER)).body as any[];
  const byType = (t: string) => list.find((i) => i.type === t);
  const shapeOk = list.length >= 4 && list.every((i) => ['id', 'type', 'ref', 'source', 'title', 'summary', 'severity', 'createdAt', 'actions'].every((k) => k in i)
    && Array.isArray(i.actions));
  check('every item renders from one generic shape', shapeOk, list);
  check('decisions sort first: approval offers Approve/Reject', list[0]?.type === 'approval_needed'
    && JSON.stringify(byType('approval_needed').actions.map((a: any) => a.id)) === '["approve","reject"]', list.map((i) => i.type));
  check('Google reauth item says so and offers Reconnect', byType('connection_problem')?.source === 'Google'
    && /Reauthorization needed/.test(byType('connection_problem').summary) && byType('connection_problem').actions[0].id === 'reauth', byType('connection_problem'));
  check('brief item comes from Calendar Prep with View + Got it', byType('brief_ready')?.source === 'Calendar Prep'
    && byType('brief_ready').actions.map((a: any) => a.id).join() === 'open,dismiss', byType('brief_ready'));

  // ---- drill-in + actions ----
  const detail = await call('GET', `/attention/approval_needed/${act.id}`, OWNER);
  check('drill-in returns label/value facts', detail.status === 200 && detail.body.facts.some((f: any) => f.label === 'Action' && f.value === 'CRM note')
    && detail.body.facts.some((f: any) => f.label === 'Note' && f.value === 'hello'), detail.body);

  const dismissDecision = await call('POST', `/attention/approval_needed/${act.id}/dismiss`, OWNER, {});
  check('a decision cannot be dismissed away', dismissDecision.status === 400, dismissDecision);
  const approve = await call('POST', `/attention/approval_needed/${act.id}/approve`, OWNER, { requestId: 'tap-1' });
  const decided = await one(db, `select status, decided_by from ops.actions where id = $1`, [act.id]);
  check('approve from the phone records who decided', approve.status === 200 && ['approved', 'executed'].includes(decided.status)
    && decided.decided_by === 'owner:owner@example.com', { approve: approve.body, decided });
  const again = await call('POST', `/attention/approval_needed/${act.id}/approve`, OWNER, {});
  check('acting on a resolved item → 409 "no longer needs you"', again.status === 409 && /no longer/.test(again.body.message), again);

  const reauth = await call('POST', `/attention/connection_problem/${enc('google:primary')}/reauth`, OWNER, {});
  check('Reconnect returns a Google consent URL to open', reauth.status === 200 && /\/google\/auth\?/.test(reauth.body.redirect ?? ''), reauth.body);

  const gotIt = await call('POST', `/attention/action_failed/${failed.id}/dismiss`, OWNER, {});
  const afterAck = (await call('GET', '/attention', OWNER)).body as any[];
  check('"Got it" hides an informational item', gotIt.status === 200 && !afterAck.some((i) => i.ref === failed.id), afterAck);
  await db.query(`update ops.actions set updated_at = now() + interval '1 second' where id = $1`, [failed.id]);
  const reraised = (await call('GET', '/attention', OWNER)).body as any[];
  check('…until the problem is raised again', reraised.some((i) => i.ref === failed.id), reraised.map((i) => i.id));

  await call('POST', `/attention/brief_ready/${brief.id}/dismiss`, OWNER, {});
  const seen = await one(db, `select seen_at from ops.briefs where id = $1`, [brief.id]);
  check('dismissing the brief marks it seen', Boolean(seen.seen_at), seen);

  // ---- agents + Run Now ----
  const agents = (await call('GET', '/agents', OWNER)).body as any[];
  check('agents list for the phone', agents.some((a) => a.id === 'calendar-prep' && a.name === 'Calendar Prep' && a.timezone === 'America/New_York'), agents);
  const r1 = await call('POST', '/agents/spike-agent/run', OWNER, { requestId: 'tap-abc' });
  const r2 = await call('POST', '/agents/spike-agent/run', OWNER, { requestId: 'tap-abc' });
  check('Run Now: one tap = one run, however often it is retried', r1.status === 202 && r1.body.workflowID === 'manual-spike-agent-tap-abc' && r2.body.workflowID === r1.body.workflowID, [r1, r2]);
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall mobile checks passed');
process.exit(failures.length ? 1 : 0);
