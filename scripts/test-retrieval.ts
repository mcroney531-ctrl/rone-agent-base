// Calendar Prep retrieval rules (pure; no database, no Google): identity by address, thread relevance,
// meeting history, citation checks and rendering. Usage: npx tsx scripts/test-retrieval.ts
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused'; // modules import the pool; nothing here connects
const { people, meetingHistory, rankThreads } = await import('../src/retrieval.js');
const { checkClaims, renderDeeper, sourceIndex } = await import('../src/calendarPrep.js');

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const ME = 'rone@example.com';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const day = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

// ---- people: addresses only; me, rooms and calendar group addresses excluded; external first ----
const ev = (attendees: object[]) => ({ id: 'e', summary: 'x', start: { dateTime: day(-1) }, end: { dateTime: day(-1) }, attendees }) as never;
check('people: other attendees by address, external first, never me/rooms', JSON.stringify(people(ev([
  { email: ME, self: true }, { email: 'sam@example.com' }, { email: 'Jane@Acme.com' }, { email: 'room-1@resource.calendar.google.com', resource: true },
  { email: 'team@group.calendar.google.com' }]), ME)) === JSON.stringify(['jane@acme.com', 'sam@example.com']));

// ---- meeting history: shared ADDRESS, not display name; declined ones don't count ----
const past = (id: string, d: number, who: string, extra: object = {}) =>
  ({ id, summary: id, status: 'confirmed', start: { dateTime: day(d) }, end: { dateTime: day(d) }, attendees: [{ email: ME, self: true }, { email: who, displayName: 'Jane Doe' }], ...extra }) as never;
const h = meetingHistory([past('p1', 20, 'jane@acme.com'), past('p2', 5, 'jane@acme.com'), past('p3', 3, 'jane@other.org'),
  past('p4', 2, 'jane@acme.com', { attendees: [{ email: ME, self: true, responseStatus: 'declined' }, { email: 'jane@acme.com' }] })], ['jane@acme.com'], ME);
check('history: matched by address (namesake excluded), declined skipped, newest first', h.count === 2 && h.refs.map((r) => r.title).join() === 'p2,p1' && h.refs[0].id === 'm1', h);

// ---- thread relevance: participant overlap + recency + owner involvement + awaiting the owner ----
const m = (id: string, threadId: string, d: number, from: string, body: string, to = ME, cc = '') =>
  ({ id, threadId, labelIds: [], receivedAt: day(d), from, fromName: null, fromAddr: from, replyTo: null, to, cc, subject: `S-${threadId}`, messageIdHeader: null,
    references: null, listUnsubscribe: false, precedence: null, autoSubmitted: null, snippet: body, body });
const ranked = rankThreads([
  m('a1', 'recentNoise', 0, 'jane@acme.com', 'fyi newsletter', 'list@acme.com'),            // recent, shared, but owner not involved
  m('b1', 'both', 9, 'lee@foo.io', 'Can you both confirm the scope?', `${ME}, jane@acme.com`), // two shared people + asks the owner
  m('c1', 'answered', 4, ME, 'Done, sent it.', 'jane@acme.com'),
  m('c2', 'answered', 5, 'jane@acme.com', 'Can you send it?'),
  m('x1', 'stranger', 0, 'bob@else.com', 'hi?'),                                             // no shared participant
], ['jane@acme.com', 'lee@foo.io'], ME, NOW);
check('threads: overlap and an open question beat bare recency; strangers excluded', ranked.map((t) => t.subject).join() === 'S-both,S-answered,S-recentNoise', ranked.map((t) => t.subject));
check('threads: "awaiting the owner" only when the last word is someone else asking', ranked[0].awaitingOwner && !ranked[1].awaitingOwner && ranked[1].messages[0].authorIsOwner);
check('threads: quoted history is stripped from excerpts', !rankThreads([m('q', 'q', 1, 'jane@acme.com', 'New point here.\n\nOn Mon, Jane wrote:\n> old stuff')], ['jane@acme.com'], ME, NOW)[0].messages[0].excerpt.includes('old stuff'));

// ---- citations: facts need sources; the owner's commitment needs the owner's own email ----
const ctx = {
  people: [], metBeforeCount: 1, priorBriefs: [], status: { calendar: 'ok', email: 'ok', briefs: 'ok' },
  meetingHistory: [{ id: 'm1', date: '2026-10-14', title: 'Pricing check-in', shared: [] }],
  emailThreads: [{ id: 't1', subject: 'Pricing', lastDate: '2026-10-29', shared: [], ownerInvolved: true, awaitingOwner: true, messages: [
    { id: 't1.1', date: '2026-10-29', author: 'Jane Doe <jane@acme.com>', authorIsOwner: false, excerpt: 'Can you send pricing by Friday?' },
    { id: 't1.2', date: '2026-10-28', author: 'Rone <rone@example.com>', authorIsOwner: true, excerpt: "I'll send the SOW Monday." }] }],
} as never;
const idx = sourceIndex(ctx);
const c = (text: string, kind: string, sources: string[], by: string | null = null) => ({ text, kind, by, sources }) as never;
const { kept, problems } = checkClaims({
  context: [c('Jane asked for pricing by Friday.', 'request', ['t1.1'], 'other'), c('Met Oct 14.', 'fact', ['m1']), c('Budget is 50k.', 'fact', []),
    c('Owner promised pricing Friday.', 'commitment', ['t1.1'], 'owner'), c('Owner will send the SOW Monday.', 'commitment', ['t1.2'], 'owner'),
    c('Made up.', 'fact', ['t9.9'])],
  outcome: [c('Leave with a pricing decision.', 'suggestion', [])], questions: [], risks: [c('Pricing is likely still open.', 'inference', ['t1.1'])],
}, idx);
check('checkClaims: unsourced facts, unknown ids and a request passed off as the owner\'s promise are dropped',
  JSON.stringify(problems.map((p) => p.problem)) === JSON.stringify(['unsourced', 'owner_commitment_unsupported', 'unknown_source']), problems);
check('checkClaims: sourced facts/requests, the owner\'s real commitment, suggestions and inferences are kept',
  kept.context.length === 3 && kept.outcome.length === 1 && kept.risks.length === 1, kept);
const md = renderDeeper(kept, idx);
check('render: dated citations by name; inference marked "Likely"; suggestions uncited', /Jane asked for pricing by Friday\. _\(Email Oct 29, Jane Doe\)_/.test(md)
  && /SOW Monday\. _\(Email Oct 28, you\)_/.test(md) && /- Likely: Pricing is likely still open\./.test(md) && /- Leave with a pricing decision\.$/m.test(md), md);

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall retrieval checks passed');
process.exit(failures.length ? 1 : 0);
