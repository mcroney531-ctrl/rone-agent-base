// Research Watch (producer #4) + the feed source, end to end against fake feeds + the scripted model.
// GPT's acceptance bar for B:
//   configure a non-Google source · checkpoint survives deploys · repeated polling never duplicates work ·
//   a source erroring/vanishing never corrupts state · changed vs already-seen content · per-source pause ·
//   provenance on every card · remove/re-add never replays history (backfill only on request, same pipeline)
// plus: the revision race (rev 1 judged while rev 2 arrives → rev 2 never inherits rev 1's judgment), feed
// churn without semantic change, XML/fetch hardening (DOCTYPE, decompressed size cap, SSRF/redirects), and
// the per-source surfacing ceiling.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-feed-watch.ts
process.env.FEED_ALLOW_INSECURE = '1';
process.env.FEED_ALLOW_HOSTS = '127.0.0.1';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { AttentionItemSchema } from '../src/compat.js';
import { checkUrl, contentHash, FeedError, fetchFeed, isBlockedAddress, normalizeText, parseFeed } from '../src/connections/feed.js';
import { EXTERNALS, LOG_DIR, all, freshDb, killAllWorkers, one, startWorker, waitFor, type Worker } from './lib.js';

const PORT = 7890;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const post = (p: string, body?: unknown) => fetch(`${EXTERNALS}${p}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
type It = { id: string; title: string; text: string; link?: string; date?: string };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rss = (title: string, items: It[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${esc(title)}</title><link>https://example.org/</link>${items.map((i) =>
  `<item><guid>${i.id}</guid><title>${esc(i.title)}</title><link>${i.link ?? `https://example.org/${i.id}`}</link><pubDate>${i.date ?? 'Mon, 09 Nov 2026 12:00:00 GMT'}</pubDate><description>${esc(i.text)}</description></item>`).join('')}</channel></rss>`;
const setFeed = (name: string, b: Record<string, unknown>) => post(`/feeds/admin/set/${name}`, b);
const feedUrl = (name: string) => `${EXTERNALS}/feeds/${name}`;

// ======================= part 1: the adapter, in-process =======================
{
  const a = parseFeed(rss('Blog', [{ id: 'x1', title: 'Hello', text: '<p>Some <b>bold</b>   text</p>' }]));
  check('RSS 2.0 parses: title, key, link, normalized text', a.kind === 'rss' && a.title === 'Blog' && a.items[0].key === 'x1' && a.items[0].text === 'Some bold text' && a.items[0].link === 'https://example.org/x1', a);
  const atom = parseFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title><link href="https://a.example/"/><entry><id>tag:a,1</id><title>Post</title><link rel="alternate" href="https://a.example/p"/><updated>2026-11-01T00:00:00Z</updated><content type="html">&lt;p&gt;Body&lt;/p&gt;</content></entry></feed>`);
  check('Atom parses (id, alternate link, html content → text)', atom.kind === 'atom' && atom.items[0].key === 'tag:a,1' && atom.items[0].link === 'https://a.example/p' && atom.items[0].text === 'Body', atom);
  const rdf = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel rdf:about="x"><title>RDF</title></channel><item rdf:about="https://r.example/1"><title>One</title><link>https://r.example/1</link></item></rdf:RDF>`);
  check('RSS 1.0 (RDF) parses', rdf.kind === 'rdf' && rdf.items[0].key === 'https://r.example/1', rdf);

  // Feed churn without semantic change → same hash. The pinned definition: normalized title + body text only.
  const base = { id: 'c1', title: 'Durable agents', text: '<p>Version 2 is out.</p>' };
  const h0 = parseFeed(rss('B', [base, { id: 'c2', title: 'Other', text: 'x' }])).items.find((i) => i.key === 'c1')!.contentHash;
  const churn = [
    ['reordered items', rss('B', [{ id: 'c2', title: 'Other', text: 'x' }, base])],
    ['whitespace-only', rss('B', [{ ...base, text: '<p>Version   2 is\n out. </p>' }])],
    ['markup-only', rss('B', [{ ...base, text: '<div><span>Version 2 is out.</span></div>' }])],
    ['link tracking params', rss('B', [{ ...base, link: 'https://example.org/c1?utm_source=rss' }])],
    ['date bumped', rss('B', [{ ...base, date: 'Tue, 10 Nov 2026 08:00:00 GMT' }])],
    ['entity spelling', rss('B', [{ ...base, text: '<p>Version&#32;2 is out.</p>' }])],
  ] as const;
  for (const [what, xml] of churn) {
    const h = parseFeed(xml).items.find((i) => i.key === 'c1')!.contentHash;
    check(`churn without semantic change (${what}) → same contentHash`, h === h0, { h, h0 });
  }
  check('a real text edit → different contentHash', parseFeed(rss('B', [{ ...base, text: 'Version 3 is out.' }])).items[0].contentHash !== h0);
  check('a title edit → different contentHash', parseFeed(rss('B', [{ ...base, title: 'Durable agents v3' }])).items[0].contentHash !== h0);
  check('contentHash is pinned (v1 = sha256 of version, title, text)', contentHash('T', 'x') === contentHash('T', 'x') && contentHash('T', 'x') !== contentHash('T', 'x '), null);

  // XML hardening.
  const bad = async (what: string, xml: string) => {
    try { parseFeed(xml); check(`${what} → refused`, false, 'parsed'); } catch (e) { check(`${what} → refused`, e instanceof FeedError && e.kind === 'invalid', (e as Error).message); }
  };
  await bad('DOCTYPE with an external entity', `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>`);
  await bad('billion-laughs entity expansion', `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><rss><channel><title>&b;</title></channel></rss>`);
  await bad('HTML page (not a feed)', '<html><body>hello</body></html>');
  await bad('malformed XML', '<rss><channel><title>oops</channel>');
  check('normalizeText strips script/style and tags', normalizeText('<style>x{}</style><script>alert(1)</script><p>Hi &amp; bye</p>') === 'Hi & bye');

  // Address policy.
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) {
    check(`address ${ip} is blocked`, isBlockedAddress(ip));
  }
  check('public addresses are allowed', !isBlockedAddress('93.184.216.34') && !isBlockedAddress('2606:4700::1111'));
  const refused = (fn: () => unknown, kind: string) => { try { fn(); return false; } catch (e) { return e instanceof FeedError && e.kind === kind; } };
  check('credentials in the URL are refused', refused(() => checkUrl('https://u:p@example.org/feed'), 'blocked'));
  check('a literal private IP is refused before connecting', refused(() => checkUrl('http://10.0.0.5/feed'), 'blocked'));
  check('non-http(s) schemes are refused', refused(() => checkUrl('file:///etc/passwd'), 'blocked'));

  // Fetch hardening against the fake feed server (127.0.0.1 is the one allowed private host here).
  await post('/feeds/admin/reset');
  await setFeed('bomb', { body: '<rss>' + ' '.repeat(3 * 1024 * 1024) + '</rss>', gzip: true });
  const gz = zlib.gzipSync(Buffer.from(' '.repeat(3 * 1024 * 1024))).length;
  try { await fetchFeed(feedUrl('bomb')); check('a 3 MB body compressed to a few KB is refused (cap is on DECOMPRESSED bytes)', false); }
  catch (e) { check(`a 3 MB body compressed to ${Math.round(gz / 1024)} KB is refused (cap is on DECOMPRESSED bytes)`, e instanceof FeedError && e.kind === 'too_large', (e as Error).message); }
  for (const [name, to] of [['to-metadata', 'http://169.254.169.254/latest/meta-data/'], ['to-private', 'http://10.0.0.7/feed'], ['to-other-loopback', 'http://127.0.0.2:7801/feeds/ok']] as const) {
    await setFeed(name, { redirectTo: to });
    try { await fetchFeed(feedUrl(name)); check(`redirect ${name} → refused`, false); }
    catch (e) { check(`redirect ${name} (${to}) → refused at the hop`, e instanceof FeedError && e.kind === 'blocked', (e as Error).message); }
  }
  // A HOSTNAME that resolves to a private address is refused by the socket's own lookup (no rebinding gap).
  process.env.FEED_ALLOW_HOSTS = '';
  try { await fetchFeed('http://localhost:7801/feeds/bomb'); check('a hostname resolving to loopback is refused at connect', false); }
  catch (e) { check('a hostname resolving to loopback is refused at connect (DNS checked by the socket)', e instanceof FeedError && e.kind === 'blocked', (e as Error).message); }
  process.env.FEED_ALLOW_HOSTS = '127.0.0.1';
  await setFeed('loop1', { redirectTo: feedUrl('loop2') }); await setFeed('loop2', { redirectTo: feedUrl('loop1') });
  try { await fetchFeed(feedUrl('loop1')); check('redirect loop → refused', false); } catch (e) { check('redirect loop → refused after 3 hops', e instanceof FeedError && /too many redirects/.test(e.message), (e as Error).message); }
  await setFeed('slow', { body: rss('S', []), delayMs: 1500 });
  try { await fetchFeed(feedUrl('slow'), {}, { maxBytes: 2 * 1024 * 1024, timeoutMs: 500, maxRedirects: 3, maxItems: 200, textChars: 4000 }); check('a slow source times out', false); }
  catch (e) { check('a slow source times out', e instanceof FeedError && e.kind === 'timeout', (e as Error).message); }
}

// ======================= part 2: the producer, through a real worker =======================
const { url, db } = await freshDb('spike_feed_watch');
const feedLog = path.join(LOG_DIR, 'feed-judge-calls.log');
fs.rmSync(feedLog, { force: true });
const env = { API_TOKEN: 'api-secret', CONNECTION_KEY: randomBytes(32).toString('base64'), FEED_ALLOW_INSECURE: '1', FEED_ALLOW_HOSTS: '127.0.0.1', MOCK_FEED_LOG: feedLog };
await post('/feeds/admin/reset');
let w: Worker = await startWorker({ id: 'feed-1', port: PORT, dbUrl: url, env });
let wid = 1;
async function restart(extra: Record<string, string> = {}) {
  if (w.proc.exitCode === null && w.proc.signalCode === null) await w.kill();
  w = await startWorker({ id: `feed-${++wid}`, port: PORT, dbUrl: url, env: { ...env, ...extra } });
}
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { authorization: 'Bearer api-secret', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;
const startRun = async () => (await call('POST', '/agents/research-watch/run', { requestId: `r${++seq}` })).body.workflowID as string;
const runDone = (wf: string, ms = 30_000) => waitFor(`run ${wf}`, async () => Boolean((await one(db, `select outcome from ops.runs where workflow_id = $1`, [wf]))?.outcome), ms);
async function run() { const wf = await startRun(); await runDone(wf); return one(db, `select outcome, error_message from ops.runs where workflow_id = $1`, [wf]); }
const judgeCalls = () => (fs.existsSync(feedLog) ? fs.readFileSync(feedLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [wf, refs] = l.split('\t'); return { wf, refs: refs ? refs.split(',') : [] }; }) : []);
const timesJudged = (ref: string) => judgeCalls().filter((c) => c.refs.includes(ref)).length;
const attention = async () => (await call('GET', '/attention')).body as { type: string; ref: string; title: string; summary: string; source: string; actions: { id: string; url?: string }[] }[];
const cards = async () => (await attention()).filter((i) => i.type === 'feed_item');
const item = (src: string, key: string) => one(db, `select * from ops.feed_items where connection_id = $1 and item_key = $2`, [src, key]);
const hits = async (name: string) => ((await (await fetch(`${EXTERNALS}/feeds/admin/state`)).json())[name] ?? { hits: 0, notModified: 0 });

try {
  // ---- configure a non-Google source ----
  await call('PUT', '/sources/interests', { interests: 'AI agents, durable workflows, Postgres' });
  const A: It[] = [
    { id: 'a1', title: 'Weekly roundup', text: 'Links about gardening.' },
    { id: 'a2', title: 'Agents in production', text: 'An old post about agents.' },
    { id: 'a3', title: 'Cooking notes', text: 'Soup.' },
  ];
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  const add = await call('POST', '/sources', { url: feedUrl('alpha') });
  const srcA = add.body.id as string;
  check('adding a feed validates it, names it from the feed, and baselines what is there', add.status === 201 && add.body.title === 'Alpha Blog' && add.body.baselined === 3 && /^feed:/.test(srcA), add.body);
  const conn = await one(db, `select provider, status, account_label from ops.connections where id = $1`, [srcA]);
  const link = await one(db, `select required, scopes from ops.agent_connections where agent_id = 'research-watch' and connection_id = $1`, [srcA]);
  check('…as a connection with different semantics: provider feed, no secret, not required (one bad source never blocks the agent)',
    conn.provider === 'feed' && conn.status === 'active' && link.required === false && link.scopes.length === 0
    && !(await one(db, `select 1 as x from ops.connection_secrets where connection_id = $1`, [srcA])), { conn, link });
  const badAdd = await call('POST', '/sources', { url: `${EXTERNALS}/feeds/nope` });
  check('adding something that is not a reachable feed is refused clearly', badAdd.status === 400 && /Couldn't add/.test(badAdd.body.error), badAdd);
  const ssrfAdd = await call('POST', '/sources', { url: 'http://169.254.169.254/latest/meta-data/' });
  check('adding a private address is refused (SSRF)', ssrfAdd.status === 400, ssrfAdd);

  const r0 = await run();
  check('the first run after adding surfaces nothing and judges nothing (no history flood)', r0.outcome === 'succeeded' && (await cards()).length === 0 && judgeCalls().length === 0, { r0, calls: judgeCalls() });

  // ---- new items → judged → one card with provenance; repeated polling duplicates nothing ----
  A.push({ id: 'a4', title: 'Durable agents 2.0 released', text: 'The release adds Postgres-backed checkpoints.', link: 'https://example.org/a4' });
  A.push({ id: 'a5', title: 'Holiday hours', text: 'We are closed Friday.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  await run();
  let cs = await cards();
  const a4 = await item(srcA, 'a4');
  check('two new items → both judged once, the relevant one surfaces', cs.length === 1 && /New from Alpha Blog: Durable agents 2\.0 released/.test(cs[0].title)
    && timesJudged(`${a4.id}@1`) === 1 && (await item(srcA, 'a5')).relevant === false, { cs, calls: judgeCalls() });
  check('…the card carries why + an Open link to the item', /Covers/.test(cs[0].summary) && cs[0].actions.find((x) => x.id === 'open')?.url === 'https://example.org/a4', cs[0]);
  const det = (await call('GET', `/attention/feed_item/${cs[0].ref}`)).body;
  const facts = Object.fromEntries((det.facts ?? []).map((f: { label: string; value: string }) => [f.label, f.value]));
  check('…and full provenance in the drill-in (source, feed URL, link, revision, item id)', facts.Source === 'Alpha Blog' && facts.Feed === feedUrl('alpha')
    && facts.Link === 'https://example.org/a4' && facts.Revision === '1' && facts['Item id'] === 'a4', facts);
  check('every card parses through the app contract', cs.every((i) => AttentionItemSchema.safeParse(i).success));
  const before = judgeCalls().length;
  const nm0 = (await hits('alpha')).notModified;
  await run(); await run();
  check('repeated polling: conditional GET answers 304, nothing re-judged, no new card', judgeCalls().length === before && (await hits('alpha')).notModified >= nm0 + 2 && (await cards()).length === 1,
    { calls: judgeCalls().length, before, hits: await hits('alpha') });

  // ---- churn without semantic change → no "Updated" ----
  const churned = [...A].reverse().map((i) => (i.id === 'a4' ? { ...i, text: `<p>The   release adds <b>Postgres-backed</b> checkpoints.</p>`, link: 'https://example.org/a4?utm_source=rss', date: 'Tue, 10 Nov 2026 09:00:00 GMT' } : i));
  await setFeed('alpha', { body: rss('Alpha Blog', churned) });
  await run();
  check('reorder + whitespace + markup + tracking link + date bump → no new revision, no re-judgment', (await item(srcA, 'a4')).revision === 1 && judgeCalls().length === before, await item(srcA, 'a4'));

  // ---- a real edit → "Updated" card for revision 2, with what changed ----
  await call('POST', `/attention/feed_item/${cs[0].ref}/dismiss`, { requestId: 'd1' });
  const edited = A.map((i) => (i.id === 'a4' ? { ...i, title: 'Durable agents 2.1 released', text: 'The release adds Postgres-backed checkpoints and agent replay.' } : i));
  await setFeed('alpha', { body: rss('Alpha Blog', edited) });
  await run();
  const a4b = await item(srcA, 'a4');
  cs = await cards();
  check('an edited item becomes revision 2 (change_kind changed), judged once, and surfaces as "Updated"', a4b.revision === 2 && a4b.change_kind === 'changed' && a4b.judged_revision === 2
    && timesJudged(`${a4b.id}@2`) === 1 && cs.length === 1 && /^Updated from Alpha Blog: Durable agents 2\.1/.test(cs[0].title) && /Was: “Durable agents 2\.0 released”/.test(cs[0].summary), { a4b, cs });
  const det2 = Object.fromEntries(((await call('GET', `/attention/feed_item/${cs[0].ref}`)).body.facts ?? []).map((f: { label: string; value: string }) => [f.label, f.value]));
  check('…the drill-in says exactly what changed', /Durable agents 2\.0 released” → “Durable agents 2\.1 released/.test(det2['What changed'] ?? '') && /checkpoints\./.test(det2.Before ?? ''), det2);
  await run();
  check('…and the next poll does nothing', (await item(srcA, 'a4')).revision === 2 && timesJudged(`${a4b.id}@2`) === 1);
  // feedback is recorded, never changes the profile
  const nr = await call('POST', `/attention/feed_item/${cs[0].ref}/not_relevant`, { requestId: 'nr1' });
  check('"Not relevant" clears the card and records feedback, without touching the interest profile', nr.status === 200 && (await item(srcA, 'a4')).feedback === 'not_relevant'
    && (await call('GET', '/sources')).body.interests === 'AI agents, durable workflows, Postgres' && (await cards()).length === 0);

  // ---- the revision race: rev 1 is being judged when rev 2 arrives ----
  await restart({ MOCK_DELAY_MS: '2500' });
  const R: It[] = [...edited, { id: 'a6', title: 'Agents and Postgres', text: 'First draft.' }];
  await setFeed('alpha', { body: rss('Alpha Blog', R) });
  const run1 = await startRun();
  await waitFor('rev 1 claimed by run 1', async () => (await item(srcA, 'a6'))?.claimed_by === run1, 20_000);
  const a6id = (await item(srcA, 'a6')).id;
  await setFeed('alpha', { body: rss('Alpha Blog', R.map((i) => (i.id === 'a6' ? { ...i, text: 'Final version: agents on Postgres, with benchmarks.' } : i))) });
  const run2 = await startRun();
  await runDone(run1, 30_000);
  const mid = await item(srcA, 'a6');
  check('race: when run 1 (judging rev 1) commits, the item is on rev 2 and run 1\'s judgment was discarded',
    mid.revision === 2 && mid.judged_by !== run1 && mid.judged_revision !== 1 && timesJudged(`${a6id}@1`) === 1, mid);
  await runDone(run2, 30_000);
  const fin = await item(srcA, 'a6');
  check('…rev 2 gets its own judgment from run 2 (never rev 1\'s)', fin.revision === 2 && fin.judged_revision === 2 && fin.judged_by === run2 && timesJudged(`${a6id}@2`) === 1, fin);
  await restart();
  for (const c of await cards()) await call('POST', `/attention/feed_item/${c.ref}/dismiss`, { requestId: `d-${c.ref}` });

  // ---- surfacing ceiling: a feed suddenly publishing many relevant items ----
  const B: It[] = [{ id: 'b0', title: 'Hello', text: 'Welcome.' }];
  await setFeed('beta', { body: rss('Beta News', B) });
  const srcB = (await call('POST', '/sources', { url: feedUrl('beta') })).body.id as string;
  await setFeed('beta', { body: rss('Beta News', [...B, ...Array.from({ length: 8 }, (_, i) => ({ id: `b${i + 1}`, title: `Agents update ${i + 1}`, text: 'More about agents.' }))]) });
  await run();
  const fromB = async () => (await cards()).filter((c) => c.source === 'Research Watch' && / from Beta News:/.test(c.title)).length;
  const judgedB = judgeCalls().length;
  check('8 new relevant items → at most 5 cards this run; the rest stay queued', (await fromB()) === 5, await fromB());
  await run();
  check('…the next run surfaces the other 3 without judging them again', (await fromB()) === 8 && judgeCalls().length === judgedB, { n: await fromB(), calls: judgeCalls().length, judgedB });
  for (const c of await cards()) await call('POST', `/attention/feed_item/${c.ref}/dismiss`, { requestId: `d-${c.ref}` });

  // ---- a source errors / vanishes: state untouched, others continue, then it shows up ----
  const countB = async () => (await one(db, `select count(*)::int n, max(revision) r from ops.feed_items where connection_id = $1`, [srcB]));
  const b0 = await countB();
  await setFeed('beta', { status: 500 });
  A.push({ id: 'a7', title: 'Postgres tips', text: 'Indexes for agents.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  await run();
  const srcStatus = async (id: string) => one(db, `select status, last_error, (metadata->>'failures')::int f from ops.connections where id = $1`, [id]);
  check('one failing source: the other source still gets its new item', (await item(srcA, 'a7'))?.processing_state === 'judged' && (await srcStatus(srcB)).f === 1 && (await srcStatus(srcB)).status === 'active', await srcStatus(srcB));
  check('…and the failing source\'s items are untouched', JSON.stringify(await countB()) === JSON.stringify(b0));
  await run(); await run();
  let prob = (await attention()).find((i) => i.type === 'connection_problem' && i.ref === srcB);
  check('after 3 failures in a row: "Source unavailable" with Retry now / Remove source', (await srcStatus(srcB)).status === 'error' && prob?.title === 'Source unavailable'
    && prob.actions.some((x) => x.id === 'run_now') && prob.actions.some((x) => x.id === 'remove_source'), { st: await srcStatus(srcB), prob });
  check('…the agent itself is not blocked (feeds are not required connections)', (await one(db, `select health_state from ops.agent_health where agent_id = 'research-watch'`)).health_state !== 'blocked');
  await setFeed('beta', { status: 200 });
  const retry = await call('POST', `/attention/connection_problem/${encodeURIComponent(srcB)}/run_now`, { requestId: 'retry-b' });
  if (retry.body.workflowId) await runDone(retry.body.workflowId);
  check('the source recovers: Retry now → active, item gone, nothing replayed', (await srcStatus(srcB)).status === 'active' && !(await attention()).some((i) => i.ref === srcB)
    && JSON.stringify(await countB()) === JSON.stringify(b0), { st: await srcStatus(srcB) });
  await setFeed('beta', { status: 410 });
  await run(); await run(); await run();
  check('a source that answers 410 three times is "gone"', (await srcStatus(srcB)).status === 'gone', await srcStatus(srcB));
  await call('POST', `/attention/connection_problem/${encodeURIComponent(srcB)}/remove_source`, { requestId: 'rm-b' });
  check('Remove source from Needs You stops it and clears the item', !(await attention()).some((i) => i.ref === srcB) && !(await call('GET', '/sources')).body.sources.some((s: { id: string }) => s.id === srcB));
  for (const c of await cards()) await call('POST', `/attention/feed_item/${c.ref}/dismiss`, { requestId: `d-${c.ref}` });

  // ---- per-source pause ----
  await call('POST', `/sources/${encodeURIComponent(srcA)}/pause`);
  const h0p = (await hits('alpha')).hits;
  A.push({ id: 'a8', title: 'Durable queues', text: 'On Postgres.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  const G: It[] = [{ id: 'g1', title: 'Gamma', text: 'Hi.' }];
  await setFeed('gamma', { body: rss('Gamma', G) });
  const srcG = (await call('POST', '/sources', { url: feedUrl('gamma') })).body.id as string;
  G.push({ id: 'g2', title: 'Agents weekly', text: 'Agents.' });
  await setFeed('gamma', { body: rss('Gamma', G) });
  await run();
  check('a paused source is not fetched and raises nothing; another source runs normally', (await hits('alpha')).hits === h0p && !(await item(srcA, 'a8'))
    && (await item(srcG, 'g2'))?.processing_state === 'judged', { hits: (await hits('alpha')).hits, h0p });
  await call('POST', `/sources/${encodeURIComponent(srcA)}/resume`);
  await run();
  cs = await cards();
  const alphaCards = cs.filter((c) => / from Alpha Blog:/.test(c.title)).map((c) => c.title);
  check('resume → catches up from its checkpoint: only the item published meanwhile', (await item(srcA, 'a8'))?.change_kind === 'new'
    && JSON.stringify(alphaCards) === JSON.stringify(['New from Alpha Blog: Durable queues']), alphaCards);
  for (const c of await cards()) await call('POST', `/attention/feed_item/${c.ref}/dismiss`, { requestId: `d-${c.ref}` });

  // ---- remove + re-add: no replay; backfill only on request, through the same pipeline ----
  const a4rev = (await item(srcA, 'a4')).revision;
  await call('DELETE', `/sources/${encodeURIComponent(srcA)}`);
  A.push({ id: 'a9', title: 'Agents news while removed', text: 'Agents.' }, { id: 'a10', title: 'More agents', text: 'Agents again.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  const callsBefore = judgeCalls().length;
  const re = await call('POST', '/sources', { url: feedUrl('alpha') });
  await run();
  check('re-adding a removed source keeps its checkpoint and baselines what is new to us: no replay, no cards', re.body.readded === true && re.body.id === srcA
    && (await item(srcA, 'a9')).change_kind === 'baseline' && (await item(srcA, 'a4')).revision === a4rev && judgeCalls().length === callsBefore && (await cards()).length === 0,
    { re: re.body, a9: (await item(srcA, 'a9'))?.change_kind, a4: (await item(srcA, 'a4')).revision, calls: judgeCalls().slice(callsBefore), cards: (await cards()).map((c) => c.title) });
  const D: It[] = [
    { id: 'd1', title: 'Old agents post', text: 'Agents.', date: 'Mon, 02 Nov 2026 12:00:00 GMT' },
    { id: 'd2', title: 'Newest agents post', text: 'Agents and Postgres.', date: 'Sun, 08 Nov 2026 12:00:00 GMT' },
    { id: 'd3', title: 'Recent cooking', text: 'Soup.', date: 'Sat, 07 Nov 2026 12:00:00 GMT' },
  ];
  await setFeed('delta', { body: rss('Delta', D) });
  const bf = await call('POST', '/sources', { url: feedUrl('delta'), backfill: 2 });
  await run();
  const srcD = bf.body.id;
  const dIds = await all(db, `select item_key, processing_state, relevant from ops.feed_items where connection_id = $1 order by item_key`, [srcD]);
  check('backfill 2 → the 2 newest go through the normal judgment pipeline; the rest stay baseline', bf.body.backfill === 2
    && dIds.find((x) => x.item_key === 'd1')?.processing_state === 'skipped' && dIds.find((x) => x.item_key === 'd2')?.processing_state === 'judged'
    && dIds.find((x) => x.item_key === 'd3')?.processing_state === 'judged' && (await cards()).some((c) => /Newest agents post/.test(c.title)), dIds);
  for (const c of await cards()) await call('POST', `/attention/feed_item/${c.ref}/dismiss`, { requestId: `d-${c.ref}` });

  // ---- checkpoint survives deploys: crash after claiming, DBOS resumes; and a run dead for good is released ----
  A.push({ id: 'a11', title: 'Agents survive crashes', text: 'Durable.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  await restart({ FEED_CRASH_AFTER: 'claimBatch' });
  const wfC = await startRun();
  await w.exited;
  const a11 = await item(srcA, 'a11');
  check('crash right after claiming: the item is claimed by the dead run', a11.processing_state === 'claimed' && a11.claimed_by === wfC, a11);
  await restart();
  await runDone(wfC, 60_000);
  check('…DBOS resumes the same run: judged exactly once, one card', (await item(srcA, 'a11')).processing_state === 'judged' && timesJudged(`${a11.id}@1`) === 1
    && (await cards()).filter((c) => /Agents survive crashes/.test(c.title)).length === 1, { it: await item(srcA, 'a11'), n: timesJudged(`${a11.id}@1`) });
  A.push({ id: 'a12', title: 'Agents and cancelled runs', text: 'Durable.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  await restart({ FEED_CRASH_AFTER: 'claimBatch' });
  const wfD = await startRun();
  await w.exited;
  await db.query(`update dbos.workflow_status set status = 'CANCELLED' where workflow_uuid = $1`, [wfD]);
  await restart();
  await run();
  const a12 = await item(srcA, 'a12');
  check('a run dead for good: its claim is released and the next run judges the item exactly once', a12.processing_state === 'judged' && timesJudged(`${a12.id}@1`) === 1, { a12, n: timesJudged(`${a12.id}@1`) });

  // ---- no profile, no judgment ----
  await call('PUT', '/sources/interests', { interests: '' });
  A.push({ id: 'a13', title: 'Agents with no profile', text: 'Agents.' });
  await setFeed('alpha', { body: rss('Alpha Blog', A) });
  const nBefore = judgeCalls().length;
  await run();
  check('with no interest profile, new items are checkpointed but not judged (no paid call)', (await item(srcA, 'a13'))?.processing_state === 'pending' && judgeCalls().length === nBefore);

  const failedRuns = (await one(db, `select count(*)::int n from ops.runs where agent_id = 'research-watch' and outcome = 'failed'`)).n;
  check('no Research Watch run failed at any point (source failures are per-source, never run failures)', failedRuns === 0, failedRuns);
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall feed watch checks passed');
process.exit(failures.length ? 1 : 0);
