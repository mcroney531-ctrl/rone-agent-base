// Inbox Triage (producer #2) end to end against the fake Google/Gmail + scripted model.
// Also the genericity check for #1a: two very different producers share one inbox, one actions framework,
// one health model, and nothing outside the producer-specific renderers cares which made what.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-inbox-triage.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AttentionItemSchema } from '../src/compat.js';
import { EXTERNALS, LOG_DIR, all, freshDb, killAllWorkers, one, startWorker, waitFor, type Worker } from './lib.js';

const PORT = 7870;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const post = (p: string, body?: unknown) => fetch(`${EXTERNALS}${p}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const gmail = async () => (await fetch(`${EXTERNALS}/google/admin/gmail/state`)).json();
const seed = (msgs: unknown[]) => post('/google/admin/gmail/messages', msgs);

const { url, db } = await freshDb('spike_inbox');
const crashMarker = path.join(LOG_DIR, 'inbox-crash.marker');
fs.rmSync(crashMarker, { force: true });
const env = {
  API_TOKEN: 'api-secret', SUPABASE_URL: `${EXTERNALS}/supabase`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OWNER_EMAIL: 'owner@example.com',
  CONNECTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
  GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
  GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
  GMAIL_BASE: `${EXTERNALS}/google/gmail/v1/users/me`, APP_URL: 'https://ops.example',
  // Crash the worker right after Gmail accepted the first draft, before the executor checkpoints it.
  CRASH_AFTER_PROVIDER_CALL: crashMarker, CRASH_AFTER_PROVIDER_CALL_ACTION: 'gmail.draft',
};
await post('/google/admin/reset');
let w: Worker = await startWorker({ id: 'inbox-1', port: PORT, dbUrl: url, env });

const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let runSeq = 0;
async function runTriage() {
  const r = await call('POST', '/agents/inbox-triage/run', { requestId: `r${++runSeq}` });
  await waitFor(`triage run ${runSeq}`, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [r.body.workflowID]))?.outcome), 30_000);
  return one(db, `select outcome, error_message, actions_proposed from ops.runs where workflow_id = $1`, [r.body.workflowID]);
}
const items = () => all(db, `select message_id, status, category, triage_source, can_reply, summary, label from ops.inbox_items where agent_id = 'inbox-triage' order by message_id`);
const actions = (kind: string) => all(db, `select id, target, status, decided_by, error, payload from ops.actions where agent_id = 'inbox-triage' and logical_action = $1 order by target`, [kind]);

try {
  // ---- connect Google, then simulate a connection made before Gmail was added (calendar scopes only) ----
  const start = await call('POST', '/connections/google', { id: 'google:primary' });
  await fetch((await fetch(start.body.authUrl, { redirect: 'manual' })).headers.get('location')!);
  await db.query(`update ops.connections set scopes = array_remove(scopes, 'https://www.googleapis.com/auth/gmail.modify') where id = 'google:primary'`);

  const health = async () => Object.fromEntries((await all(db, `select agent_id, health_state from ops.agent_health`)).map((r) => [r.agent_id, r.health_state]));
  const h0 = await health();
  const conn = (await call('GET', '/attention')).body.filter((i: { type: string }) => i.type === 'connection_problem');
  check('missing Gmail scope blocks ONLY Inbox Triage; Calendar Prep stays runnable', h0['inbox-triage'] === 'blocked' && h0['calendar-prep'] !== 'blocked', h0);
  check('…and Needs You shows one Reconnect item that names Inbox Triage', conn.length === 1 && /Inbox Triage/.test(conn[0].summary)
    && conn[0].actions.some((a: { id: string }) => a.id === 'reauth'), conn);
  const blockedRun = await runTriage();
  check('a manual run while blocked fails clearly (connection_unavailable)', blockedRun.outcome === 'failed' && /missing access/.test(blockedRun.error_message), blockedRun);

  // Reconnect: consent now includes Gmail.
  const again = await call('POST', '/connections/google', { id: 'google:primary' });
  await fetch((await fetch(again.body.authUrl, { redirect: 'manual' })).headers.get('location')!);
  check('after Reconnect the agent is unblocked and the item is gone',
    (await health())['inbox-triage'] !== 'blocked' && !(await call('GET', '/attention')).body.some((i: { type: string }) => i.type === 'connection_problem'));

  // ---- bootstrap: last 24h of inbox ----
  await seed([
    { id: 'q1', from: 'Dana Lee <dana@northwind.example>', subject: 'Intro call Thursday?', body: 'Hi! Does Thursday at 3:30 work for a quick intro call?' },
    { id: 'pw', from: 'Acme Security <no-reply@acme.example>', subject: 'Password expires in 3 days', body: 'Your password expires soon. Can you reset it?', headers: { 'Auto-Submitted': 'auto-generated' } },
    { id: 'nr', from: 'Parcel Service <noreply@parcels.example>', subject: 'Can you confirm your delivery window?', body: 'Which day suits you?' },
    { id: 'inv', from: 'Billing <billing@vendor.example>', subject: 'Invoice #1042', body: 'Your invoice for October is attached.' },
    { id: 'news', from: 'Weekly Digest <news@digest.example>', subject: 'This week in tools', body: 'Top stories this week.', headers: { 'List-Unsubscribe': '<mailto:u@digest.example>' } },
    { id: 'promo', from: 'Shop <deals@shop.example>', subject: '50% off today', body: 'Huge sale!', labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], headers: { 'List-Unsubscribe': '<mailto:u@shop.example>' } },
    { id: 'old', from: 'Old <old@example.com>', subject: 'Last week?', body: 'Is this still on?', ageMinutes: 3 * 24 * 60 },
    { id: 'sent', from: 'Rone <rone@example.com>', subject: 'not inbox', body: '…', labelIds: ['SENT'] },
  ]);
  const r1 = await runTriage();
  const it1 = await items();
  const byId = Object.fromEntries(it1.map((i) => [i.message_id, i]));
  check('bootstrap reads only the last 24h of INBOX (not older mail, not sent mail)', r1.outcome === 'succeeded'
    && JSON.stringify(Object.keys(byId).sort()) === JSON.stringify(['inv', 'news', 'nr', 'promo', 'pw', 'q1']), { r1, ids: Object.keys(byId) });
  check('a person asking a question → needs_reply (model)', byId.q1?.category === 'needs_reply' && byId.q1.can_reply === true && byId.q1.triage_source === 'model', byId.q1);
  check('no-reply ≠ unimportant: a no-reply password expiry is action_required, can_reply false', byId.pw?.category === 'action_required' && byId.pw.can_reply === false, byId.pw);
  check('needs_reply requires a reachable person: the model said needs_reply for a noreply@ sender → action_required, no draft',
    byId.nr?.category === 'action_required' && byId.nr.can_reply === false, byId.nr);
  check('invoice → receipt; list mail → newsletter', byId.inv?.category === 'receipt' && byId.news?.category === 'newsletter', [byId.inv, byId.news]);
  check('Promotions-tab mail skips the model (heuristic) and gets no actions', byId.promo?.triage_source === 'heuristic' && !byId.promo.label, byId.promo);
  const cursor1 = await one(db, `select value from ops.state where agent_id = 'inbox-triage' and key = 'gmail.historyId'`);
  check('the Gmail history cursor is saved after the bootstrap', Boolean(cursor1?.value?.historyId), cursor1);

  // ---- labels: auto-approved by policy, executed, only Agent Ops/* ----
  await waitFor('labels executed', async () => (await actions('gmail.label')).every((a) => a.status === 'executed'), 30_000);
  const labels = await actions('gmail.label');
  const g1 = await gmail();
  const labelsOn = (id: string) => g1.messages.find((m: { id: string }) => m.id === id)?.labels ?? [];
  check('labels are auto-approved by policy (no owner) and applied in Gmail under Agent Ops/*', labels.length === 5
    && labels.every((a) => a.decided_by === 'policy:auto' && a.status === 'executed')
    && labelsOn('q1').includes('Agent Ops/Needs reply') && labelsOn('pw').includes('Agent Ops/Action required')
    && g1.labels.every((l: { name: string }) => l.name.startsWith('Agent Ops/')), { labels, gmail: g1.messages });
  const attention1 = (await call('GET', '/attention')).body as { type: string; title: string; summary: string; actions: { id: string; label: string }[]; ref: string; source: string }[];
  check('label actions never reach Needs You', !attention1.some((i) => i.type === 'approval_needed' && /Label/.test(i.title)), attention1.map((i) => i.title));

  // ---- drafts: proposed only for needs_reply (and never for no-reply), approval required ----
  const drafts = await actions('gmail.draft');
  check('exactly one draft proposed (q1); none for either no-reply email', drafts.length === 1 && drafts[0].target === 'q1' && drafts[0].status === 'pending_approval', drafts);
  const card = attention1.find((i) => i.type === 'approval_needed' && i.ref === drafts[0]?.id);
  check('the Needs You card: "Draft reply", From · Subject, summary, a quote, [Approve draft] [Reject]', !!card && card.title === 'Draft reply — approve?'
    && /Dana Lee · Intro call Thursday\?/.test(card.summary) && /“Thanks for reaching out/.test(card.summary)
    && card.actions.map((a) => a.label).join() === 'Approve draft,Reject' && card.source === 'Inbox Triage', card);
  const detail = (await call('GET', `/attention/approval_needed/${drafts[0].id}`)).body;
  check('the drill-in shows the full draft and hides Gmail plumbing (ids, headers)', detail.facts.some((f: { label: string; value: string }) => f.label === 'Draft' && /works for me at \[time\]/.test(f.value))
    && !detail.facts.some((f: { label: string }) => ['Message Id', 'Thread Id', 'In Reply To', 'Connection Id'].includes(f.label)), detail.facts);
  check('a note for the owner is shown beside the draft, never inside it', detail.facts.some((f: { label: string; value: string }) => f.label === 'Note for you' && /Pick a time/.test(f.value))
    && !detail.facts.some((f: { label: string; value: string }) => f.label === 'Draft' && /Pick a time/.test(f.value)) && /Note for you: Pick a time/.test(card?.summary ?? ''), { facts: detail.facts, summary: card?.summary });

  // ---- second run, no new mail: nothing re-read, nothing re-proposed ----
  const r2 = await runTriage();
  check('a run with no new mail uses the history cursor and proposes nothing', r2.outcome === 'succeeded' && r2.actions_proposed === 0
    && (await items()).length === 6, r2);

  // ---- new mail arrives: picked up through history ----
  await seed([{ id: 'q2', threadId: 't-q1', from: 'Dana Lee <dana@northwind.example>', subject: 'Re: Intro call Thursday?', body: 'Or would Friday be better?' }]);
  const r3 = await runTriage();
  check('new mail is picked up incrementally through Gmail history', r3.outcome === 'succeeded' && (await items()).find((i) => i.message_id === 'q2')?.category === 'needs_reply', r3);

  // ---- approve the draft: the worker dies right after Gmail accepted it; the replacement must not draft again ----
  const approve = await call('POST', `/attention/approval_needed/${drafts[0].id}/approve`, { requestId: 'tap-1' });
  check('approving a draft from the phone is accepted', approve.status === 200, approve);
  await waitFor('crash after draft created', () => w.proc.exitCode !== null || fs.existsSync(crashMarker), 30_000);
  await w.exited;
  w = await startWorker({ id: 'inbox-2', port: PORT, dbUrl: url, env });
  await waitFor('draft action executed after takeover', async () => (await actions('gmail.draft')).find((a) => a.target === 'q1')?.status === 'executed', 60_000);
  const g2 = await gmail();
  const q1Drafts = g2.drafts.filter((d: { threadId: string }) => d.threadId === 't-q1');
  check('crash after Gmail accepted the draft → exactly ONE draft (found by its Message-ID on replay)', q1Drafts.length === 1, g2.drafts);
  check('the draft is a threaded reply: Re: subject, In-Reply-To the original, sent to the sender', q1Drafts[0]?.subject === 'Re: Intro call Thursday?'
    && q1Drafts[0]?.inReplyTo === '<q1@mail.example>' && /dana@northwind\.example/.test(q1Drafts[0]?.to ?? ''), q1Drafts[0]);

  // ---- history expired: re-bootstrap without duplicates ----
  await post('/google/admin/gmail/expire-history');
  const before = (await items()).length;
  const r4 = await runTriage();
  check('expired history cursor → re-bootstrap from the last 24h, no duplicate items or actions', r4.outcome === 'succeeded' && (await items()).length === before
    && (await actions('gmail.draft')).length === 2, { r4, before, after: (await items()).length });

  // ---- never send, never touch anything that isn't ours ----
  const g3 = await gmail();
  check('Gmail saw ZERO send/delete/trash/archive or non-Agent-Ops label attempts', g3.forbidden.length === 0, g3.forbidden);
  const src = fs.readFileSync('src/connections/gmail.ts', 'utf8');
  check('the Gmail capability module has no send/trash/delete/archive path at all', !/\/send|\/trash|removeLabelIds|method: 'DELETE'|batchModify/.test(src.replace(/^\s*\/\/.*$/gm, '')));

  // ---- genericity: two producers, one inbox, one health model ----
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([
    { id: 'ext1', summary: 'Acme pricing review', status: 'confirmed', start: { dateTime: new Date(Date.now() + 26 * 3600_000).toISOString() }, end: { dateTime: new Date(Date.now() + 27 * 3600_000).toISOString() },
      attendees: [{ email: 'rone@example.com', self: true }, { email: 'jane@acme.com' }], description: 'Deck: https://docs.google.com/presentation/d/abc' },
  ]) });
  const cp = await call('POST', '/agents/calendar-prep/run', { requestId: 'cp-1' });
  await waitFor('calendar prep run', async () => (await one(db, `select outcome from ops.runs where workflow_id = $1`, [cp.body.workflowID]))?.outcome === 'succeeded', 30_000);
  const att = (await call('GET', '/attention')).body as { type: string; source: string; id: string; title: string; summary: string; actions: unknown[]; severity: string; createdAt: string }[];
  const sources = new Set(att.map((i) => i.source));
  check('Needs You holds items from BOTH producers in one list with one shape', sources.has('Calendar Prep') && sources.has('Inbox Triage')
    && att.every((i) => AttentionItemSchema.safeParse(i).success), att.map((i) => `${i.source}: ${i.title}`));
  await call('POST', '/agents/inbox-triage/pause', {});
  const agentsList = (await call('GET', '/agents')).body as { id: string; health_state: string; paused_at: string | null }[];
  const st = Object.fromEntries(agentsList.map((a) => [a.id, a.health_state]));
  check('one health model: pausing one producer leaves the other healthy', st['inbox-triage'] === 'paused' && st['calendar-prep'] === 'healthy', st);
  const pausedRun = await call('POST', '/agents/inbox-triage/run', { requestId: 'while-paused' });
  check('pause applies to the new producer unchanged (409)', pausedRun.status === 409, pausedRun);
  await call('POST', '/agents/inbox-triage/resume', {});
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall inbox triage checks passed');
process.exit(failures.length ? 1 : 0);
