// Follow-up Tracker (producer #3) end to end against the fake Gmail + scripted model: "waiting on others" and (A)
// the owner's own commitments (stronger evidence, both directions from one message, only the owner closes them).
// Durable item timers, reply-closes-before-due (via Inbox Triage's thread_activity contract and via a thread
// read at due time), re-arm when the owner wrote again, and the owner's three choices: Snooze (with input),
// Not needed, Draft nudge (→ an approval-required gmail.draft, never sent).
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-follow-up.ts
import { randomBytes } from 'node:crypto';
import { AttentionItemSchema } from '../src/compat.js';
import { EXTERNALS, all, freshDb, killAllWorkers, one, startWorker, waitFor } from './lib.js';

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused'; // the pure helpers' module imports the pool; nothing here connects
const { addBusinessDays, commitmentDueAt, commitmentGate, dueAt, snoozeUntil } = await import('../src/followUp.js');

const PORT = 7880;
const TZ = 'America/New_York';
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

// ---- pure: business days, due dates, snooze ----
check('business days skip weekends (Fri + 3 → Wed)', addBusinessDays('2026-10-30', 3) === '2026-11-04');
check('due: 3 business days after the message, 9 AM local', dueAt('2026-10-28T15:00:00Z', null, TZ).toISOString() === '2026-11-02T14:00:00.000Z');
check('due: an explicit date wins, due the business day after it', dueAt('2026-10-28T15:00:00Z', '2026-10-30', TZ).toISOString() === '2026-11-02T14:00:00.000Z'
  && dueAt('2026-10-26T15:00:00Z', '2026-11-04', TZ).toISOString() === '2026-11-05T14:00:00.000Z');
const now = new Date('2026-10-31T16:00:00Z');
check('snooze: presets and a picked date; past, far-future and junk are refused', snoozeUntil('1d', now, TZ)?.toISOString() === '2026-11-01T14:00:00.000Z' /* DST ends that night */
  && snoozeUntil('1w', now, TZ)?.toISOString() === '2026-11-07T14:00:00.000Z' && snoozeUntil('2026-11-12', now, TZ)?.toISOString() === '2026-11-12T14:00:00.000Z'
  && snoozeUntil('2026-10-01', now, TZ) === null && snoozeUntil('2027-06-01', now, TZ) === null && snoozeUntil('soon', now, TZ) === null);

// ---- pure (A): commitment due times and the evidence gate ----
check('commitment due: 9 AM ON the promised day; no date → 2 business days after the message',
  commitmentDueAt('2026-10-28T15:00:00Z', '2026-10-30', TZ).toISOString() === '2026-10-30T13:00:00.000Z'
  && commitmentDueAt('2026-10-29T15:00:00Z', null, TZ).toISOString() === '2026-11-02T14:00:00.000Z');
const T = "Thanks. I'll send the signed NDA tomorrow. I'll try to look into the pricing.";
const g = (quote: string, firm = true, deliverable = 'x') => commitmentGate(T, { quote, firm, deliverable });
check('the gate tracks only a firm, verbatim, first-person, unhedged promise with a deliverable',
  g("I'll send the signed NDA tomorrow.") === null && g("I'll try to look into the pricing.") === 'hedged'
  && g("I'll send the signed contract tomorrow.") === 'quote not verbatim' && g("I'll send the signed NDA tomorrow.", false) === 'not firm'
  && g('Thanks.') === 'quote not verbatim' && g('Thanks. I') === 'no first-person commitment' && g("send the signed NDA tomorrow") === 'no first-person commitment'
  && g("I'll send the signed NDA tomorrow.", true, ' ') === 'no deliverable');

// ---- end to end ----
const post = (p: string, body?: unknown) => fetch(`${EXTERNALS}${p}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const gmail = async () => (await fetch(`${EXTERNALS}/google/admin/gmail/state`)).json();
const ME = 'Rone <rone@example.com>';
const DAY = 24 * 60;
const sent = (id: string, threadId: string, to: string, subject: string, body: string, ageMinutes: number, extra: object = {}) =>
  ({ id, threadId, from: ME, to, subject, body, ageMinutes, labelIds: ['SENT'], ...extra });
const inbound = (id: string, threadId: string, from: string, subject: string, body: string, ageMinutes: number, labelIds = ['INBOX', 'UNREAD']) =>
  ({ id, threadId, from, to: ME, subject, body, ageMinutes, labelIds });

const { url, db } = await freshDb('spike_followup');
const env = {
  API_TOKEN: 'api-secret', CONNECTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
  GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
  GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
  GMAIL_BASE: `${EXTERNALS}/google/gmail/v1/users/me`, APP_URL: 'https://ops.example',
};
await post('/google/admin/reset');
const w = await startWorker({ id: 'followup-1', port: PORT, dbUrl: url, env });
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;
async function run(agent: string) {
  const r = await call('POST', `/agents/${agent}/run`, { requestId: `${agent}-${++seq}` });
  await waitFor(`${agent} run ${seq}`, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [r.body.workflowID]))?.outcome), 30_000);
  return one(db, `select outcome, error_message from ops.runs where workflow_id = $1`, [r.body.workflowID]);
}
const item = (threadId: string) => one(db, `select id::text, status, close_reason, explicit_date::text, due_at, nudges, counterpart, expects from ops.follow_up_items where thread_id = $1 order by id desc limit 1`, [threadId]);
const cards = async () => ((await call('GET', '/attention')).body as any[]).filter((i) => i.type === 'follow_up_due');

try {
  const start = await call('POST', '/connections/google', { id: 'google:primary' });
  await fetch((await fetch(start.body.authUrl, { redirect: 'manual' })).headers.get('location')!);

  await post('/google/admin/gmail/messages', [
    sent('w1', 'tw1', 'Jane Doe <jane@acme.com>', 'Proposal', 'Let me know what you think of the proposal.', 6 * DAY),
    sent('w2', 'tw2', 'Lee Chen <lee@foo.io>', 'Contract', 'Can you send the signed contract by Friday?', 1 * DAY),
    sent('p1', 'tp1', 'Sam Ortiz <sam@ortizlabs.io>', 'Pilot', "I'll check with the team and get back to you.", 6 * DAY),
    sent('n1', 'tn1', 'Kim Park <kim@d.co>', 'Re: Notes', 'Thanks, got it.', 6 * DAY),
    sent('s1', 'ts1', ME, 'Note to self', 'Remember the dentist?', 6 * DAY),
    // replied in the inbox (Inbox Triage will see it) → closed via the thread_activity contract
    sent('r1', 'tr1', 'Ana Ruiz <ana@b.co>', 'Venue', 'Could you confirm the venue?', 6 * DAY),
    inbound('r1a', 'tr1', 'Ana Ruiz <ana@b.co>', 'Re: Venue', 'Confirmed, the loft.', 120),
    // replied but archived (Triage never sees it) → closed by the thread read at due time
    sent('r2', 'tr2', 'Bo Lin <bo@c.co>', 'Slides', 'Can you share the slides?', 6 * DAY),
    inbound('r2a', 'tr2', 'Bo Lin <bo@c.co>', 'Re: Slides', 'Here you go.', 3 * DAY, ['CATEGORY_UPDATES']),
    sent('w3', 'tw3', 'Kim Park <kim@d.co>', 'Budget', 'What do you think about the budget split?', 6 * DAY),
    sent('w4', 'tw4', 'Max Roe <max@e.co>', 'Invoice', 'Any update on the invoice?', 6 * DAY),
    // the owner already followed up themselves → re-armed, not surfaced
    sent('f1', 'tf1', 'Zed Ng <zed@f.co>', 'Draft review', 'Can you review the draft?', 6 * DAY),
    sent('f2', 'tf1', 'Zed Ng <zed@f.co>', 'Re: Draft review', 'Bumping this.', 1 * DAY),
    // ---- A: owner commitments ----
    sent('h1', 'th1', 'Kim Park <kim@d.co>', 'Login', "Thanks for flagging. I'll try to look into it.", 6 * DAY),            // hedged → recorded, not tracked
    sent('b1', 'tb1', 'Jane Doe <jane@acme.com>', 'Offsite', "I'll send the deck. Can you confirm the venue?", 1 * DAY),      // both directions
    sent('cr1', 'tcr1', 'Ana Ruiz <ana@b.co>', 'Contract', "I'll send the contract.", 6 * DAY),                                // their reply…
    inbound('cr1a', 'tcr1', 'Ana Ruiz <ana@b.co>', 'Re: Contract', 'Great, thanks!', 3 * DAY),                                  // …doesn't fulfil it
    sent('cw1', 'tcw1', 'Bo Lin <bo@c.co>', 'Slides', "I'll share the slides.", 6 * DAY),
    sent('cw2', 'tcw1', 'Bo Lin <bo@c.co>', 'Re: Slides', 'Still working on the slides.', 1 * DAY),                            // shown, never trusted
    sent('cd1', 'tcd1', 'Max Roe <max@e.co>', 'Budget', "I'll send the budget by Friday.", 6 * DAY),                           // owner's own date
  ]);

  const tri = await run('inbox-triage');
  const act = await one(db, `select count(*)::int n from ops.thread_activity where thread_id = 'tr1' and recorded_by = 'inbox-triage'`);
  check('Inbox Triage publishes inbound thread activity (the cross-producer contract)', tri.outcome === 'succeeded' && act.n === 1, { tri, act });

  const r1 = await run('follow-up-tracker');
  const r1b = await run('follow-up-tracker'); // sent mail is judged at most 15 per run: the second run takes the rest
  check('tracker runs succeed (sent mail judged in batches)', r1.outcome === 'succeeded' && r1b.outcome === 'succeeded', { r1, r1b });
  const scanned = Object.fromEntries((await all(db, `select message_id, result from ops.follow_up_scanned`)).map((r) => [r.message_id, r.result]));
  check('every sent message judged once: asks → waiting; a firm "I\'ll …" → commitment; thanks → none; to self → skipped',
    scanned.w1 === 'waiting' && scanned.p1 === 'commitment' && scanned.n1 === 'none' && /^skipped/.test(scanned.s1) && !('r1a' in scanned), scanned);
  const dirs = async (threadId: string) => (await all(db, `select direction from ops.follow_up_items where thread_id = $1 order by direction`, [threadId])).map((r) => r.direction).join();
  check('A: the owner\'s firm promise becomes an owner_commitment item (never waiting_on_them); thanks → nothing', (await dirs('tp1')) === 'owner_commitment' && !(await item('tn1')));
  check('A: a hedged promise ("I\'ll try to look into it") is recorded as commitment_soft and never tracked, though the model called it firm',
    scanned.h1 === 'commitment_soft' && (await dirs('th1')) === '', scanned.h1);
  check('A: one message that asks AND promises opens both items', scanned.b1 === 'waiting+commitment' && (await dirs('tb1')) === 'owner_commitment,waiting_on_them', { r: scanned.b1, d: await dirs('tb1') });
  const cd = await one(db, `select explicit_date::text, due_at, last_owner_message_at from ops.follow_up_items where thread_id = 'tcd1'`);
  check('A: the owner\'s own date ("by Friday") is the promise date; due 9 AM that day', Boolean(cd?.explicit_date)
    && new Date(cd.due_at).getTime() === commitmentDueAt(new Date(cd.last_owner_message_at).toISOString(), cd.explicit_date, TZ).getTime()
    && new Date(cd.due_at).getTime() === commitmentDueAt('2000-01-01T00:00:00Z', cd.explicit_date, TZ).getTime(), cd);
  const cr = await one(db, `select status, close_reason from ops.follow_up_items where thread_id = 'tcr1' and direction = 'owner_commitment'`);
  check('A: their reply does NOT close the owner\'s commitment (it is due, not "replied")', cr?.status === 'due' && cr.close_reason === null, cr);
  const i2 = await item('tw2');
  check('explicit date: "by Friday" → waiting until the business day after that Friday', i2?.status === 'waiting' && Boolean(i2.explicit_date)
    && new Date(i2.due_at).toISOString() === dueAt(new Date().toISOString(), i2.explicit_date, TZ).toISOString(), i2);
  check('a reply Triage saw closes the item before it comes due', (await item('tr1'))?.status === 'closed' && (await item('tr1'))?.close_reason === 'replied');
  check('a reply Triage never saw (archived) is found by the thread read at due time', (await item('tr2'))?.status === 'closed' && (await item('tr2'))?.close_reason === 'replied');
  const f = await item('tf1');
  check('the owner already followed up → re-armed from their latest message, not surfaced', f?.status === 'waiting' && new Date(f.due_at) > new Date(), f);

  const due = await cards();
  const c1 = due.find((c) => c.summary.includes('Proposal') || /Jane/.test(c.title));
  check('due items surface in Needs You: "Still waiting on Jane Doe", last message, three actions', due.length === 3 && c1?.title === 'Still waiting on Jane Doe'
    && /^Last message: \w+ \d+ · /.test(c1.summary) && c1.actions.map((a: any) => a.id).join() === 'nudge,snooze,not_needed', due);
  check('Snooze carries its choices (incl. a date picker) and the shape passes the compat contract', due.every((c) => AttentionItemSchema.safeParse(c).success)
    && c1.actions[1].choices.map((x: any) => x.id).join() === '1d,3d,1w,date' && c1.actions[1].choices[3].input === 'date', c1?.actions);
  const det = (await call('GET', `/attention/follow_up_due/${c1.ref}`)).body;
  check('drill-in: who, subject, what for, the owner\'s own words', det.facts.some((x: any) => x.label === 'Waiting on' && /jane@acme\.com/.test(x.value))
    && det.facts.some((x: any) => x.label === 'You wrote'), det.facts);

  const notOnWaiting = await call('POST', `/attention/follow_up_due/${c1.ref}/done`, { requestId: 'd0' });
  check('A: "Done" is a commitment action: refused on a waiting-on-them card', notOnWaiting.status === 400, notOnWaiting);

  // ---- Snooze (richer input) ----
  const noChoice = await call('POST', `/attention/follow_up_due/${c1.ref}/snooze`, { requestId: 's0' });
  const bad = await call('POST', `/attention/follow_up_due/${c1.ref}/snooze`, { requestId: 's1', choice: 'whenever' });
  const ok = await call('POST', `/attention/follow_up_due/${c1.ref}/snooze`, { requestId: 's2', choice: '1w' });
  const sn = await item('tw1');
  check('Snooze needs a valid choice; "Next week" moves due_at and clears the card', noChoice.status === 400 && bad.status === 400 && ok.status === 200
    && /Snoozed until/.test(ok.body.message) && sn.status === 'waiting' && new Date(sn.due_at).toISOString() === snoozeUntil('1w', new Date(), TZ)!.toISOString()
    && !(await cards()).some((c) => c.ref === c1.ref), { noChoice, bad, ok, sn });

  // ---- Not needed ----
  const c3 = (await cards()).find((c) => /Kim/.test(c.title))!;
  const nn = await call('POST', `/attention/follow_up_due/${c3.ref}/not_needed`, { requestId: 'n' });
  check('Not needed closes the item', nn.status === 200 && (await item('tw3'))?.close_reason === 'not_needed' && !(await cards()).some((c) => c.ref === c3.ref));

  // ---- Draft nudge → approval → a threaded Gmail draft, never sent ----
  const c4 = (await cards()).find((c) => /Max/.test(c.title))!;
  const nd = await call('POST', `/attention/follow_up_due/${c4.ref}/nudge`, { requestId: 'nudge-1' });
  const nudgeQ = `select id, status, payload from ops.actions where agent_id = 'follow-up-tracker' and logical_action = 'gmail.draft'`;
  await waitFor('nudge proposed', async () => Boolean(await one(db, nudgeQ)), 20_000);
  const action = await one(db, nudgeQ);
  const i4 = await item('tw4');
  const approval = ((await call('GET', '/attention')).body as any[]).find((i) => i.type === 'approval_needed' && i.ref === action.id);
  check('Draft nudge proposes a gmail.draft that needs approval; the item waits 2 business days', nd.status === 202 && action.status === 'pending_approval'
    && i4.status === 'waiting' && i4.nudges === 1 && Boolean(approval) && /Follow-up: still waiting on/.test(approval?.summary ?? ''), { nd, action, i4, approval });
  await call('POST', `/attention/approval_needed/${action.id}/approve`, { requestId: 'a1' });
  await waitFor('nudge draft executed', async () => (await one(db, `select status from ops.actions where id = $1`, [action.id])).status === 'executed', 20_000);
  const g = await gmail();
  const draft = g.drafts.find((d: any) => d.threadId === 'tw4');
  check('approved nudge = a draft in the thread, replying to the owner\'s message; nothing sent, no forbidden calls', draft?.to === 'max@e.co'
    && draft.inReplyTo === '<w4@mail.example>' && g.forbidden.length === 0, { draft, forbidden: g.forbidden });

  // ---- A: commitment cards and the owner's choices ----
  const ccards = async () => ((await call('GET', '/attention')).body as any[]).filter((i) => i.type === 'commitment_due');
  const cc = await ccards();
  const byTitle = (re: RegExp) => cc.find((c) => re.test(c.title));
  const cP = byTitle(/Sam/), cR = byTitle(/Ana/), cW = byTitle(/Bo/);
  check('A: due commitments surface as "You promised …" with Done / Snooze / Not needed, through the app contract',
    Boolean(cP && cR && cW) && /^You promised Sam Ortiz: /.test(cP.title) && cc.every((c) => c.actions.map((a: any) => a.id).join() === 'done,snooze,not_needed'
      && AttentionItemSchema.safeParse(c).success) && /No date given/.test(cP.summary) && /“I'll check with the team/.test(cP.summary), cc);
  check('A: the owner\'s later message in the thread is shown on the card, and it stays open', /You've written in this thread since/.test(cW?.summary ?? '')
    && (await one(db, `select status from ops.follow_up_items where thread_id = 'tcw1'`))?.status === 'due', cW);
  const cdet = (await call('GET', `/attention/commitment_due/${cP.ref}`)).body;
  check('A: drill-in shows who, what, the owner\'s exact words and the promised date', cdet.facts.some((x: any) => x.label === 'Promised to' && /sam@ortizlabs\.io/.test(x.value))
    && cdet.facts.some((x: any) => x.label === 'You wrote') && cdet.facts.some((x: any) => x.label === 'Promised for' && x.value === 'No date given'), cdet.facts);
  const dismissIt = await call('POST', `/attention/commitment_due/${cP.ref}/dismiss`, { requestId: 'd1' });
  const done = await call('POST', `/attention/commitment_due/${cP.ref}/done`, { requestId: 'd2' });
  const doneAgain = await call('POST', `/attention/commitment_due/${cP.ref}/done`, { requestId: 'd3' });
  check('A: Done closes it as done (only on a commitment; it needs a decision, not a dismissal; a second Done is a no-op)',
    done.status === 200 && (await one(db, `select close_reason from ops.follow_up_items where id::text = $1`, [cP.ref])).close_reason === 'done'
    && dismissIt.status === 400 && doneAgain.status === 409, { done, dismissIt, doneAgain });
  const snz = await call('POST', `/attention/commitment_due/${cR.ref}/snooze`, { requestId: 'd4', choice: '3d' });
  const nnc = await call('POST', `/attention/commitment_due/${cW.ref}/not_needed`, { requestId: 'd5' });
  const cdCard = (await ccards()).find((c) => /Max/.test(c.title));
  if (cdCard) await call('POST', `/attention/commitment_due/${cdCard.ref}/not_needed`, { requestId: 'd6' }); // its date may or may not have passed
  check('A: Snooze and Not needed work on commitments too', snz.status === 200 && nnc.status === 200
    && (await one(db, `select status from ops.follow_up_items where id::text = $1`, [cR.ref])).status === 'waiting'
    && (await one(db, `select close_reason from ops.follow_up_items where id::text = $1`, [cW.ref])).close_reason === 'not_needed' && (await ccards()).length === 0, { snz, nnc });

  // ---- re-running is idempotent; snoozed and handled items stay put ----
  const before = await one(db, `select count(*)::int n from ops.follow_up_items`);
  await run('follow-up-tracker');
  const after = await one(db, `select count(*)::int n from ops.follow_up_items`);
  check('a second run re-judges nothing and duplicates nothing; nothing handled resurfaces', before.n === after.n && (await cards()).length === 0
    && (await ccards()).length === 0, { before, after, cards: await cards(), ccards: await ccards() });
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall follow-up checks passed');
process.exit(failures.length ? 1 : 0);
