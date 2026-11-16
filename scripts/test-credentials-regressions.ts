// Credential Watch V1A: regressions from the independent adversarial review of PR #31 (findings D1–D8, and the
// two acknowledgment/date-edit mutations M6/M7 the first suite missed). Each check names its finding.
// Every check here was run against the pre-fix code (main @ 7ea90f2) to show it fails there; see the PR.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-credentials-regressions.ts
import { randomBytes } from 'node:crypto';
import { freshDb, killAllWorkers, one, sleep, startWorker, waitFor } from './lib.js';

const D = 86_400_000;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}
const { url, db } = await freshDb('spike_cred_regress');
const env = { CONNECTION_KEY: randomBytes(32).toString('base64'), NOTIFY_INTERVAL_MS: '300', APP_URL: 'https://ops.example', ANTHROPIC_API_KEY: '', OWNER_TIMEZONE: 'America/New_York' };
const PORT = 7880;
let w = await startWorker({ id: 'regress-1', port: PORT, dbUrl: url, env });
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const create = async (name: string, inMs: number | null, extra: Record<string, unknown> = {}) => {
  const r = await w.http('POST', '/credentials', { name, provider: 'anthropic', date: inMs === null ? null : iso(inMs), ...extra });
  if (r.status !== 201) throw new Error(`${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const items = async () => (await w.http('GET', '/attention')).body as any[];
const item = async (id: string) => (await items()).find((i) => i.type === 'credential_expiry' && i.ref === id) ?? null;
const act = (id: string, a: string) => w.http('POST', `/attention/credential_expiry/${encodeURIComponent(id)}/${a}`, { requestId: randomBytes(4).toString('hex') });
const patch = (id: string, body: unknown) => w.http('PATCH', `/credentials/${encodeURIComponent(id)}`, body);
const restart = async () => { await w.kill(); w = await startWorker({ id: `regress-${Date.now()}`, port: PORT, dbUrl: url, env }); await sleep(2500); };

try {
  // ---- M6: a 7-day stage reached by TIME, acked, then an edit inside that stage must not re-raise ----
  const a = await create('Gap A', 7 * D + 3000);
  await waitFor('A crosses 7d', async () => (await item(a))?.actions?.some((x: any) => x.label === 'Got it until the date'), 15_000).catch(() => undefined);
  await act(a, 'dismiss');
  await patch(a, { date: iso(6 * D) });
  check('M6: 7-day stage reached by time, acked, then an edit inside the stage → stays hidden', !(await item(a)), await item(a));

  // ---- M7: acked at 14 days, re-raised by time at 7 days (not acked again), edited inside 7 days → still shown ----
  const b = await create('Gap B', 7 * D + 4000);
  await act(b, 'dismiss');
  await waitFor('B re-raised at 7d', async () => Boolean(await item(b)), 15_000).catch(() => undefined);
  check('M7 setup: the 14-day ack is re-armed by the 7-day crossing', Boolean(await item(b)));
  await patch(b, { date: iso(6 * D) });
  check('M7: an unacknowledged 7-day warning stays visible after an edit inside the stage', Boolean(await item(b)), await item(b));

  // ---- D1: manually tracked credentials are never claimed by the Google integration, across restarts ----
  const g = await create('Gemini API key', 10 * D, { provider: 'google' });
  const gBefore = await one(db, `select status, metadata, last_checked_at from ops.connections where id = $1`, [g]);
  await restart(); // boot runs ensureAgentOpsCalendars over Google connections
  await restart(); // and again: no drift across restarts
  const check1 = await w.http('POST', `/connections/${encodeURIComponent(g)}/check`); // the integration's own check endpoint
  const gAfter = await one(db, `select status, last_error, metadata, last_checked_at from ops.connections where id = $1`, [g]);
  const gItems = (await items()).filter((i) => i.ref === g);
  check('D1: a manual provider "google" credential keeps status active, no error, untouched metadata across two worker boots and a /check call',
    gAfter.status === 'active' && gAfter.last_error === null && JSON.stringify(gAfter.metadata) === JSON.stringify(gBefore.metadata)
    && String(gAfter.last_checked_at) === String(gBefore.last_checked_at), { gAfter, check1: check1.body });
  check('D1: its credential_expiry item survives and no connection_problem appears for it',
    gItems.some((i) => i.type === 'credential_expiry') && !gItems.some((i) => i.type === 'connection_problem'), gItems.map((i) => [i.type, i.title]));

  // ---- D2: manually tracked credentials are never claimed by Research Watch ----
  const f = await create('Feed Thing', 40 * D, { provider: 'feed' });
  const src = (await w.http('GET', '/sources')).body.sources as any[];
  const pause = await w.http('POST', `/sources/${encodeURIComponent(f)}/pause`);
  const remove = await w.http('DELETE', `/sources/${encodeURIComponent(f)}`);
  const fRow = await one(db, `select paused_at, removed_at from ops.connections where id = $1`, [f]);
  check('D2: a manual provider "feed" credential is not a Research Watch source, and the source routes cannot pause or remove it',
    !src.some((s) => s.id === f) && pause.status === 404 && remove.status === 404 && fRow.paused_at === null && fRow.removed_at === null, { src: src.map((s) => s.id), pause: pause.status, remove: remove.status, fRow });

  // ---- D3: a bare date displays as the day picked, not the next day ----
  await patch(g, { date: '2026-12-31' });
  const gc = (await w.http('GET', `/credentials/${encodeURIComponent(g)}`)).body;
  const stored = await one(db, `select to_char(expires_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') as t from ops.connections where id = $1`, [g]);
  check('D3: "2026-12-31" means through the end of Dec 31 (stored as Jan 1 00:00 Eastern) and displays as 2026-12-31',
    stored.t === '2027-01-01 00:00' && gc.display_date === '2026-12-31', { stored, display: gc.display_date });
  await patch(g, { date: iso(10 * D) });
  const det = (await w.http('GET', `/attention/credential_expiry/${encodeURIComponent(g)}`)).body;
  const shown = (det?.facts ?? []).find((x: any) => x.label === 'Expires')?.value;
  const expected = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.now() + 10 * D));
  check('D3: the drill-in shows the date in the owner\'s timezone', shown === expected, { shown, expected });

  // ---- D5: bad input is a 400, never a 500; concurrent same-name creates all succeed ----
  const e1 = await w.http('POST', '/credentials', { name: 'Bad Day', provider: 'anthropic', date: '2026-02-31' });
  const e2 = await fetch(`http://127.0.0.1:${PORT}/credentials`, { method: 'POST', body: 'null' });
  const e3 = await fetch(`http://127.0.0.1:${PORT}/credentials`, { method: 'POST', body: '{"name":' });
  const e4 = await fetch(`http://127.0.0.1:${PORT}/credentials`, { method: 'POST', body: '[1,2]' });
  check('D5: impossible date, body "null", malformed JSON and an array body are all 400s', e1.status === 400 && e2.status === 400 && e3.status === 400 && e4.status === 400,
    [e1.status, e2.status, e3.status, e4.status]);
  const same = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => w.http('POST', '/credentials', { name: 'Same Name', provider: 'anthropic' })));
  const ids = same.map((r) => r.body?.id);
  check('D5: eight concurrent same-name creates all succeed with distinct ids', same.every((r) => r.status === 201) && new Set(ids).size === 8, same.map((r) => [r.status, r.body]));

  // ---- D6: a timestamp without an offset is refused instead of being read in the server's zone ----
  const noOffset = await w.http('POST', '/credentials', { name: 'No Offset', provider: 'anthropic', date: '2026-12-31T10:00' });
  const withOffset = await w.http('POST', '/credentials', { name: 'With Offset', provider: 'anthropic', date: '2026-12-31T10:00:00-05:00' });
  check('D6: a timestamp without an offset is a 400; with one it is accepted', noOffset.status === 400 && withOffset.status === 201, [noOffset.status, withOffset.status]);

  // ---- D7: the stage functions depend on the session TimeZone, so they must not be IMMUTABLE ----
  const vol = await db.query(`select proname, provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'ops' and proname in ('credential_stage', 'credential_threshold', 'credential_since') order by proname`);
  check('D7: credential_stage / _threshold / _since are STABLE', vol.rows.length === 3 && vol.rows.every((r) => r.provolatile === 's'), vol.rows);

  // ---- D8: the secret_ref constraint is versioned, validated once, and not re-added on every boot ----
  const con = async () => db.query(`select conname, convalidated, oid::int from pg_constraint where conrelid = 'ops.connections'::regclass and conname like 'connections_secret_ref%' order by conname`);
  const c1 = (await con()).rows;
  await restart();
  const c2 = (await con()).rows;
  check('D8: exactly one secret_ref constraint (v1), validated, and the same constraint object after a reboot (not dropped and re-added)',
    c1.length === 1 && c1[0].conname === 'connections_secret_ref_v1' && c1[0].convalidated && JSON.stringify(c1) === JSON.stringify(c2), { c1, c2 });
  const v1Src = await one(db, `select prosrc from pg_proc where proname = 'secret_ref_ok_v1'`);
  check('D8: the v1 constraint function is a frozen copy, not a call to the evolving API check', Boolean(v1Src) && !/looks_like_secret/.test(v1Src.prosrc), v1Src ? 'calls looks_like_secret' : 'missing');
  // A row that v1 would reject, if it ever exists, must not stop boot: v1 is not re-validated on boot.
  // (Simulates a stored row the rules flag: drop whichever constraint exists, write the row, put it back NOT VALID.)
  const existing = c2.map((r) => r.conname);
  for (const n of existing) await db.query(`alter table ops.connections drop constraint ${n}`);
  await db.query(`update ops.connections set secret_ref = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9' where id = $1`, [g]);
  for (const n of existing) {
    const fn = n === 'connections_secret_ref_v1' ? 'ops.secret_ref_ok_v1(secret_ref)' : 'secret_ref is null or not ops.looks_like_secret(secret_ref)';
    await db.query(`alter table ops.connections add constraint ${n} check (${fn}) not valid`);
  }
  let booted = true;
  try { await restart(); } catch { booted = false; }
  check('D8: a pre-existing row the constraint would reject does not stop the worker booting', booted && (await w.http('GET', '/livez').catch(() => ({ status: 0 }))).status === 200);
  await db.query(`update ops.connections set secret_ref = null where id = $1`, [g]);
  if (!booted) await restart();

  // ---- D8: the constraint swap is atomic and fails closed ----
  // Pre-fix production state: the old unversioned constraint, no v1. A stored row passes the old rules but
  // fails v1 (an AWS key id: no 32-char run, no prefix the old rules knew). Booting the new code must not
  // leave the table with neither constraint: 016 runs as ONE transaction (applySql sends the file as one
  // multi-statement query, executed as a single implicit transaction), so the failed add of v1 rolls back
  // the drop of the old constraint, and the worker refuses to boot (fail closed).
  const OLD_RULES = `secret_ref is null or not (secret_ref ~* '(^|[^a-z0-9])(sk-(ant-)?[a-z0-9_-]{16,}|github_pat_[a-z0-9_]{20,}|gh[pousr]_[a-z0-9]{20,})' or secret_ref ~ 'eyJ[A-Za-z0-9_-]{8,}' or secret_ref ~ '[A-Za-z0-9]{32,}')`;
  await w.kill();
  await db.query(`alter table ops.connections drop constraint if exists connections_secret_ref_v1`);
  await db.query(`alter table ops.connections drop constraint if exists connections_secret_ref_check`);
  await db.query(`alter table ops.connections add constraint connections_secret_ref_check check (${OLD_RULES})`);
  await db.query(`update ops.connections set secret_ref = 'AKIA' || 'ABCDEFGHIJKLMNOP' where id = $1`, [g]);
  let swapBooted = true;
  try { w = await startWorker({ id: `regress-swap-${Date.now()}`, port: PORT, dbUrl: url, env }); } catch { swapBooted = false; }
  const afterFail = (await con()).rows.map((r) => `${r.conname}:${r.convalidated}`);
  check('D8 atomic: when v1 cannot be added, the boot fails AND the previous constraint is still in place (never neither)',
    !swapBooted && afterFail.length === 1 && afterFail[0] === 'connections_secret_ref_check:true', { swapBooted, afterFail });
  const stillEnforced = await db.query(`update ops.connections set secret_ref = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9' where id = $1`, [g]).then(() => 'ok', (e) => e.code);
  check('D8 atomic: the previous constraint still enforces after the failed swap', stillEnforced === '23514', stillEnforced);
  await db.query(`update ops.connections set secret_ref = null where id = $1`, [g]);
  w = await startWorker({ id: `regress-swapped-${Date.now()}`, port: PORT, dbUrl: url, env });
  await sleep(1500);
  const afterOk = (await con()).rows.map((r) => `${r.conname}:${r.convalidated}`);
  check('D8 atomic: once the row is cleaned up, the next boot swaps to v1 (old constraint gone, v1 validated)',
    afterOk.length === 1 && afterOk[0] === 'connections_secret_ref_v1:true', afterOk);

  // ---- secret detection: defense in depth (API on free text; frozen v1 CHECK on secret_ref) ----
  const sample = (b: number) => randomBytes(b).toString('base64');
  const positives = ['AKIA' + 'ABCDEFGHIJKLMNOP', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'sk_test_' + 'a1B2c3D4e5F6g7H8i9J0k1L2', 'glpat-' + 'xY12abCDef34GHij56KL',
    'GOCSPX-' + 'abcDEF123ghiJKL456mnoPQR', '1//0' + 'abcDEFghiJKLmnoPQRstuVWX', 'https://hooks.slack.com/services/T000/B000/XXXX', 'postgres://user:hunter2@db.example.com:5432/x',
    'sk-ant-api03-' + 'abcdEFGH1234ijklMNOP5678', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc', '-----BEGIN RSA PRIVATE KEY-----',
    ...Array.from({ length: 20 }, () => sample(32))];
  const negatives = ['railway:modest-determination/web/SUPABASE_SERVICE_ROLE_KEY', 'railway:web/GITHUB_PAT_FOR_RELEASE_WORKFLOW_BOT', 'railway:web/SB_PUBLISHABLE_KEY_PRODUCTION',
    'surveyJsLicenseKey', 'https://www.notion.so/team/Runbook-0123456789abcdef0123456789abcdef', 'commit 3f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
    'railway:task-scheduler-production/worker/SUPABASE_SERVICE_ROLE_KEY', 'railway:worker/ANTHROPIC_API_KEY'];
  const det1 = await db.query(`select v, ops.looks_like_secret(v) api from unnest($1::text[]) v`, [[...positives, ...negatives]]);
  const missed = det1.rows.filter((r) => positives.includes(r.v) && !r.api).map((r) => r.v);
  const falsePos = det1.rows.filter((r) => negatives.includes(r.v) && r.api).map((r) => r.v);
  check('secrets: the API check catches AWS, Stripe, GitLab, Google OAuth, Slack webhook, password URL, JWT, PEM and random base64 keys', missed.length === 0, missed);
  check('secrets: the API check does not reject env-var names, the review\'s false positives, page URLs or commit SHAs', falsePos.length === 0, falsePos);
  const refBad = await w.http('POST', '/credentials', { name: 'AWS key', provider: 'aws', secretRef: 'AKIA' + 'ABCDEFGHIJKLMNOP' });
  const refOk = await w.http('POST', '/credentials', { name: 'Release bot', provider: 'github', secretRef: 'railway:web/GITHUB_PAT_FOR_RELEASE_WORKFLOW_BOT' });
  const notesSha = await w.http('POST', '/credentials', { name: 'Runbook link', provider: 'notion', renewUrl: 'https://www.notion.so/team/Runbook-0123456789abcdef0123456789abcdef', notes: 'see commit 3f1c2a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a' });
  check('secrets: through the API, an AWS key id is refused; a GITHUB_PAT_ env-var name, a Notion URL and a commit SHA are accepted',
    refBad.status === 400 && refOk.status === 201 && notesSha.status === 201, [refBad.status, refOk.body, notesSha.body]);
  const hexRef = await db.query(`update ops.connections set secret_ref = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' where id = $1`, [refOk.body.id]).then(() => 'ok', (e) => e.code);
  check('secrets: the database refuses a hex secret in secret_ref even if the API were bypassed', hexRef === '23514', hexRef);

  // ---- M2: a credential item never has a null since (it would re-push on every tick) ----
  const n = await create('Null Since', 10 * D);
  await db.query(`update ops.connections set alert_stage = ops.credential_stage(expires_at, now()), alert_stage_since = null where id = $1`, [n]);
  const t1 = (await item(n))?.createdAt;
  await sleep(1200);
  const t2 = (await item(n))?.createdAt;
  check('M2: with stored since missing, the item still has a fixed since (its threshold), not "now"', Boolean(t1) && t1 === t2 && Date.parse(t1) < Date.now() - 60_000, { t1, t2 });
} finally {
  await killAllWorkers();
  await db.end();
}
console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall regression checks passed');
process.exit(failures.length ? 1 : 0);
