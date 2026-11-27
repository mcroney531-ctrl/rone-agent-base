// Managed inventory writes: the agent identity's write rules, atomic audit, idempotency, stale-write protection.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-credentials-managed.ts
import fs from 'node:fs';
import { EXTERNALS, all, freshDb, killAllWorkers, one, startWorker } from './lib.js';

const PORT = 7870;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const AGENT = 'agent-token-0123456789abcdefghijklmnopqrstuvwxyz';
const OWNER = 'owner-session';
const env = {
  API_TOKEN: 'api-secret', SUPABASE_URL: `${EXTERNALS}/supabase`, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', OWNER_EMAIL: 'owner@example.com',
  CONNECTION_KEY: Buffer.alloc(32, 7).toString('base64'), OWNER_TIMEZONE: 'America/New_York',
};
const { url, db } = await freshDb('spike_cred_managed');
const boot = (withAgent: boolean, id: string) => startWorker({ id, port: PORT, dbUrl: url, env: withAgent ? { ...env, CREDENTIALS_AGENT_TOKEN: AGENT } : env });

let keyN = 0;
const newKey = () => `test-key-${Date.now()}-${++keyN}`;
async function call(method: string, path: string, opts: { as?: 'agent' | 'owner'; body?: unknown; key?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${opts.as === 'owner' ? OWNER : AGENT}` };
  if (opts.as !== 'owner' && opts.key !== null) headers['idempotency-key'] = opts.key ?? newKey();
  if (opts.as === 'owner' && opts.key) headers['idempotency-key'] = opts.key;
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
}
const agent = (m: string, p: string, body?: unknown, key?: string | null) => call(m, p, { as: 'agent', body, key });
const owner = (m: string, p: string, body?: unknown) => call(m, p, { as: 'owner', body });
const enc = encodeURIComponent;
const inferred = (note = 'Seen in the provider console listing') => ({ level: 'inferred', note });
const verified = (note = 'Provider console shows this expiry, viewed today') => ({ level: 'provider_verified', note });
const row = (id: string) => one(db, `select version::int, expires_at, notes, renew_url, removed_at, managed_by, field_provenance from ops.connections where id = $1`, [id]);
const events = (id: string) => all(db, `select actor, op, evidence_level, evidence, idempotency_key, before, after from ops.credential_events where connection_id = $1 order by id`, [id]);

try {
  let w = await boot(true, 'managed-1');

  // ================= create: idempotency, identity, evidence =================
  const body = { name: 'Bakeoff key', provider: 'anthropic', kind: 'api_key', date: '2027-01-31', secretRef: 'railway:bakeoff/ANTHROPIC_API_KEY', evidence: inferred() };
  const noKey = await agent('POST', '/credentials', body, null);
  const noEv = await agent('POST', '/credentials', { ...body, evidence: undefined });
  const ownerLevel = await agent('POST', '/credentials', { ...body, evidence: { level: 'owner_confirmed', note: 'Rone said so' } });
  check('agent create: needs Idempotency-Key, evidence, and may not claim owner_confirmed (all 400)',
    noKey.status === 400 && noEv.status === 400 && ownerLevel.status === 400, [noKey, noEv, ownerLevel]);

  const K1 = newKey();
  const created = await agent('POST', '/credentials', body, K1);
  const id = created.body.id as string;
  const retry = await agent('POST', '/credentials', body, K1);
  const reused = await agent('POST', '/credentials', { ...body, name: 'Different' }, K1);
  const count1 = await one(db, `select count(*)::int n from ops.connections where display_name = 'Bakeoff key'`);
  check('create retry with the same key returns the same credential and creates nothing', created.status === 201 && retry.body.id === id && retry.body.replayed === true && count1.n === 1, { created, retry, count1 });
  check('same key, different request → 409', reused.status === 409, reused);

  const K2 = newKey();
  const racing = await Promise.all(Array.from({ length: 6 }, () => agent('POST', '/credentials', { ...body, name: 'Racer', secretRef: 'railway:racer/KEY' }, K2)));
  const racers = await one(db, `select count(*)::int n from ops.connections where display_name = 'Racer'`);
  check('6 concurrent creates under one key → one credential, every caller gets its id',
    racers.n === 1 && new Set(racing.map((r) => r.body.id)).size === 1 && racing.every((r) => r.status === 201), racing.map((r) => [r.status, r.body.id]));

  const dupLoc = await agent('POST', '/credentials', { ...body, name: 'Renamed bakeoff' });
  check('same provider + secret location → 409 naming the existing credential (no duplicate, no merge)', dupLoc.status === 409 && dupLoc.body.existingId === id, dupLoc);
  const twinA = await agent('POST', '/credentials', { name: 'Shared name', provider: 'openai', evidence: inferred() });
  const twinB = await agent('POST', '/credentials', { name: 'Shared name', provider: 'openai', evidence: inferred() });
  check('two credentials with the same name stay two (never merged by name)', twinA.status === 201 && twinB.status === 201 && twinA.body.id !== twinB.body.id, [twinA.body, twinB.body]);

  const evCreate = await events(id);
  const prov = (await row(id)).field_provenance;
  check('create is audited once: agent actor, inferred evidence, key, after-snapshot, no before',
    evCreate.length === 1 && evCreate[0].actor === 'agent:claude-credentials' && evCreate[0].op === 'create' && evCreate[0].evidence_level === 'inferred'
    && evCreate[0].idempotency_key === K1 && evCreate[0].before === null && evCreate[0].after.secret_ref === body.secretRef, evCreate);
  check('created fields carry inferred provenance', prov.date?.level === 'inferred' && prov.name?.level === 'inferred' && prov.secretRef?.level === 'inferred', prov);

  // Review finding 4: one credential per location, even under concurrency or via a later PATCH.
  const sameLoc = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    agent('POST', '/credentials', { name: `Loc racer ${i}`, provider: 'stripe', secretRef: 'railway:shop/STRIPE_KEY', evidence: inferred() })));
  const locRows = await one(db, `select count(*)::int n from ops.connections where secret_ref = 'railway:shop/STRIPE_KEY'`);
  check('6 concurrent agent creates at one location (different keys) → exactly one credential',
    locRows.n === 1 && sameLoc.filter((r) => r.status === 201).length === 1 && sameLoc.filter((r) => r.status === 409).length === 5, sameLoc.map((r) => r.status));
  const noLoc = await agent('POST', '/credentials', { name: 'Loc later', provider: 'stripe', evidence: inferred() });
  const moveIn = await agent('PATCH', `/credentials/${enc(noLoc.body.id)}`, { secretRef: 'RAILWAY:shop/stripe_key', ifVersion: 1, evidence: inferred() });
  check('PATCHing secretRef to an already-tracked location → 409 with existingId', moveIn.status === 409 && !!moveIn.body.existingId, moveIn);

  // Review finding 6: the Idempotency-Key is stored and shown, so it must be a plain token.
  const secretKey = await agent('POST', '/credentials', { name: 'K', provider: 'x', evidence: inferred() }, 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  const oddKey = await agent('POST', '/credentials', { name: 'K', provider: 'x', evidence: inferred() }, 'clé-ünïcødé-key');
  check('secret-shaped or non-token Idempotency-Key → 400, nothing stored', secretKey.status === 400 && oddKey.status === 400
    && (await one(db, `select count(*)::int n from ops.credential_requests where key like 'sk-ant%'`)).n === 0, [secretKey, oddKey]);

  // Review finding 5: integration rows are read-only for the agent, annotations included.
  const gv = (await one(db, `select version::int v from ops.connections where id = 'google:primary'`)).v;
  const gConsumer = await agent('POST', '/credentials/google%3Aprimary/consumers', { consumer: 'x', ifVersion: gv, evidence: inferred() });
  const gCheck = await agent('POST', '/credentials/google%3Aprimary/checks', { scope: 's', result: 'r', evidence: inferred() });
  const gPatch = await agent('PATCH', '/credentials/google%3Aprimary', { notes: 'n', ifVersion: gv, evidence: inferred() });
  check('agent cannot annotate or edit integration rows (409 each, version unchanged)', [gConsumer, gCheck, gPatch].every((r) => r.status === 409)
    && (await one(db, `select version::int v from ops.connections where id = 'google:primary'`)).v === gv, [gConsumer.status, gCheck.status, gPatch.status]);

  // ================= update: version, indirect retire / deadline removal =================
  const v1 = (await row(id)).version;
  const p = `/credentials/${enc(id)}`;
  const noVer = await agent('PATCH', p, { notes: 'x', evidence: inferred() });
  const stale = await agent('PATCH', p, { notes: 'x', ifVersion: v1 + 5, evidence: inferred() });
  check('agent update: no ifVersion → 400; wrong version → 409 with currentVersion',
    noVer.status === 400 && stale.status === 409 && stale.body.currentVersion === v1, [noVer, stale]);

  const before = await row(id);
  const indirect = await Promise.all([
    agent('PATCH', p, { removed_at: '2026-01-01T00:00:00Z', ifVersion: v1, evidence: inferred() }),
    agent('PATCH', p, { removedAt: '2026-01-01T00:00:00Z', ifVersion: v1, evidence: inferred() }),
    agent('PATCH', p, { managed_by: 'integration', ifVersion: v1, evidence: inferred() }),
    agent('PATCH', p, { status: 'revoked', ifVersion: v1, evidence: inferred() }),
    agent('PATCH', p, { expires_at: null, ifVersion: v1, evidence: verified() }),
    agent('PATCH', p, { field_provenance: {}, ifVersion: v1, evidence: verified() }),
  ]);
  const removals = [
    await agent('PATCH', p, { date: null, ifVersion: v1, evidence: verified() }),
    await agent('PATCH', p, { date: 'none', ifVersion: v1, evidence: verified() }),
    await agent('PATCH', p, { date: '', ifVersion: v1, evidence: verified() }),
  ];
  const afterIndirect = await row(id);
  check('indirect retire/ownership/status/provenance writes via PATCH are refused as unknown fields (400)', indirect.every((r) => r.status === 400), indirect.map((r) => r.body));
  check('removing the deadline (null, "none", "") is refused even with provider_verified evidence (409)', removals.every((r) => r.status === 409), removals.map((r) => r.body));
  check('…and none of it changed the row', afterIndirect.version === before.version && afterIndirect.removed_at === null
    && afterIndirect.expires_at?.getTime() === before.expires_at?.getTime() && afterIndirect.managed_by === 'manual', afterIndirect);

  // ================= evidence levels =================
  const extendInferred = await agent('PATCH', p, { date: '2027-06-30', ifVersion: v1, evidence: inferred() });
  check('extending a deadline on inferred evidence → 409', extendInferred.status === 409, extendInferred);
  const shorten = await agent('PATCH', p, { date: '2027-01-15', ifVersion: v1, evidence: inferred() });
  check('moving an inferred deadline earlier on inferred evidence → 200 (more warning is safe)', shorten.status === 200 && shorten.body.changed === true && shorten.body.version === v1 + 1, shorten);
  const extendVerified = await agent('PATCH', p, { date: '2027-06-30', ifVersion: v1 + 1, evidence: verified() });
  check('extending with provider_verified evidence → 200, date provenance becomes provider_verified',
    extendVerified.status === 200 && extendVerified.body.provenance?.date?.level === 'provider_verified', extendVerified);
  const v3 = (await row(id)).version;
  const weaker = await agent('PATCH', p, { date: '2027-03-01', ifVersion: v3, evidence: inferred() });
  check('inferred may not overwrite a provider_verified date, even to shorten it (409, names the level)',
    weaker.status === 409 && weaker.body.currentLevel === 'provider_verified', weaker);

  const sameUpgrade = await agent('PATCH', p, { name: 'Bakeoff key', ifVersion: v3, evidence: verified('Console shows this exact name') });
  check('same value with stronger evidence upgrades provenance and moves the version',
    sameUpgrade.status === 200 && sameUpgrade.body.changed === true && sameUpgrade.body.provenance?.name?.level === 'provider_verified' && sameUpgrade.body.version === v3 + 1, sameUpgrade);
  const v4 = v3 + 1;
  const evBefore = (await events(id)).length;
  const noop = await agent('PATCH', p, { name: 'Bakeoff key', ifVersion: v4, evidence: inferred() });
  check('a no-op (same value, not stronger) changes nothing: no version bump, no event',
    noop.status === 200 && noop.body.changed === false && noop.body.version === v4 && (await events(id)).length === evBefore, noop);

  // Owner-set fields: the owner's word stands.
  const ownerFix = await owner('PATCH', p, { notes: 'Rotate with the bakeoff script' });
  const v5 = (await row(id)).version;
  const overOwner = await agent('PATCH', p, { notes: 'Rotated monthly', ifVersion: v5, evidence: verified() });
  check('owner edit is recorded as owner_confirmed; the agent cannot overwrite it even with provider_verified (409)',
    ownerFix.status === 200 && ownerFix.body.provenance?.notes?.level === 'owner_confirmed' && overOwner.status === 409 && overOwner.body.currentLevel === 'owner_confirmed', [ownerFix.body.provenance, overOwner]);

  // Pre-existing (pre-018) rows: migration 018 stamps every field, set or empty, as the owner's.
  await db.query(`insert into ops.connections (id, provider, status, managed_by, kind, display_name, notes, expires_at)
                  values ('cred:legacy', 'supabase', 'active', 'manual', 'api_key', 'Legacy key', 'entered by hand', now() + interval '40 days')`);
  await db.query(fs.readFileSync('sql/018_credential_managed_writes.sql', 'utf8')); // what the next boot does
  const lp = '/credentials/cred%3Alegacy';
  const lv = (await row('cred:legacy')).version;
  const legacyDate = await agent('PATCH', lp, { date: '2030-01-01', ifVersion: lv, evidence: verified() });
  const legacyNotes = await agent('PATCH', lp, { notes: 'changed', ifVersion: lv, evidence: verified() });
  const legacyFill = await agent('PATCH', lp, { renewUrl: 'https://supabase.com/dashboard', ifVersion: lv, evidence: inferred() });
  check('legacy rows: every field, set or empty, is the owner\'s (agent refused, even filling a blank)',
    legacyDate.status === 409 && legacyNotes.status === 409 && legacyFill.status === 409, [legacyDate.status, legacyNotes.status, legacyFill]);
  const reMigrate = (await row('cred:legacy')).field_provenance;
  await db.query(fs.readFileSync('sql/018_credential_managed_writes.sql', 'utf8'));
  check('re-running 018 leaves existing provenance alone', JSON.stringify((await row('cred:legacy')).field_provenance) === JSON.stringify(reMigrate));

  // Review finding 2: an explicit "no date" is the owner's decision; the agent can't add one.
  const undated = await owner('POST', '/credentials', { name: 'Never expires', provider: 'github', kind: 'pat', date: null });
  const up = `/credentials/${enc(undated.body.id)}`;
  const addDate = await agent('PATCH', up, { date: '2026-12-01', ifVersion: 1, evidence: inferred() });
  check('owner created with no date → agent may not add one (409)', undated.status === 201 && addDate.status === 409 && addDate.body.currentLevel === 'owner_confirmed', addDate);
  await db.query(`insert into ops.connections (id, provider, status, managed_by, kind, display_name, field_provenance)
                  values ('cred:fresh-blank', 'x', 'active', 'manual', 'api_key', 'Blank', '{"name":{"level":"inferred"}}')`);
  const restate = await owner('PATCH', '/credentials/cred%3Afresh-blank', { date: null });
  const afterRestate = await agent('PATCH', '/credentials/cred%3Afresh-blank', { date: '2026-12-01', ifVersion: restate.body.version, evidence: inferred() });
  check('owner "Doesn\'t expire" on an undated row records the decision; the agent then cannot add a date',
    restate.status === 200 && restate.body.changed === true && restate.body.provenance?.date?.level === 'owner_confirmed' && afterRestate.status === 409, [restate.body, afterRestate.status]);

  // Review finding 8: what the date means is as strong as the date.
  const agentMade = await agent('POST', '/credentials', { name: 'Relabel target', provider: 'openai', date: '2027-03-01', evidence: inferred() });
  const rp = `/credentials/${enc(agentMade.body.id)}`;
  await owner('PATCH', rp, { date: '2027-01-20' }); // the owner corrects the date; dateKind is still the agent's
  const relabel = await agent('PATCH', rp, { dateKind: 'review_by', ifVersion: (await row(agentMade.body.id)).version, evidence: verified() });
  check('agent may not relabel an owner-confirmed date (dateKind follows the date\'s evidence)', relabel.status === 409, relabel);

  // ================= stale updates and concurrency =================
  // The sweep reads, the owner corrects, the sweep writes what it read before: refused.
  const sweepRead = (await agent('GET', p)).body;
  const correction = await owner('PATCH', p, { renewUrl: 'https://console.anthropic.com/settings/keys' });
  const sweepWrite = await agent('PATCH', p, { renewUrl: 'https://example.com/old', ifVersion: sweepRead.version, evidence: verified() });
  const kept = await row(id);
  check('a sweep never overwrites a newer owner correction (stale ifVersion → 409, owner value kept)',
    correction.status === 200 && sweepWrite.status === 409 && kept.renew_url === 'https://console.anthropic.com/settings/keys', [sweepWrite, kept.renew_url]);

  const cur = (await row(id)).version;
  const contenders = await Promise.all(['2027-02-01', '2027-02-02', '2027-02-03', '2027-02-04'].map((d) =>
    agent('PATCH', p, { date: d, ifVersion: cur, evidence: verified() })));
  const winners = contenders.filter((r) => r.status === 200);
  check('4 concurrent updates from the same version: exactly one wins, the rest get 409',
    winners.length === 1 && contenders.filter((r) => r.status === 409).length === 3 && (await row(id)).version === cur + 1, contenders.map((r) => r.status));

  // ================= consumers =================
  const cp = `${p}/consumers`;
  let cv = (await row(id)).version;
  const c1 = await agent('POST', cp, { consumer: 'Railway worker', confidence: 'candidate', ifVersion: cv, evidence: inferred('Variable name matches') });
  cv = c1.body.version;
  const c1again = await agent('POST', cp, { consumer: '  railway WORKER ', confidence: 'candidate', ifVersion: cv, evidence: inferred('Seen again') });
  const nConsumers = await one(db, `select count(*)::int n from ops.credential_consumers where connection_id = $1`, [id]);
  check('consumer identity is case/space-insensitive: re-observing it does not add a row',
    c1.status === 201 && c1again.status === 200 && c1again.body.changed === false && c1again.body.id === c1.body.id && nConsumers.n === 1, [c1, c1again, nConsumers]);
  const confirmInferred = await agent('POST', cp, { consumer: 'Railway worker', confidence: 'confirmed', ifVersion: cv, evidence: inferred() });
  const confirmVerified = await agent('POST', cp, { consumer: 'Railway worker', confidence: 'confirmed', ifVersion: cv, evidence: verified('Railway shows ANTHROPIC_API_KEY on worker') });
  cv = confirmVerified.body.version;
  const downgrade = await agent('POST', cp, { consumer: 'Railway worker', confidence: 'candidate', ifVersion: cv, evidence: verified() });
  const agentRemove = await agent('DELETE', `${cp}/${c1.body.id}`);
  check('confirming a consumer needs provider_verified; the agent never downgrades or removes one',
    confirmInferred.status === 400 && confirmVerified.status === 200 && confirmVerified.body.changed === true && downgrade.status === 409 && agentRemove.status === 403,
    [confirmInferred.status, confirmVerified.status, downgrade.status, agentRemove.status]);
  const ownerDown = await owner('POST', cp, { consumer: 'Railway worker', confidence: 'candidate', evidence: 'Not sure anymore' });
  check('the owner can downgrade', ownerDown.status === 200 && ownerDown.body.changed === true, ownerDown);

  // Review finding 3: the owner's word on a consumer stands.
  cv = (await row(id)).version;
  const reconfirm = await agent('POST', cp, { consumer: 'Railway worker', confidence: 'confirmed', ifVersion: cv, evidence: verified() });
  await owner('POST', cp, { consumer: 'Cron job', confidence: 'candidate', evidence: 'Owner thinks the cron uses it' });
  cv = (await row(id)).version;
  const overwriteOwnerEvidence = await agent('POST', cp, { consumer: 'cron job', confidence: 'confirmed', ifVersion: cv, evidence: verified('Railway shows it') });
  const cronRow = await one(db, `select confidence, evidence, noted_by from ops.credential_consumers where connection_id = $1 and consumer = 'Cron job'`, [id]);
  check('the agent never re-confirms an owner-downgraded consumer or overwrites an owner-noted one (409, row untouched)',
    reconfirm.status === 409 && overwriteOwnerEvidence.status === 409 && cronRow.evidence === 'Owner thinks the cron uses it' && cronRow.noted_by.startsWith('owner:'), [reconfirm.status, overwriteOwnerEvidence.status, cronRow]);
  // Review finding 7: the owner re-adding with new evidence is an edit, not a silent no-op.
  const ownerReAdd = await owner('POST', cp, { consumer: 'Cron job', confidence: 'candidate', evidence: 'Checked: nightly backup cron' });
  check('owner re-add with new evidence updates it', ownerReAdd.status === 200 && ownerReAdd.body.changed === true
    && (await one(db, `select evidence from ops.credential_consumers where connection_id = $1 and consumer = 'Cron job'`, [id])).evidence === 'Checked: nightly backup cron', ownerReAdd);

  // Review finding 1: owner removing a consumer while the sweep confirms it must not deadlock.
  let fives = 0;
  for (let i = 0; i < 40; i++) {
    const name = `Race consumer ${i}`;
    const v0 = (await row(id)).version;
    const added = await agent('POST', cp, { consumer: name, confidence: 'candidate', ifVersion: v0, evidence: inferred() });
    const results = await Promise.all([
      owner('DELETE', `${cp}/${added.body.id}`),
      agent('POST', cp, { consumer: name, confidence: 'confirmed', ifVersion: added.body.version, evidence: verified() }),
    ]);
    fives += results.filter((r) => r.status >= 500).length;
  }
  check('40 races of owner remove vs agent confirm: no 500s (one lock order)', fives === 0, fives);

  // ================= checks: retry vs fresh observation =================
  const kp = `${p}/checks`;
  const KC = newKey();
  const chk = { scope: 'Railway: all services', result: 'Found on worker only', evidence: verified() };
  const k1 = await agent('POST', kp, chk, KC);
  const k1retry = await agent('POST', kp, chk, KC);
  const k2 = await agent('POST', kp, chk);
  const nChecks = await one(db, `select count(*)::int n from ops.credential_checks where connection_id = $1`, [id]);
  check('a check retried under its key is one row; the same check under a new key is a new observation',
    k1.status === 201 && k1retry.body.id === k1.body.id && k1retry.body.replayed === true && k2.status === 201 && k2.body.id !== k1.body.id && nChecks.n === 2, [k1, k1retry, k2, nChecks]);

  // ================= atomic audit / partial failure =================
  await db.query(`create or replace function pg_temp_fail() returns trigger language plpgsql as $$ begin
    if new.evidence = 'FAIL-AUDIT' then raise exception 'injected audit failure'; end if; return new; end $$`);
  await db.query(`create trigger inject_audit_failure before insert on ops.credential_events for each row execute function pg_temp_fail()`);
  const pv = (await row(id)).version;
  const pre = await row(id);
  const KF = newKey();
  const failBody = { notes: undefined, renewUrl: undefined, date: '2027-02-10', ifVersion: pv, evidence: verified('FAIL-AUDIT') };
  // date changes are allowed here (provider_verified over provider_verified)
  const failed = await agent('PATCH', p, failBody, KF);
  const post = await row(id);
  const keyRow = await one(db, `select count(*)::int n from ops.credential_requests where key = $1`, [KF]);
  check('audit insert fails → the whole change rolls back: no new date, no version bump, no key burned',
    failed.status === 500 && post.version === pre.version && post.expires_at.getTime() === pre.expires_at.getTime() && keyRow.n === 0, { failed: failed.status, pre: pre.version, post: post.version, keyRow });
  await db.query(`drop trigger inject_audit_failure on ops.credential_events`);
  const healed = await agent('PATCH', p, { date: '2027-02-10', ifVersion: pv, evidence: verified('Console shows Feb 10') }, KF);
  check('after the failure the same key works (nothing was half-recorded)', healed.status === 200 && healed.body.version === pv + 1, healed);

  // ================= secrets in evidence and audit =================
  const sv = (await row(id)).version;
  const secretNote = await agent('PATCH', p, { date: '2027-02-11', ifVersion: sv, evidence: verified('key was sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789') });
  check('a secret-looking evidence note is refused (400) and nothing changes', secretNote.status === 400 && (await row(id)).version === sv, secretNote);
  let auditGuard = false;
  try {
    await db.query(`insert into ops.credential_events (connection_id, actor, op, after) values ($1, 'x', 'update', $2)`,
      [id, JSON.stringify({ secret_ref: 'AKIAIOSFODNN7EXAMPLE1234' })]);
  } catch (e) { auditGuard = (e as { code?: string }).code === '23514'; }
  check('the database refuses a key-shaped secret_ref inside an audit snapshot, even written directly', auditGuard);

  // ================= audit trail =================
  const trail = (await agent('GET', `${p}/events`)).body as any[];
  const ops = new Set(trail.map((e) => e.op));
  check('the agent can read the trail; every kind of change it made is there',
    ['create', 'update', 'consumer_add', 'consumer_update', 'check_add'].every((o) => ops.has(o)) && trail.every((e) => e.actor), [...ops]);
  const ownerEv = trail.find((e) => e.actor === 'owner:owner@example.com' && e.op === 'update');
  check('owner edits are audited too (owner_confirmed)', ownerEv?.evidence_level === 'owner_confirmed', ownerEv);
  const orphan = await one(db, `select count(*)::int n from ops.connections c where c.kind is not null and c.version > 1
                                and not exists (select 1 from ops.credential_events e where e.connection_id = c.id)`);
  check('every credential whose version moved has audit rows', orphan.n === 0, orphan);

  // ================= retire stays with the owner =================
  const agentRetire = await agent('DELETE', p);
  const ownerRetire = await owner('DELETE', `/credentials/${enc(twinA.body.id)}`);
  const retireEv = await events(twinA.body.id);
  check('agent retire → 403; owner retire works and is audited with before/after',
    agentRetire.status === 403 && ownerRetire.status === 200 && retireEv.at(-1)?.op === 'retire' && retireEv.at(-1)?.before.removed_at === null && retireEv.at(-1)?.after.removed_at !== null,
    [agentRetire.status, ownerRetire.status, retireEv.at(-1)]);

  // ================= token revocation =================
  await w.kill();
  w = await boot(false, 'managed-2');
  const rv = (await row(id)).version;
  const afterRevoke = await agent('PATCH', p, { date: '2027-02-12', ifVersion: rv, evidence: verified() });
  const replayAfterRevoke = await agent('POST', '/credentials', body, K1);
  check('after revocation every agent call is 401 (even a replay of a stored key), and nothing changes',
    afterRevoke.status === 401 && replayAfterRevoke.status === 401 && (await row(id)).version === rv, [afterRevoke.status, replayAfterRevoke.status]);
  const ownerStill = await owner('GET', p);
  check('revoking the agent leaves the owner untouched', ownerStill.status === 200, ownerStill.status);
  await w.kill();
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall managed-write checks passed');
process.exit(failures.length ? 1 : 0);
