// Calendar Prep V1 end to end against the fake Google + scripted model.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-calendar-prep.ts
import { randomBytes } from 'node:crypto';
import { EXTERNALS, freshDb, killAllWorkers, one, startWorker, waitFor } from './lib.js';
import { addDays, localDate, zonedMidnight, zonedTime } from '../src/localDay.js';
import { findSlot } from '../src/slots.js';

const PORT = 7840;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const gstate = async () => (await fetch(`${EXTERNALS}/google/admin/state`)).json();

// ---- pure checks: the local day is computed in the agent's zone, DST included ----
const TZ = 'America/New_York';
check('DST end day spans 25h (2026-11-01 NY: 04:00Z → 05:00Z next day)',
  zonedMidnight('2026-11-01', TZ).toISOString() === '2026-11-01T04:00:00.000Z' && zonedMidnight('2026-11-02', TZ).toISOString() === '2026-11-02T05:00:00.000Z');
check('DST start day spans 23h (2026-03-08 NY: 05:00Z → 04:00Z next day)',
  zonedMidnight('2026-03-08', TZ).toISOString() === '2026-03-08T05:00:00.000Z' && zonedMidnight('2026-03-09', TZ).toISOString() === '2026-03-09T04:00:00.000Z');
check('8 PM tick briefs the next LOCAL day (00:00Z is still the previous evening in NY)',
  addDays(localDate(new Date('2026-11-02T01:00:00Z'), TZ), 1) === '2026-11-02');

// ---- deterministic hold placement (pure) ----
{
  const D = '2026-11-03';
  const t = (hhmm: string) => zonedTime(D, hhmm, TZ).getTime();
  const iso = (ms: number) => new Date(ms).toISOString();
  const req = { idealMinutes: 45, minimumMinutes: 20, preferredLeadMinutes: 30 };
  const s1 = findSlot(t('14:00'), req, [], D, TZ);
  check('slot: ideal duration, ending at the preferred lead', !!s1 && iso(s1.start) === iso(t('12:45')) && iso(s1.end) === iso(t('13:30')), s1 && [iso(s1.start), iso(s1.end)]);
  const s2 = findSlot(t('14:00'), req, [{ start: t('12:30'), end: t('13:40') }], D, TZ);
  check('slot: never overlaps a busy block; takes the nearest earlier gap', !!s2 && iso(s2.start) === iso(t('11:45')) && iso(s2.end) === iso(t('12:30')), s2 && [iso(s2.start), iso(s2.end)]);
  const s3 = findSlot(t('09:00'), req, [{ start: t('08:00'), end: t('08:15') }], D, TZ);
  check('slot: falls back to a shorter (≥ minimum) hold when the ideal does not fit', !!s3 && iso(s3.start) === iso(t('08:15')) && iso(s3.end) === iso(t('08:50')), s3 && [iso(s3.start), iso(s3.end)]);
  check('slot: no legitimate gap → no hold', findSlot(t('14:00'), req, [{ start: t('08:00'), end: t('13:45') }], D, TZ) === null);
  const s4 = findSlot(t('08:30'), req, [], D, TZ);
  check('slot: respects the working day (8:30 meeting → 8:00–8:20, never earlier)', !!s4 && iso(s4.start) === iso(t('08:00')) && iso(s4.end) === iso(t('08:20')), s4 && [iso(s4.start), iso(s4.end)]);
  check('slot: too early for even the minimum → no hold', findSlot(t('08:20'), req, [], D, TZ) === null);
  check('slot: leaves a buffer before the meeting', (findSlot(t('14:00'), { ...req, preferredLeadMinutes: 0 }, [], D, TZ)?.end ?? 0) <= t('13:50'));
}

// ---- end to end ----
const DATE = '2026-11-01'; // deliberately the DST-change day
const at = (h: number, m = 0) => new Date(zonedMidnight(DATE, TZ).getTime() + (h * 60 + m) * 60_000).toISOString();
const ev = (id: string, summary: string, h: number, mins: number, extra: Record<string, unknown> = {}) =>
  ({ id, summary, status: 'confirmed', start: { dateTime: at(h) }, end: { dateTime: at(h, mins) }, ...extra });
const me = { email: 'rone@example.com', self: true, responseStatus: 'accepted' };
const EVENTS = [
  ev('ext1', 'Acme pricing review', 10, 60, {
    attendees: [me, { email: 'jane@acme.com' }], organizer: { email: 'jane@acme.com' },
    description: 'Agenda: renewal terms. Deck: https://docs.google.com/presentation/d/abc Join: https://meet.google.com/xyz',
  }),
  ev('int1', 'Team standup', 9, 15, { attendees: [me, { email: 'sam@example.com' }], recurringEventId: 'standup', organizer: { self: true } }),
  ev('ext2', 'Intro: Lee (Foo Corp)', 15, 30, { attendees: [me, { email: 'lee@foo.io' }], description: 'Background: https://example.org/lee' }),
  ev('dec1', 'Vendor pitch', 11, 30, { attendees: [{ ...me, responseStatus: 'declined' }, { email: 'x@vendor.com' }] }),
  ev('foc1', 'Focus time', 13, 120, { eventType: 'focusTime' }),
  { id: 'bday1', summary: "Pat's birthday", eventType: 'birthday', start: { date: DATE }, end: { date: addDays(DATE, 1) } },
  ev('other', 'Next-day call', 30, 30, { attendees: [me, { email: 'z@zeta.com' }] }), // outside the window
];

const { url, db } = await freshDb('spike_calprep');
const env = {
  CONNECTION_KEY: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
  GOOGLE_REDIRECT_URI: `http://127.0.0.1:${PORT}/oauth/google/callback`,
  GOOGLE_AUTH_URL: `${EXTERNALS}/google/auth`, GOOGLE_TOKEN_URL: `${EXTERNALS}/google/token`,
  GOOGLE_USERINFO_URL: `${EXTERNALS}/google/userinfo`, GOOGLE_CALENDAR_BASE: `${EXTERNALS}/google/calendar/v3`,
  APP_URL: 'https://ops.example',
};
await fetch(`${EXTERNALS}/google/admin/reset`, { method: 'POST' });
await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify(EVENTS) });
const w = await startWorker({ id: 'calprep-1', port: PORT, dbUrl: url, env });

async function runPrep(requestId: string) {
  const r = await w.http('POST', '/agents/calendar-prep/run', { requestId, date: DATE });
  await waitFor(`run ${requestId}`, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [r.body.workflowID]))?.outcome), 30_000);
  return one(db, `select outcome, error_message, actions_proposed from ops.runs where workflow_id = $1`, [r.body.workflowID]);
}

try {
  const blocked = await runPrep('before-consent');
  check('no Google consent yet → run fails as connection_unavailable (not a crash)', blocked.outcome === 'failed' && /google:primary/.test(blocked.error_message), blocked);

  const start = await w.http('POST', '/connections/google', { id: 'google:primary' });
  const back = (await fetch(start.body.authUrl, { redirect: 'manual' })).headers.get('location')!;
  await fetch(back);

  const run1 = await runPrep('r1');
  check('Run Now succeeds', run1.outcome === 'succeeded', run1);
  const b1 = (await w.http('GET', `/briefs/${DATE}`)).body;
  const ids = (b1.items ?? []).map((i: { eventId: string }) => i.eventId);
  check('window is the local day: 04:00Z → 05:00Z next day (25h DST day)', new Date(b1.time_min).toISOString() === '2026-11-01T04:00:00.000Z'
    && new Date(b1.time_max).toISOString() === '2026-11-02T05:00:00.000Z', [b1.time_min, b1.time_max]);
  check('hard filters dropped declined, focus, birthday; ranker saw the rest', b1.considered === 3
    && ['dec1', 'foc1', 'bday1'].every((id) => b1.filtered.some((f: { eventId: string }) => f.eventId === id)), { considered: b1.considered, filtered: b1.filtered });
  check('brief items = events worth prepping, in start order (internal standup left out)', JSON.stringify(ids) === JSON.stringify(['ext1', 'ext2']), ids);
  const f = b1.items[0].features;
  check('structured features extracted', f.externalAttendees === 1 && f.externalDomains[0] === 'acme.com' && f.hasAgenda && f.docLinks.length === 1
    && f.docLinks[0].includes('docs.google.com') && f.durationMinutes === 60, f);

  const s1 = await gstate();
  const cal = s1.calendars.find((c: { summary: string }) => c.summary === 'Agent Ops');
  const agentOps = (s1.appEvents[cal?.id] ?? []) as Record<string, any>[];
  const mirror = agentOps.find((e) => e.id === b1.mirror_event_id);
  check('mirror is one all-day Agent Ops event: "Prep brief · 2 items" + times + link', b1.mirror_status === 'written' && mirror
    && mirror.summary === 'Prep brief · 2 items' && mirror.start.date === DATE && mirror.end.date === '2026-11-02'
    && /Acme pricing review/.test(mirror.description) && mirror.description.includes(`Open full brief → https://ops.example/app/#/brief/${DATE}`), { b1, mirror });
  check('nothing was ever written to the primary calendar', s1.primaryWrites === 0, s1);

  // Placement is deterministic and uses EVERY blocking event, including ones ranking ignored. (DST day:
  // at(9) is 8:00 local = working-day start; standup at(9)–at(9,15); Focus at(13)–at(15).)
  const holds1 = (await db.query(`select * from ops.actions where logical_action = 'agentops.hold' order by target`)).rows;
  const h1 = holds1.find((h) => h.target === 'ext1');
  const h2 = holds1.find((h) => h.target === 'ext2');
  check('a hold per meeting worth prepping, waiting for approval', holds1.length === 2 && holds1.every((h) => h.status === 'pending_approval')
    && run1.actions_proposed === 2, holds1.map((h) => [h.target, h.status]));
  check('hold avoids the standup and shortens to fit (35 of 45 min ideal)', h1?.payload.start === at(9, 15) && h1?.payload.end === at(9, 50), h1?.payload);
  check('hold avoids the Focus block even though ranking filtered it out', h2?.payload.start === at(12, 15) && h2?.payload.end === at(13), h2?.payload);
  const health = (await w.http('GET', '/health')).body;
  check('Attention Queue shows the brief and the hold approvals', health.attention.some((a: any) => a.kind === 'brief_ready' && a.ref === b1.id)
    && health.attention.some((a: any) => a.kind === 'approval_needed' && a.ref === h1.id), health.attention);

  // Re-run after the calendar changed: same brief row, mirror UPDATED (not duplicated), the still-undecided hold
  // re-placed around the new event (same action, not a new one), and an opened brief stays opened.
  await w.http('POST', `/briefs/${b1.id}/seen`);
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([...EVENTS, ev('new1', 'Quick sync', 9, 25)]) });
  const run2 = await runPrep('r2');
  const b2 = (await w.http('GET', `/briefs/${DATE}`)).body;
  const s2 = await gstate();
  const mirrors = (s2.appEvents[cal.id] as Record<string, any>[]).filter((e) => /^Prep brief/.test(e.summary));
  check('re-run updates the same brief + the same mirror event', run2.outcome === 'succeeded' && b2.id === b1.id && b2.mirror_event_id === b1.mirror_event_id
    && mirrors.length === 1 && s2.eventsUpdated > s1.eventsUpdated, { b2: b2.id, mirrors: mirrors.length, s1, s2 });
  check('an opened brief is not re-raised when its meetings did not change', b2.seen_at !== null, b2.seen_at);
  const h1b = await one(db, `select id, status, payload from ops.actions where id = $1`, [h1.id]);
  const holdCount = await one(db, `select count(*)::int n from ops.actions where logical_action = 'agentops.hold'`);
  check('undecided hold is refreshed in place around the new event (no duplicate)', holdCount.n === 2 && h1b.status === 'pending_approval'
    && h1b.payload.start === at(9, 25) && h1b.payload.end === at(9, 50), { n: holdCount.n, payload: h1b.payload });
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify(EVENTS) });

  // Approve one hold, reject the other.
  const appr = await w.http('POST', `/actions/${h1.id}/approve`);
  await waitFor('hold executed', async () => ['executed', 'failed', 'superseded'].includes((await one(db, `select status from ops.actions where id = $1`, [h1.id])).status), 20_000);
  const done = await one(db, `select status, result, error from ops.actions where id = $1`, [h1.id]);
  const s3 = await gstate();
  const hold = (s3.appEvents[cal.id] as Record<string, any>[]).find((e) => e.id === done.result?.eventId);
  check('approved hold re-checks availability, is still free, and is written to Agent Ops', appr.status === 200 && done.status === 'executed'
    && hold?.summary === 'Prep: Acme pricing review' && hold?.start.dateTime === at(9, 25) && hold?.end.dateTime === at(9, 50), { done, hold });
  await w.http('POST', `/actions/${h2.id}/reject`);

  // Deeper prep on one item; asking twice is the same workflow.
  const d1 = await w.http('POST', `/briefs/${b1.id}/items/ext2/deeper`);
  const d2 = await w.http('POST', `/briefs/${b1.id}/items/ext2/deeper`);
  await waitFor('deeper prep', async () => Boolean((await one(db, `select content from ops.brief_deeper where brief_id = $1 and event_id = 'ext2'`, [b1.id]))?.content), 20_000);
  const b3 = (await w.http('GET', `/briefs/${b1.id}`)).body;
  check('request deeper prep stores a second pass on that item (idempotent request)', d1.status === 202 && d1.body.workflowID === d2.body.workflowID
    && /Mock deeper prep/.test(b3.deeper?.ext2?.content ?? ''), { d1: d1.body, deeper: b3.deeper });
  const needsDeeper = ((await w.http('GET', '/attention')).body as any[]).find((i) => i.type === 'deeper_ready');
  check('"Deeper prep ready" appears in Needs You until the brief is opened', needsDeeper?.ref === `${b1.id}/ext2` && needsDeeper.actions.map((a: any) => a.id).join() === 'open,dismiss', needsDeeper);
  await w.http('POST', `/briefs/${b1.id}/seen`);
  check('…and opening the brief clears it', !((await w.http('GET', '/attention')).body as any[]).some((i) => i.type === 'deeper_ready'));
  const bad = await w.http('POST', `/briefs/${b1.id}/items/int1/deeper`);
  check('deeper prep only for items in the brief', bad.status === 404, bad);

  // Dismiss / not useful is recorded, and the next ranking pass sees it.
  const fb = await w.http('POST', `/briefs/${b1.id}/items/ext2/feedback`, { verdict: 'not_useful' });
  const b4 = (await w.http('GET', `/briefs/${b1.id}`)).body;
  check('feedback recorded', fb.status === 200 && b4.feedback?.ext2 === 'not_useful', b4.feedback);

  // ---- the 8 PM rerun over a day that already has owner decisions ----
  await w.http('POST', `/briefs/${b1.id}/seen`);
  const before = await gstate();
  const runS = await runPrep('rerun-after-decisions');
  const bS = (await w.http('GET', `/briefs/${DATE}`)).body;
  const after = await gstate();
  const acts = (await db.query(`select target, status from ops.actions where logical_action = 'agentops.hold' order by created_at`)).rows;
  const itemHold = (id: string) => bS.items.find((i: any) => i.eventId === id)?.hold?.status;
  check('rerun: rejected hold is not resurrected, approved hold is not re-proposed', runS.outcome === 'succeeded'
    && JSON.stringify(acts) === JSON.stringify([{ target: 'ext1', status: 'executed' }, { target: 'ext2', status: 'rejected' }])
    && runS.actions_proposed === 0, { acts, proposed: runS.actions_proposed });
  check('rerun: the brief shows the owner\'s decisions on each meeting', itemHold('ext1') === 'executed' && itemHold('ext2') === 'rejected', bS.items.map((i: any) => [i.eventId, i.hold]));
  check('rerun: deeper prep and "Not useful" survive', /Mock deeper prep/.test(bS.deeper?.ext2?.content ?? '') && bS.feedback?.ext2 === 'not_useful', { deeper: bS.deeper, feedback: bS.feedback });
  check('rerun: one mirror, updated in place; opened brief stays opened', bS.mirror_event_id === b1.mirror_event_id && bS.seen_at !== null
    && (after.appEvents[cal.id] as any[]).filter((e) => /^Prep brief/.test(e.summary) && e.status !== 'cancelled').length === 1
    && after.eventsInserted === before.eventsInserted, { inserted: [before.eventsInserted, after.eventsInserted] });

  // ---- the meeting-card view: owner state joined onto the brief, provenance-labelled sources ----
  const card = (v: any, id: string) => v.cards.find((c: any) => c.eventId === id);
  check('card view: "Not useful" collapses the meeting into the dismissed section', !card(bS, 'ext2') && bS.dismissedCards.some((d: any) => d.eventId === 'ext2') && bS.editable, { cards: bS.cards.map((c: any) => c.eventId), dismissed: bS.dismissedCards });
  const c1 = card(bS, 'ext1');
  check('card view: hold status comes from the ACTION (approved ✓), not the brief text', c1?.hold?.status === 'approved' && c1.hold.actionId === h1.id, c1?.hold);
  check('card view: sources are event links only, labelled by provenance; meeting links excluded', JSON.stringify(c1?.sources) === JSON.stringify([
    { url: 'https://docs.google.com/presentation/d/abc', label: 'Google Slides', provenance: 'event' }]), c1?.sources);
  await w.http('POST', `/briefs/${b1.id}/items/ext2/feedback`, { verdict: 'clear' });
  const bU = (await w.http('GET', `/briefs/${DATE}`)).body;
  const c2 = card(bU, 'ext2');
  check('Undo restores the card with its history (rejected hold, deeper prep)', c2?.hold?.status === 'rejected' && c2.deeper.status === 'ready'
    && /Mock deeper prep/.test(c2.deeper.content) && bU.dismissedCards.length === 0, c2);

  {
    const D3 = '2026-11-05';
    const ev3 = { id: 'nu1', summary: 'Vendor demo', status: 'confirmed', start: { dateTime: zonedTime(D3, '15:00', TZ).toISOString() },
      end: { dateTime: zonedTime(D3, '16:00', TZ).toISOString() }, attendees: [me, { email: 'sales@vendor.io' }], description: 'Deck: https://example.org/deck' };
    await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([ev3]) });
    const run = async (rid: string) => {
      const r = await w.http('POST', '/agents/calendar-prep/run', { requestId: rid, date: D3 });
      await waitFor(rid, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [r.body.workflowID]))?.outcome), 30_000);
    };
    await run('d3-a');
    const v3 = (await w.http('GET', `/briefs/${D3}`)).body;
    const pend = card(v3, 'nu1')?.hold;
    check('card view: a pending hold carries its ACTION id for inline Approve/Reject', pend?.status === 'pending' && Boolean(pend.actionId), pend);
    await w.http('POST', `/briefs/${v3.id}/items/nu1/feedback`, { verdict: 'not_useful' });
    const after = await one(db, `select status, error from ops.actions where id = $1`, [pend?.actionId]);
    const approvals = ((await w.http('GET', '/attention')).body as any[]).filter((i) => i.type === 'approval_needed' && i.ref === pend?.actionId);
    check('"Not useful" withdraws the undecided hold (gone from Needs You)', after.status === 'superseded' && approvals.length === 0, after);
    await run('d3-b');
    const n3 = await one(db, `select count(*)::int n from ops.actions where target = 'nu1' and status = 'pending_approval'`);
    check('…and the next run does not propose one for that meeting again', n3.n === 0, n3);
  }

  // ---- approval long after the proposal: the slot is re-checked when the action executes ----
  const D2 = '2026-11-03';
  const at2 = (hhmm: string) => zonedTime(D2, hhmm, TZ).toISOString();
  const ev2 = (id: string, summary: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
    ({ id, summary, status: 'confirmed', start: { dateTime: at2(from) }, end: { dateTime: at2(to) }, ...extra });
  const board = ev2('brd1', 'Board review', '14:00', '15:00', { attendees: [me, { email: 'chair@board.org' }], description: 'Pack: https://example.org/pack' });
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([board]) });
  const rD2 = await w.http('POST', '/agents/calendar-prep/run', { requestId: 'd2', date: D2 });
  await waitFor('d2 run', async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [rD2.body.workflowID]))?.outcome), 30_000);
  const p1 = await one(db, `select id, payload from ops.actions where target = 'brd1'`);
  check('proposal for the board review: 12:45–1:30 PM', p1?.payload.start === at2('12:45') && p1?.payload.end === at2('13:30'), p1?.payload);
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([board, ev2('l1', 'Lunch', '12:30', '13:40')]) });
  await w.http('POST', `/actions/${p1.id}/approve`);
  await waitFor('moved', async () => (await one(db, `select status from ops.actions where id = $1`, [p1.id])).status !== 'approved', 20_000);
  const moved = await one(db, `select status, error from ops.actions where id = $1`, [p1.id]);
  const repl = await one(db, `select id, status, payload from ops.actions where target = 'brd1' and id <> $1`, [p1.id]);
  const s5 = await gstate();
  check('slot taken by approval time → nothing written blindly; a new slot is proposed for approval', moved.status === 'superseded'
    && repl?.status === 'pending_approval' && repl.payload.start === at2('11:45') && repl.payload.end === at2('12:30') && repl.payload.movedFrom === at2('12:45')
    && !(s5.appEvents[cal.id] as any[]).some((e) => e.summary === 'Prep: Board review'), { moved, repl: repl?.payload });
  const moveItem = ((await w.http('GET', '/attention')).body as any[]).find((i) => i.ref === repl?.id);
  check('the moved proposal is back in Needs You and says why', /moved: the earlier slot was taken/.test(moveItem?.summary ?? ''), moveItem);
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify([board, ev2('l1', 'Lunch', '12:30', '13:40'), ev2('ws', 'Workshop', '08:00', '12:30')]) });
  await w.http('POST', `/actions/${repl.id}/approve`);
  await waitFor('no slot', async () => (await one(db, `select status from ops.actions where id = $1`, [repl.id])).status !== 'approved', 20_000);
  const failed = await one(db, `select status, error from ops.actions where id = $1`, [repl.id]);
  const failItem = ((await w.http('GET', '/attention')).body as any[]).find((i) => i.ref === repl.id);
  check('no free time left → the hold fails visibly instead of wedging in somewhere', failed.status === 'failed' && /no longer free/.test(failed.error)
    && failItem?.title === 'Prep hold no longer fits', { failed, failItem });

  // A day with nothing worth prepping removes that day's mirror instead of leaving a stale one.
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify(EVENTS.filter((e) => e.id === 'int1')) });
  const run3 = await runPrep('r3');
  const b5 = (await w.http('GET', `/briefs/${DATE}`)).body;
  const s4 = await gstate();
  const m5 = (s4.appEvents[cal.id] as Record<string, any>[]).find((e) => e.id === b1.mirror_event_id);
  check('nothing to prep → empty brief, mirror removed', run3.outcome === 'succeeded' && b5.items.length === 0 && b5.mirror_status === 'removed' && (!m5 || m5.status === 'cancelled'), { b5, m5 });

  // Mirror failure is recorded and surfaced, the brief still saved.
  await fetch(`${EXTERNALS}/google/admin/events`, { method: 'POST', body: JSON.stringify(EVENTS) });
  await db.query(`update ops.connections set metadata = metadata || '{"agentOpsCalendarId":"gone@group.calendar.google.com"}' where id = 'google:primary'`);
  const run4 = await runPrep('r4');
  const b6 = (await w.http('GET', `/briefs/${DATE}`)).body;
  check('stale calendar id → re-adopts Agent Ops and writes the mirror again', run4.outcome === 'succeeded' && b6.mirror_status === 'written' && b6.items.length === 2, b6);
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall calendar prep checks passed');
process.exit(failures.length ? 1 : 0);
