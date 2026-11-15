// Credential Watch V1A (spec: Agent Hub, credential-watch/v1a-spec.md rev 3), against a fake push service.
// Two replicas notify concurrently throughout, so every exact push count below is also the concurrency check.
// Time-driven threshold crossings are real: dates are set a few seconds past a threshold and the test waits.
// Both workers run with ANTHROPIC_API_KEY empty: V1A must not need a model.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-credentials.ts
import fs from 'node:fs';
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { EXTERNALS, freshDb, killAllWorkers, one, sleep, startWorker, waitFor } from './lib.js';

const PORT = 7870;
const D = 86_400_000;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

type Dev = ReturnType<typeof device>;
function device(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { id, ecdh, auth, subscription: { endpoint: `${EXTERNALS}/push/recv/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
type Push = { id: string; body: string };
const decrypt = (dev: Dev, r: Push) =>
  JSON.parse(ece.decrypt(Buffer.from(r.body, 'base64'), { version: 'aes128gcm', privateKey: dev.ecdh, authSecret: dev.auth.toString('base64url') }).toString('utf8'));
async function pushes(dev: Dev, ref?: string): Promise<{ tag: string; body: string; kind: string }[]> {
  const all = ((await (await fetch(`${EXTERNALS}/push/admin/received`)).json()) as Push[]).filter((r) => r.id === dev.id).map((r) => decrypt(dev, r));
  return ref ? all.filter((m) => m.tag === `credential_expiry:${ref}`) : all;
}

const { url, db } = await freshDb('spike_cred');
await fetch(`${EXTERNALS}/push/admin/reset`, { method: 'POST' });
const env = { CONNECTION_KEY: randomBytes(32).toString('base64'), NOTIFY_INTERVAL_MS: '300', NOTIFY_RETRY_BASE_MS: '3000', APP_URL: 'https://ops.example', ANTHROPIC_API_KEY: '' };
const w = await startWorker({ id: 'cred-1', port: PORT, dbUrl: url, env });
const w2 = await startWorker({ id: 'cred-2', port: PORT + 1, dbUrl: url, env }); // a second notifier, ticking concurrently
const settle = () => sleep(1800);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const NAMES: string[] = [];
async function create(name: string, inMs: number | null, extra: Record<string, unknown> = {}) {
  NAMES.push(name);
  const r = await w.http('POST', '/credentials', { name, provider: 'anthropic', kind: 'api_key', date: inMs === null ? null : iso(inMs), ...extra });
  if (r.status !== 201) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}
const patch = (id: string, body: unknown) => w.http('PATCH', `/credentials/${encodeURIComponent(id)}`, body);
async function item(id: string) {
  return ((await w.http('GET', '/attention')).body as any[]).find((i) => i.type === 'credential_expiry' && i.ref === id) ?? null;
}
const act = (id: string, action: string, choice?: string) =>
  w.http('POST', `/attention/credential_expiry/${encodeURIComponent(id)}/${action}`, { requestId: randomBytes(4).toString('hex'), ...(choice ? { choice } : {}) });
async function expectPushes(dev: Dev, id: string, n: number, what: string) {
  await waitFor(`${what}: ${n} push(es)`, async () => (await pushes(dev, id)).length >= n, 10_000).catch(() => undefined);
  await settle(); // and no more than n, with both notifiers still ticking
  const got = (await pushes(dev, id)).length;
  check(what, got === n, { expected: n, got });
}

try {
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  const agentConnectionsBefore = (await one(db, `select count(*)::int n, coalesce(string_agg(agent_id || '>' || connection_id, ',' order by agent_id, connection_id), '') s from ops.agent_connections`));
  const blocked = async () => ((await w.http('GET', '/health')).body.agents as any[]).map((a) => `${a.agent_id}:${a.health_state}:${(a.blocked_connections ?? []).join('+')}`).sort().join(',');
  const healthBefore = await blocked(); // fresh DB: the Google-based agents are already blocked on an unauthorized google:primary
  const phone = device('phone');
  const reg = await w.http('POST', '/push/devices', { subscription: phone.subscription, label: 'Android · Chrome' });
  check('phone registered', reg.status === 200, reg.body);

  // ---- 1. registration stores no secret ----
  const bad = [
    { secretRef: 'sk-ant-api03-abcdefghijklmnopqrstuvwx' }, { secretRef: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc' },
    { secretRef: 'github_pat_11ABCDEFG0123456789_abcdefghij' }, { notes: 'old key was ghp_abcdefghijklmnopqrstuvwxyz0123' },
    { secretRef: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08' }, { name: 'sb_secret_abcdefghijklmnop' },
  ];
  const badStatus = await Promise.all(bad.map((b) => w.http('POST', '/credentials', { name: 'X', provider: 'supabase', ...b }).then((r) => r.status)));
  check('key-shaped values are refused with 400 (sk-ant, JWT, github_pat, ghp_ in notes, hex secret, sb_secret_ as a name)', badStatus.every((s) => s === 400), badStatus);
  const okRef = await w.http('POST', '/credentials', { name: 'Ref style check', provider: 'anthropic', secretRef: 'railway:task-scheduler-production/worker/SUPABASE_SERVICE_ROLE_KEY' });
  check('a location name with separators is accepted (no false positive on "task-…")', okRef.status === 201, okRef.body);
  const direct = await db.query(`update ops.connections set secret_ref = 'eyJhbGciOiJIUzI1NiJ9.payload' where id = $1`, [okRef.body.id]).then(() => 'ok', (e) => e.code);
  check('the schema itself refuses a key-shaped secret_ref (direct SQL → check violation)', direct === '23514', direct);
  const seeded = fs.readdirSync('sql').some((f) => /cred:/.test(fs.readFileSync(`sql/${f}`, 'utf8')));
  check('no real credential inventory in sql/ (public repo)', !seeded);

  // ---- outside the Needs You window ----
  const far = await create('Far Key', 40 * D);
  const near30 = await create('Thirty Day Key', 25 * D);
  await settle();
  const list = (await w.http('GET', '/credentials')).body as any[];
  const c30 = list.find((c) => c.id === near30);
  check('40 days out: no item; 25 days out: no item, but flagged on the Credentials card (stage 1)',
    !(await item(far)) && !(await item(near30)) && c30?.stage === 1 && list.find((c) => c.id === far)?.stage === 0, c30);
  check('nothing pushed outside the window', (await pushes(phone)).length === 0);

  // ---- row 12: registered already inside 14 days → one push, now ----
  const k13 = await create('Thirteen Key', 13 * D);
  await expectPushes(phone, k13, 1, 'row 12: registered at 13 days → exactly one push per device (two notifiers ticking)');
  const i13 = await item(k13);
  check('one stable item, severity problem, titled with days left', i13?.id === `credential_expiry:${k13}` && i13.severity === 'problem' && /expires in 1[23] days/.test(i13.title), i13);
  check('lock-screen text is modest (no credential name)', (await pushes(phone, k13)).every((m) => m.body === 'A tracked credential date is coming up'), await pushes(phone, k13));

  // ---- row 2 + platform regression: a stage reached by TIME re-raises the same item once ----
  const k2 = await create('Crossing Key', 14 * D + 3000);
  check('row 1: 14 days + 3s is still outside Needs You', !(await item(k2)));
  await expectPushes(phone, k2, 1, 'row 2 + platform regression: time crosses 14 days → the item appears and is pushed exactly once');

  // ---- rows 3–5: ack, edit within the stage, then time reaches 7 days ----
  const k5 = await create('Edit Within Key', 8 * D);
  await expectPushes(phone, k5, 1, 'row 3 setup: 8 days → one push');
  await act(k5, 'dismiss');
  check('row 3: "Got it until 7 days" hides it', !(await item(k5)));
  await patch(k5, { date: iso(7 * D + 4000) });
  await settle();
  check('row 4: editing the date but staying in the 14-day stage → no push, stays hidden', (await pushes(phone, k5)).length === 1 && !(await item(k5)));
  await patch(k5, { date: iso(7 * D + 3500) }); // an earlier date, same stage
  await expectPushes(phone, k5, 2, 'row 5: time reaches 7 days on the edited date → exactly one new push');
  check('row 5: the acked item is shown again', Boolean(await item(k5)));

  // ---- row 6: edit inside the 7-day stage ----
  const k6 = await create('Seven Stage Key', 5 * D);
  await expectPushes(phone, k6, 1, 'row 6 setup: 5 days → one push');
  await act(k6, 'dismiss');
  await patch(k6, { date: iso(6 * D) });
  await patch(k6, { date: iso(4 * D) });
  await settle();
  check('row 6: later and earlier edits inside the 7-day stage → no push, stays hidden', (await pushes(phone, k6)).length === 1 && !(await item(k6)));

  // ---- row 7: an edit that escalates ----
  const k7 = await create('Escalate Key', 10 * D);
  await expectPushes(phone, k7, 1, 'row 7 setup: 10 days → one push');
  await act(k7, 'dismiss');
  await patch(k7, { date: iso(3 * D) });
  await expectPushes(phone, k7, 2, 'row 7: editing 10 days → 3 days escalates → exactly one new push');
  check('row 7: the acked item is shown again', Boolean(await item(k7)));

  // ---- rows 8–9: de-escalate, then re-enter 7 days ----
  const k8 = await create('Deescalate Key', 6 * D);
  await expectPushes(phone, k8, 1, 'row 8 setup: 6 days → one push');
  await act(k8, 'dismiss');
  await patch(k8, { date: iso(7 * D + 4000) });
  await settle();
  check('row 8: pushing the date back to the 14-day stage → no push, stays hidden', (await pushes(phone, k8)).length === 1 && !(await item(k8)));
  await expectPushes(phone, k8, 2, 'row 9: time re-enters 7 days → warns again, exactly once');

  // ---- row 10 + retirement: the date passes ----
  const k10 = await create('Passing Key', 5 * D);
  await expectPushes(phone, k10, 1, 'row 10 setup: 5 days → one push');
  await patch(k10, { date: iso(4000) });
  await settle();
  check('row 10: an edit to 4 seconds out stays in the 7-day stage → no push', (await pushes(phone, k10)).length === 1);
  await expectPushes(phone, k10, 2, 'row 10: the date passes → exactly one new push');
  const i10 = await item(k10);
  check('passed: same item, severity decision, titled "expired"', i10?.id === `credential_expiry:${k10}` && i10.severity === 'decision' && /expired$/.test(i10.title), i10);
  check('passed: no "Got it" offered, and dismiss is refused', !i10?.actions.some((a: any) => a.id === 'dismiss') && (await act(k10, 'dismiss')).status === 400);
  check('passed: lock-screen text says a date passed, still no name', (await pushes(phone, k10)).at(-1)?.body === 'A tracked credential date has passed');
  const row10 = await one(db, `select status from ops.connections where id = $1`, [k10]);
  const healthNow = await blocked();
  check('nonblocking: a passed date leaves status active and changes no agent\'s health', row10.status === 'active' && healthNow === healthBefore, { row10, healthBefore, healthNow });
  const retire = await act(k10, 'not_needed');
  await settle();
  check('"Not needed / retired" resolves a passed credential without inventing a date; no further push',
    retire.status === 200 && !(await item(k10)) && Boolean((await one(db, `select removed_at from ops.connections where id = $1`, [k10])).removed_at)
    && (await pushes(phone, k10)).length === 2, retire.body);

  // ---- row 11: Renewed from Needs You ----
  const k11 = await create('Renew Key', 9 * D);
  await expectPushes(phone, k11, 1, 'row 11 setup: 9 days → one push');
  const nextYear = new Date(Date.now() + 365 * D).toISOString().slice(0, 10);
  const ren = await act(k11, 'renewed', nextYear);
  await settle();
  check('row 11: Renewed with a date a year out clears the item, no push', ren.status === 200 && !(await item(k11)) && (await pushes(phone, k11)).length === 1, ren.body);
  const k11b = await create('No Expiry Key', 9 * D);
  await expectPushes(phone, k11b, 1, 'row 11b setup');
  const none = await act(k11b, 'renewed', 'none');
  check('Renewed → "Doesn\'t expire" clears the item', none.status === 200 && !(await item(k11b)), none.body);

  // ---- row 13: worker down across 7 days AND the date (fixture: as if created 8 days ago) ----
  const k13b = await create('Downtime Key', 13 * D);
  await expectPushes(phone, k13b, 1, 'row 13 setup: one push at 14-day stage');
  await db.query(`update ops.connections set expires_at = now() - interval '1 minute', alert_stage_since = now() - interval '8 days' where id = $1`, [k13b]);
  await db.query(`update ops.notification_deliveries set since = now() - interval '8 days' where ref = $1`, [k13b]);
  await db.query(`update ops.push_devices set created_at = now() - interval '9 days'`);
  await expectPushes(phone, k13b, 2, 'row 13: stages crossed while nothing could notify collapse into one push (passed)');

  // ---- date kinds ----
  const pt = await create('Legacy Keys Target', 2000, { dateKind: 'provider_target', notes: 'Disabling legacy service_role also disables anon.' });
  await waitFor('provider target passed', async () => /passed/.test((await item(pt))?.title ?? ''), 10_000).catch(() => undefined);
  const ipt = await item(pt);
  check('provider target passed: "still working until shown otherwise", status unchanged', /still working until shown otherwise/.test(ipt?.title ?? '')
    && (await one(db, `select status from ops.connections where id = $1`, [pt])).status === 'active', ipt);
  const rv = await create('Review Item', 2000, { dateKind: 'review_by' });
  await waitFor('review overdue', async () => /review overdue/.test((await item(rv))?.title ?? ''), 10_000).catch(() => undefined);
  check('review date passed: "review overdue"', /review overdue/.test((await item(rv))?.title ?? ''));

  // ---- consumers, checks, known impact (drill-in) ----
  const c1 = await w.http('POST', `/credentials/${encodeURIComponent(pt)}/consumers`, { consumer: 'modest-determination → web', confidence: 'confirmed', evidence: 'Railway variable name SUPABASE_SERVICE_ROLE_KEY' });
  const c2 = await w.http('POST', `/credentials/${encodeURIComponent(pt)}/consumers`, { consumer: 'rone-agent-base → worker', confidence: 'candidate', evidence: 'SUPABASE_PUBLISHABLE_KEY format unverified' });
  const ch = await w.http('POST', `/credentials/${encodeURIComponent(pt)}/checks`, { scope: 'Railway variable names', result: '2 of 9 projects checked' });
  const badC = await w.http('POST', `/credentials/${encodeURIComponent(pt)}/consumers`, { consumer: 'x', confidence: 'confirmed', evidence: 'eyJhbGciOiJIUzI1NiJ9.leaked' });
  const det = (await w.http('GET', `/attention/credential_expiry/${encodeURIComponent(pt)}`)).body;
  const f = Object.fromEntries((det?.facts ?? []).map((x: any) => [x.label, x.value]));
  check('consumers and checks recorded; a key-shaped evidence string is refused', c1.status === 201 && c2.status === 201 && ch.status === 201 && badC.status === 400, [c1.body, c2.body, ch.body, badC.body]);
  check('drill-in: confirmed vs candidate consumers with evidence, checks, qualified known impact, and the coverage disclaimer',
    /modest-determination → web \(Railway variable name/.test(f['Known consumers — confirmed'] ?? '')
    && /rone-agent-base → worker/.test(f['Known consumers — candidate (unverified)'] ?? '')
    && /Railway variable names: 2 of 9 projects checked/.test(f.Checks ?? '')
    && /^1 confirmed, 1 candidate consumer; checked: .*Others may exist\.$/.test(f['Known impact'] ?? '')
    && f.Coverage === 'Known consumers only. This list has not been shown to be complete.'
    && /also disables anon/.test(f['Renewal notes'] ?? '') && /Provider deprecation target/.test(Object.keys(f).join('|')), f);

  // ---- integration rows are read-only ----
  await db.query(`insert into ops.connections (id, provider, status, kind) values ('google:primary', 'google', 'active', 'oauth') on conflict (id) do update set kind = 'oauth'`);
  const gp = await patch('google:primary', { date: iso(3 * D) });
  const gd = await w.http('DELETE', '/credentials/google%3Aprimary');
  check('integration rows (Google) are listed but not editable or retirable here', gp.status === 409 && gd.status === 404
    && ((await w.http('GET', '/credentials')).body as any[]).some((c) => c.id === 'google:primary'), [gp, gd]);

  // ---- quiet hours: two crossings in one quiet window → one push when it ends ----
  await db.query(`update ops.settings set value = jsonb_build_object('quietStart', '00:00', 'quietEnd', '23:59', 'timezone', 'UTC') where key = 'notifications'`);
  const inQuiet = new Date().getUTCHours() * 60 + new Date().getUTCMinutes() < 23 * 60 + 58;
  const kq = await create('Quiet Key', 7 * D + 3000);
  await sleep(4500); // crosses into 7 days while quiet
  check('quiet hours: nothing is sent while quiet', !inQuiet || (await pushes(phone, kq)).length === 0);
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  await expectPushes(phone, kq, 1, 'quiet hours: two stages reached inside one quiet window → exactly one push when it ends');

  // ---- stale pending work: retire or re-date while a delivery waits to retry ----
  const flaky = device('flaky'); // the fake push service fails this endpoint twice; retries wait NOTIFY_RETRY_BASE_MS (3s)
  await fetch(`${EXTERNALS}/push/admin/reset`, { method: 'POST' }); // also resets the flaky counter (and phone history)
  await w.http('POST', '/push/devices', { subscription: flaky.subscription, label: 'Windows · Chrome' });
  const s1 = await create('Stale Retire Key', 10 * D);
  await waitFor('flaky first attempt failed', async () => (await one(db, `select status from ops.notification_deliveries d join ops.push_devices p on p.id = d.device_id
      where d.ref = $1 and p.label = 'Windows · Chrome'`, [s1]))?.status === 'failed', 10_000).catch(() => undefined);
  await w.http('DELETE', `/credentials/${encodeURIComponent(s1)}`);
  const s2 = await create('Stale Redate Key', 10 * D);
  await waitFor('flaky second attempt failed', async () => (await one(db, `select status from ops.notification_deliveries d join ops.push_devices p on p.id = d.device_id
      where d.ref = $1 and p.label = 'Windows · Chrome'`, [s2]))?.status === 'failed', 10_000).catch(() => undefined);
  await patch(s2, { date: iso(200 * D) });
  await sleep(7000); // past both retry times
  check('stale work: a delivery waiting to retry is never sent after the credential is retired or re-dated out of the window',
    (await pushes(flaky, s1)).length === 0 && (await pushes(flaky, s2)).length === 0, { s1: await pushes(flaky, s1), s2: await pushes(flaky, s2) });
  const s3 = await create('After Flaky Key', 10 * D);
  await expectPushes(flaky, s3, 1, 'the retried device still receives current items');

  // ---- global invariants ----
  const allBodies = [...(await pushes(phone)), ...(await pushes(flaky))].map((m) => JSON.stringify(m));
  check('no push ever contained a credential name', !allBodies.some((b) => NAMES.some((n) => b.includes(n))));
  check('agent health identical to before any credential existed', (await blocked()) === healthBefore);
  const agentConnectionsAfter = await one(db, `select count(*)::int n, coalesce(string_agg(agent_id || '>' || connection_id, ',' order by agent_id, connection_id), '') s from ops.agent_connections`);
  check('ops.agent_connections untouched by every credential operation', agentConnectionsAfter.s === agentConnectionsBefore.s, { before: agentConnectionsBefore, after: agentConnectionsAfter });
  const old = await fetch(`http://127.0.0.1:${PORT}/attention`, { headers: { 'x-client-compat': '1' } });
  const oldBody = (await old.json()) as any[];
  check('an app tab at compat 1 still works (no 426) and gets the new kind in the standard item shape', old.status === 200
    && oldBody.some((i) => i.type === 'credential_expiry' && typeof i.title === 'string' && Array.isArray(i.actions) && typeof i.createdAt === 'string'), old.status);
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall credential checks passed');
process.exit(failures.length ? 1 : 0);
