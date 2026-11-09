// Gmail push ingress end to end, against the fake Gmail + fake Pub/Sub (real RS256 OIDC tokens) + scripted model.
// The acceptance bar (with GPT's two additions):
//   1. a push wakes the existing Inbox Triage run (OIDC enforced; the webhook itself never reads mail)
//   2. duplicate deliveries: one canonical event row, one workflow
//   3. an event delivered while the worker is down is recovered by redelivery, exactly once
//   4. overlapping runs (push + manual + manual) never triage the same message twice (claims)
//   5. crash/reclaim: a run that dies after claiming or after saving leaves no duplicate label/draft/action,
//      whether DBOS resumes it or it is dead for good (repair from stored proposals, no second model call)
//   6. recorded-but-wake-not-started: a redelivery retries the wake instead of acking it as a duplicate
//   7. watch lifecycle: established, renewed only when due, renewal failure and expiry show in Needs You,
//      Retry now clears it; repeated misses (2+ scheduled runs) raise "missing mail", one miss doesn't
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-gmail-push.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EXTERNALS, LOG_DIR, all, freshDb, killAllWorkers, one, startWorker, waitFor, type Worker } from './lib.js';

const PORT = 7880;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const post = (p: string, body?: unknown) => fetch(`${EXTERNALS}${p}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const gmail = async () => (await fetch(`${EXTERNALS}/google/admin/gmail/state`)).json();
const seed = (msgs: unknown[]) => post('/google/admin/gmail/messages', msgs);

const AUD = 'https://ops.example/ingress/gmail';
const SA = 'gmail-push@agent-ops.iam.gserviceaccount.com';
const { url, db } = await freshDb('spike_gmail_push');
const triageLog = path.join(LOG_DIR, 'push-triage-calls.log');
fs.rmSync(triageLog, { force: true });
const env = {
  API_TOKEN: 'api-secret', CONNECTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
  GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
  GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
  GMAIL_BASE: `${EXTERNALS}/google/gmail/v1/users/me`, APP_URL: 'https://ops.example',
  GMAIL_PUSH_TOPIC: 'projects/agent-ops/topics/gmail', PUSH_OIDC_AUDIENCE: AUD, PUSH_OIDC_EMAIL: SA, PUSH_JWKS_URL: `${EXTERNALS}/pubsub/certs`,
  MOCK_TRIAGE_LOG: triageLog,
};
await post('/google/admin/reset');
let w: Worker = await startWorker({ id: 'push-1', port: PORT, dbUrl: url, env });
let wid = 1;
async function restart(extra: Record<string, string> = {}) {
  if (w.proc.exitCode === null && w.proc.signalCode === null) await w.kill();
  w = await startWorker({ id: `push-${++wid}`, port: PORT, dbUrl: url, env: { ...env, ...extra } });
}

const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const push = (messageId: string, opts: Record<string, string> = {}) => post('/pubsub/admin/push', {
  endpoint: `http://127.0.0.1:${PORT}/ingress/gmail`, aud: AUD, email: SA, emailAddress: 'Rone@example.com', historyId: '1', messageId, ...opts,
}) as Promise<{ status: number }>;
const runDone = (wf: string, ms = 30_000) => waitFor(`run ${wf}`, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [wf]))?.outcome), ms);
let runSeq = 0;
async function manualRun(): Promise<string> {
  const r = await call('POST', '/agents/inbox-triage/run', { requestId: `m${++runSeq}` });
  return r.body.workflowID;
}
const triageCalls = () => (fs.existsSync(triageLog) ? fs.readFileSync(triageLog, 'utf8').trim().split('\n').filter(Boolean)
  .map((l) => { const [wf, refs] = l.split('\t'); return { wf, refs: refs ? refs.split(',') : [] }; }) : []);
const timesClassified = (id: string) => triageCalls().filter((c) => c.refs.includes(id)).length;
const actionsFor = (id: string) => all(db, `select logical_action, status from ops.actions where agent_id = 'inbox-triage' and target = $1 order by logical_action`, [id]);
const item = (id: string) => one(db, `select status, triaged_by, claimed_by, proposed_at, category from ops.inbox_items where agent_id = 'inbox-triage' and message_id = $1`, [id]);
const ev = (id: string) => one(db, `select state, delivery_count, workflow_ids, detail from ops.ingress_events where source = 'gmail' and external_id = $1`, [id]);
const attention = async () => (await call('GET', '/attention')).body as { type: string; ref: string; title: string; summary: string; actions: { id: string }[] }[];
async function settled(ids: string[]) {
  // every message triaged, and every label executed in the fake Gmail
  await waitFor(`triaged ${ids.join(',')}`, async () => (await all(db, `select 1 from ops.inbox_items where agent_id = 'inbox-triage' and message_id = any($1) and status = 'triaged' and proposed_at is not null`, [ids])).length === ids.length, 30_000);
  await waitFor('labels executed', async () => (await all(db, `select 1 from ops.actions where agent_id = 'inbox-triage' and target = any($1) and logical_action = 'gmail.label' and status in ('executed', 'failed')`, [ids])).length === ids.length, 30_000);
}
const labelsOn = async (id: string) => ((await gmail()).messages.find((m: { id: string }) => m.id === id)?.labels ?? []).filter((l: string) => l.startsWith('Agent Ops/'));

try {
  // ---- connect Google; the first (manual) run bootstraps the cursor and establishes the watch ----
  const start = await call('POST', '/connections/google', { id: 'google:primary' });
  await fetch((await fetch(start.body.authUrl, { redirect: 'manual' })).headers.get('location')!);
  const first = await manualRun();
  await runDone(first);
  const st0 = await gmail();
  const watch0 = (await one(db, `select value from ops.state where agent_id = 'inbox-triage' and key = 'gmail.watch'`))?.value;
  check('a manual run establishes the Gmail watch on the configured topic', st0.watch.calls === 1 && st0.watch.topic === 'projects/agent-ops/topics/gmail' && watch0?.since && !watch0.lastError, { watch: st0.watch, watch0 });
  await runDone(await manualRun());
  check('…and does not renew it again while it is fresh', (await gmail()).watch.calls === 1, (await gmail()).watch);
  const h0 = await one(db, `select push_state from ops.mail_push_health where agent_id = 'inbox-triage'`);
  check('health shows push on', h0?.push_state === 'on', h0);

  // ---- 1. OIDC: everything that isn't Pub/Sub-for-us is refused, and records nothing ----
  for (const bad of ['none', 'wrong-aud', 'wrong-email', 'bad-sig', 'expired']) {
    const r = await push(`bad-${bad}`, { token: bad });
    check(`push with ${bad} token → 401`, r.status === 401, r);
  }
  check('…and no ingress row was recorded for any of them', (await one(db, `select count(*)::int n from ops.ingress_events`)).n === 0);

  // ---- 1. a push wakes Inbox Triage ----
  await seed([{ id: 'p1', from: 'Dana Lee <dana@northwind.example>', subject: 'Lunch Friday?', body: 'Are you free for lunch Friday?' }]);
  const r1 = await push('ps-1');
  check('a valid push is acknowledged (204)', r1.status === 204, r1);
  const e1 = await ev('ps-1');
  check('…recorded once, state started, with a deterministic workflow id', e1?.state === 'started' && e1.delivery_count === 1 && e1.workflow_ids[0] === 'push-inbox-triage-ps-1', e1);
  await runDone('push-inbox-triage-ps-1');
  await settled(['p1']);
  const run1 = await one(db, `select trigger_type, source_event, outcome from ops.runs where workflow_id = 'push-inbox-triage-ps-1'`);
  check('…the push ran the existing triage run (trigger push) and triaged the new mail', run1?.trigger_type === 'push' && run1.outcome === 'succeeded'
    && (await item('p1'))?.triaged_by === 'push', { run1, item: await item('p1') });
  check('…labeled once, draft proposed once', (await labelsOn('p1')).length === 1
    && JSON.stringify((await actionsFor('p1')).map((a) => a.logical_action)) === '["gmail.draft","gmail.label"]', { labels: await labelsOn('p1'), actions: await actionsFor('p1') });

  // ---- 2. duplicate delivery ----
  const r1b = await push('ps-1');
  const e1b = await ev('ps-1');
  const runsPs1 = (await one(db, `select count(*)::int n from ops.runs where source_event = 'ps-1'`)).n;
  check('a redelivered event is acked, bumps delivery_count on the SAME row, starts nothing new', r1b.status === 204 && e1b.delivery_count === 2
    && (await one(db, `select count(*)::int n from ops.ingress_events where external_id = 'ps-1'`)).n === 1 && runsPs1 === 1, { r1b, e1b, runsPs1 });
  // A push with no new mail (e.g. the watch's own first notification, or our label change) is a harmless no-op run.
  await push('ps-noop');
  await runDone('push-inbox-triage-ps-noop');
  const callsBefore = triageCalls().length;
  check('a push with no new mail runs, triages nothing, calls no model', (await one(db, `select outcome from ops.runs where workflow_id = 'push-inbox-triage-ps-noop'`)).outcome === 'succeeded'
    && triageCalls().length === callsBefore);

  // Unparseable payloads and other mailboxes are acked (retrying can't fix them) and recorded as ignored.
  const rBad = await push('ps-garbage', { raw: Buffer.from('not json').toString('base64') });
  const rOther = await push('ps-other', { emailAddress: 'someone@else.example' });
  check('unparseable payload → 204, ignored', rBad.status === 204 && (await ev('ps-garbage'))?.state === 'ignored', await ev('ps-garbage'));
  check('a mailbox no agent watches → 204, ignored', rOther.status === 204 && (await ev('ps-other'))?.state === 'ignored', await ev('ps-other'));

  // ---- 6. recorded but wake never started (crash between commit and start) → redelivery completes it ----
  await seed([{ id: 'p2', from: 'Sam <sam@acme.example>', subject: 'Quick question', body: 'Can you send the deck?' }]);
  await db.query(`insert into ops.ingress_events (source, external_id, account, history_id) values ('gmail', 'ps-2', 'rone@example.com', '1')`);
  const r2 = await push('ps-2');
  const e2 = await ev('ps-2');
  check('a redelivery of an event stuck in "received" retries the wake (not "duplicate, 204" forever)', r2.status === 204 && e2.state === 'started' && e2.delivery_count === 2, e2);
  await runDone('push-inbox-triage-ps-2');
  await settled(['p2']);
  check('…and the mail is triaged', (await item('p2'))?.status === 'triaged', await item('p2'));

  // ---- 3. delivered while the worker is down → Pub/Sub redelivers → exactly once ----
  await w.kill();
  await seed([{ id: 'p3', from: 'Ana <ana@acme.example>', subject: 'Contract signed', body: 'The contract is signed, nothing needed from you.' }]);
  const down = await push('ps-3').catch(() => ({ status: 0 }));
  check('a push while the worker is down is not acknowledged (Pub/Sub will redeliver)', down.status !== 204, down);
  await restart();
  const up = await push('ps-3');
  await runDone('push-inbox-triage-ps-3');
  await settled(['p3']);
  check('…the redelivery after the deploy wakes triage once, and the mail is triaged once', up.status === 204 && (await ev('ps-3')).delivery_count === 1
    && timesClassified('p3') === 1 && (await labelsOn('p3')).length === 1, { up, ev: await ev('ps-3'), n: timesClassified('p3') });

  // ---- 4. overlapping runs: push + two manual runs at once never triage a message twice ----
  const burst = Array.from({ length: 8 }, (_, i) => ({ id: `b${i}`, from: `Person ${i} <p${i}@ex.example>`, subject: `Topic ${i}?`, body: `Question ${i}: can we talk?` }));
  await seed(burst);
  await restart({ MOCK_DELAY_MS: '1500' }); // slow model: the runs really overlap
  const [, m1, m2] = await Promise.all([push('ps-burst'), manualRun(), manualRun()]);
  await Promise.all([runDone('push-inbox-triage-ps-burst'), runDone(m1), runDone(m2)]);
  const ids = burst.map((b) => b.id);
  await settled(ids);
  const twice = ids.filter((id) => timesClassified(id) !== 1);
  const labelCounts = await Promise.all(ids.map(async (id) => (await labelsOn(id)).length));
  const drafts = (await gmail()).drafts.filter((d: { subject: string }) => /^Re: Topic \d\?$/.test(d.subject)).length;
  const actionRows = (await one(db, `select count(*)::int n from ops.actions where agent_id = 'inbox-triage' and target = any($1)`, [ids])).n;
  check('three overlapping runs: every message classified exactly once', twice.length === 0, { twice, calls: triageCalls().slice(-4) });
  check('…one label each, one action set each (no duplicate draft/label/action)', labelCounts.every((n) => n === 1) && actionRows === ids.length * 2 && drafts === 0, { labelCounts, actionRows, drafts });
  const cursor = await one(db, `select (value->>'historyId')::int h from ops.state where agent_id = 'inbox-triage' and key = 'gmail.historyId'`);
  check('…and the history cursor ends at the mailbox head (monotonic)', cursor.h === (await gmail()).historyId, { cursor, head: (await gmail()).historyId });

  // ---- 5. crash/reclaim ----
  async function crashRun(point: string, msgs: { id: string; subject: string; body: string }[]): Promise<string> {
    await seed(msgs.map((m) => ({ ...m, from: 'Lee <lee@acme.example>' })));
    await w.kill();
    await restart({ TRIAGE_CRASH_AFTER: point });
    const wf = await manualRun();
    await w.exited;
    return wf;
  }
  // 5a. DBOS resumes the run: dies right after saving its triage (before inserting actions).
  const wfA = await crashRun('saveTriage', [{ id: 'c1', subject: 'Budget?', body: 'Can you approve the budget?' }]);
  check('5a: the run died after saveTriage (status triaged, actions not yet inserted)', (await item('c1'))?.status === 'triaged' && !(await item('c1')).proposed_at, await item('c1'));
  await restart();
  await runDone(wfA, 60_000);
  await settled(['c1']);
  check('5a: DBOS resumed it; one classification, one label, label+draft actions once', timesClassified('c1') === 1 && (await labelsOn('c1')).length === 1
    && (await actionsFor('c1')).length === 2, { n: timesClassified('c1'), labels: await labelsOn('c1'), actions: await actionsFor('c1') });

  // 5b. dead for good after saving: repaired from the stored proposals, without a second model call.
  const wfB = await crashRun('saveTriage', [{ id: 'c2', subject: 'Venue?', body: 'Can you confirm the venue?' }]);
  await db.query(`update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1`, [wfB]);
  await restart();
  await runDone(await manualRun());
  await settled(['c2']);
  check('5b: a dead run\'s saved triage is repaired by the next run: actions inserted once, no reclassification',
    timesClassified('c2') === 1 && (await actionsFor('c2')).length === 2 && (await labelsOn('c2')).length === 1 && (await item('c2'))?.category === 'needs_reply',
    { n: timesClassified('c2'), actions: await actionsFor('c2'), labels: await labelsOn('c2'), item: await item('c2') });

  // 5c. dead for good after claiming (before the model): the claim is released and the mail triaged once.
  const wfC = await crashRun('claimBatch', [{ id: 'c3', subject: 'Notes?', body: 'Could you share the notes?' }]);
  check('5c: the run died holding a claim', (await item('c3'))?.status === 'claimed' && (await item('c3')).claimed_by === wfC, await item('c3'));
  await restart();
  // While DBOS can still resume the owner, nobody else takes its claim.
  await waitFor('5c resumed', async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [wfC]))?.outcome), 60_000);
  check('5c: a live (recovering) owner keeps its claim and finishes the message itself', (await item('c3'))?.status === 'triaged' && timesClassified('c3') === 1, { item: await item('c3'), n: timesClassified('c3') });
  const wfD = await crashRun('claimBatch', [{ id: 'c4', subject: 'Agenda?', body: 'Could you share the agenda?' }]);
  await db.query(`update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1`, [wfD]);
  await restart();
  await runDone(await manualRun());
  await settled(['c4']);
  check('5d: a dead owner\'s claim is released and triaged exactly once', timesClassified('c4') === 1 && (await labelsOn('c4')).length === 1 && (await actionsFor('c4')).length === 2,
    { n: timesClassified('c4'), labels: await labelsOn('c4'), actions: await actionsFor('c4') });

  // ---- 7. watch lifecycle in Needs You ----
  await db.query(`update ops.state set value = value || jsonb_build_object('renewedAt', (now() - interval '2 days')::text) where agent_id = 'inbox-triage' and key = 'gmail.watch'`);
  await post('/google/admin/gmail/watch-fail', { status: 500 });
  await runDone(await manualRun());
  let off = (await attention()).find((i) => i.type === 'mail_push_off');
  check('a failed renewal → "Instant mail detection is off" in Needs You, with Retry now', Boolean(off && /Renewing the Gmail watch failed/.test(off.summary) && off.actions.some((a) => a.id === 'run_now')), off);
  const runsOk = (await one(db, `select count(*)::int n from ops.runs where agent_id = 'inbox-triage' and outcome = 'failed'`)).n;
  check('…and the triage run itself still succeeded (renewal never fails triage)', runsOk === 0, runsOk);
  await post('/google/admin/gmail/watch-fail', { status: 0 });
  const retry = await call('POST', `/attention/mail_push_off/inbox-triage/run_now`, { requestId: 'retry-1' });
  if (retry.body.workflowId) await runDone(retry.body.workflowId);
  off = (await attention()).find((i) => i.type === 'mail_push_off');
  check('Retry now renews the watch and clears the item', retry.status === 202 && !off, { retry, off });
  await db.query(`update ops.state set value = value || jsonb_build_object('expiration', (now() - interval '1 hour')::text) where agent_id = 'inbox-triage' and key = 'gmail.watch'`);
  off = (await attention()).find((i) => i.type === 'mail_push_off');
  check('an expired watch shows as off immediately', Boolean(off && /expired/.test(off.summary)), off);
  await runDone(await manualRun());
  check('…and the next run renews it (item gone)', !(await attention()).some((i) => i.type === 'mail_push_off'));

  // Misses: mail the schedule caught >2 min late with no push in between. One run is noise; two is a pattern.
  const miss = (id: string, wf: string) => db.query(
    `insert into ops.inbox_items (agent_id, message_id, status, received_at, triaged_at, triaged_by, source_workflow_id, category, triage_source)
     values ('inbox-triage', $1, 'triaged', now() - interval '12 minutes', now() - interval '1 minute', 'schedule', $2, 'fyi', 'model')`, [id, wf]);
  await db.query(`update ops.state set value = value || jsonb_build_object('since', (now() - interval '1 day')::text) where agent_id = 'inbox-triage' and key = 'gmail.watch'`);
  await miss('x1', 'sched-a');
  const oneMiss = await one(db, `select missed_24h, missed_runs_24h from ops.mail_push_health where agent_id = 'inbox-triage'`);
  check('one miss shows in health but raises nothing', oneMiss.missed_24h === 1 && !(await attention()).some((i) => i.type === 'mail_push_degraded'), oneMiss);
  await miss('x2', 'sched-b');
  const deg = (await attention()).find((i) => i.type === 'mail_push_degraded');
  check('misses on 2 separate scheduled runs → "missing mail" item', Boolean(deg && /2 scheduled runs/.test(deg.summary)), deg);
  const health = await one(db, `select push_state, pushes_24h, redeliveries_24h, push_triaged_24h, push_lag_p50_s from ops.mail_push_health where agent_id = 'inbox-triage'`);
  check('health reports pushes, redeliveries and push latency', health.push_state === 'on' && health.pushes_24h >= 5 && health.redeliveries_24h >= 2 && health.push_triaged_24h >= 1 && health.push_lag_p50_s !== null, health);

  check('the system never tried to send, delete or trash anything', (await gmail()).forbidden.length === 0, (await gmail()).forbidden);
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall gmail push checks passed');
process.exit(failures.length ? 1 : 0);
