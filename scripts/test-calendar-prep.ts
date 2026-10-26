// Calendar Prep V1 end to end against the fake Google + scripted model.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-calendar-prep.ts
import { randomBytes } from 'node:crypto';
import { EXTERNALS, freshDb, killAllWorkers, one, startWorker, waitFor } from './lib.js';
import { addDays, localDate, zonedMidnight } from '../src/localDay.js';

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
  ev('ext2', 'Intro: Lee (Foo Corp)', 15, 30, { attendees: [me, { email: 'lee@foo.io' }] }),
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
    && /Acme pricing review/.test(mirror.description) && mirror.description.includes(`Open full brief → https://ops.example/briefs/${DATE}`), { b1, mirror });
  check('nothing was ever written to the primary calendar', s1.primaryWrites === 0, s1);

  const holds1 = (await db.query(`select * from ops.actions where logical_action = 'agentops.hold'`)).rows;
  check('one hold proposed (doc-heavy meeting), waiting for approval', holds1.length === 1 && holds1[0].status === 'pending_approval'
    && holds1[0].target === 'ext1' && run1.actions_proposed === 1, holds1);
  const health = (await w.http('GET', '/health')).body;
  check('Attention Queue shows the brief and the hold approval', health.attention.some((a: any) => a.kind === 'brief_ready' && a.ref === b1.id)
    && health.attention.some((a: any) => a.kind === 'approval_needed' && a.ref === holds1[0].id), health.attention);

  // Re-run the same day: same brief row, mirror UPDATED (not duplicated), hold not re-proposed.
  await w.http('POST', `/briefs/${b1.id}/seen`);
  const run2 = await runPrep('r2');
  const b2 = (await w.http('GET', `/briefs/${DATE}`)).body;
  const s2 = await gstate();
  const mirrors = (s2.appEvents[cal.id] as Record<string, any>[]).filter((e) => /^Prep brief/.test(e.summary));
  check('re-run updates the same brief + the same mirror event', run2.outcome === 'succeeded' && b2.id === b1.id && b2.mirror_event_id === b1.mirror_event_id
    && mirrors.length === 1 && s2.eventsUpdated > s1.eventsUpdated && b2.seen_at === null, { b2: b2.id, mirrors: mirrors.length, s1, s2 });
  const holds2 = await one(db, `select count(*)::int n from ops.actions where logical_action = 'agentops.hold'`);
  check('re-run does not propose the same hold twice', holds2.n === 1, holds2);

  // Approve the hold → executor writes it on Agent Ops with a deterministic event ID.
  const appr = await w.http('POST', `/actions/${holds1[0].id}/approve`);
  await waitFor('hold executed', async () => ['executed', 'failed'].includes((await one(db, `select status from ops.actions where id = $1`, [holds1[0].id])).status), 20_000);
  const done = await one(db, `select status, result, error from ops.actions where id = $1`, [holds1[0].id]);
  const s3 = await gstate();
  const hold = (s3.appEvents[cal.id] as Record<string, any>[]).find((e) => e.id === done.result?.eventId);
  check('approved hold is executed onto Agent Ops, ending 15 min before the meeting', appr.status === 200 && done.status === 'executed' && Boolean(hold)
    && hold?.summary === 'Prep: Acme pricing review' && hold?.end.dateTime === at(9, 45) && hold?.start.dateTime === at(9, 15), { done, hold });

  // Deeper prep on one item; asking twice is the same workflow.
  const d1 = await w.http('POST', `/briefs/${b1.id}/items/ext2/deeper`);
  const d2 = await w.http('POST', `/briefs/${b1.id}/items/ext2/deeper`);
  await waitFor('deeper prep', async () => Boolean((await one(db, `select content from ops.brief_deeper where brief_id = $1 and event_id = 'ext2'`, [b1.id]))?.content), 20_000);
  const b3 = (await w.http('GET', `/briefs/${b1.id}`)).body;
  check('request deeper prep stores a second pass on that item (idempotent request)', d1.status === 202 && d1.body.workflowID === d2.body.workflowID
    && /Mock deeper prep/.test(b3.deeper?.ext2?.content ?? ''), { d1: d1.body, deeper: b3.deeper });
  const bad = await w.http('POST', `/briefs/${b1.id}/items/int1/deeper`);
  check('deeper prep only for items in the brief', bad.status === 404, bad);

  // Dismiss / not useful is recorded, and the next ranking pass sees it.
  const fb = await w.http('POST', `/briefs/${b1.id}/items/ext2/feedback`, { verdict: 'not_useful' });
  const b4 = (await w.http('GET', `/briefs/${b1.id}`)).body;
  check('feedback recorded', fb.status === 200 && b4.feedback?.ext2 === 'not_useful', b4.feedback);

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
