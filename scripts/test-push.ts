// Push delivery for Needs You, against a fake push service. Payloads are decrypted (aes128gcm) with each
// test device's own keys, exactly as a phone would.
// Usage (externals running, Postgres at PG_ADMIN_URL): npx tsx scripts/test-push.ts
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'http_ece';
import { EXTERNALS, freshDb, killAllWorkers, one, sleep, startWorker, waitFor } from './lib.js';
import { inQuietHours } from '../src/quietHours.js';

const PORT = 7860;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

// ---- pure: quiet hours ----
const q = { quietStart: '22:00', quietEnd: '07:00', timezone: 'America/New_York' };
check('quiet hours: 11 PM ET is quiet, wraps past midnight', inQuietHours(new Date('2026-11-04T04:00:00Z'), q) && inQuietHours(new Date('2026-11-04T10:30:00Z'), q));
check('quiet hours: 8 PM ET (brief time) is not quiet', !inQuietHours(new Date('2026-11-04T01:00:00Z'), q));
check('quiet hours: equal start/end disables them', !inQuietHours(new Date('2026-11-04T04:00:00Z'), { ...q, quietEnd: '22:00' }));

// A test "device": its own ECDH key pair + auth secret, like a browser's PushSubscription.
type Dev = ReturnType<typeof device>;
function device(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    id, ecdh, auth,
    subscription: { endpoint: `${EXTERNALS}/push/recv/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}
type Push = { id: string; headers: Record<string, string>; body: string };
const received = async (dev?: Dev) => ((await (await fetch(`${EXTERNALS}/push/admin/received`)).json()) as Push[]).filter((r) => !dev || r.id === dev.id);
const decrypt = (dev: Dev, r: Push) =>
  JSON.parse(ece.decrypt(Buffer.from(r.body, 'base64'), { version: 'aes128gcm', privateKey: dev.ecdh, authSecret: dev.auth.toString('base64url') }).toString('utf8'));
const approval = (n: number) => one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
  values ('spike-agent', 'wf', 'crm.note', 'secret-person-${n}@example.com', '{"note":"Confidential: merger talks"}', 'low', 'push:${n}') returning id`);

const { url, db } = await freshDb('spike_push');
await fetch(`${EXTERNALS}/push/admin/reset`, { method: 'POST' });
const KEY = randomBytes(32).toString('base64');
const env = { CONNECTION_KEY: KEY, NOTIFY_INTERVAL_MS: '300', NOTIFY_RETRY_BASE_MS: '400', APP_URL: 'https://ops.example' };
// Two replicas; the VAPID key pair is created lazily on first use, so the race is two first requests at once.
const w = await startWorker({ id: 'push-1', port: PORT, dbUrl: url, env });
const w2 = await startWorker({ id: 'push-2', port: PORT + 1, dbUrl: url, env: { ...env, NOTIFY_INTERVAL_MS: '3600000' } });
const settle = () => sleep(1500);

try {
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  const [c1, c2] = await Promise.all([w.http('GET', '/app/config'), w2.http('GET', '/app/config')]);
  const n = await one(db, `select count(*)::int n from ops.app_secrets where name = 'vapid'`);
  check('two replicas generating at the same moment end up with ONE sealed VAPID key pair', n.n === 1 && c1.body.pushPublicKey === c2.body.pushPublicKey
    && typeof c1.body.pushPublicKey === 'string', { n, k1: c1.body.pushPublicKey, k2: c2.body.pushPublicKey });

  const old = await approval(0);
  await settle();
  check('no device → nothing planned or sent', !(await one(db, `select 1 from ops.notification_deliveries`)) && (await received()).length === 0);

  const phone = device('phone');
  const pc = device('flaky'); // the push service fails this one twice before accepting
  const regP = await w.http('POST', '/push/devices', { subscription: phone.subscription, label: 'Android · Chrome' });
  const regC = await w.http('POST', '/push/devices', { subscription: pc.subscription, label: 'Windows · Chrome' });
  const stored = await one(db, `select ciphertext from ops.push_devices where id = $1`, [regP.body.id]);
  check('devices registered; endpoints stored sealed', regP.status === 200 && regC.status === 200 && !Buffer.from(stored.ciphertext).toString('utf8').includes('push/recv'));
  await settle();
  check('turning notifications on does not replay items raised before the device subscribed', (await received()).length === 0, (await received()).length);

  const a1 = await approval(1);
  await waitFor('phone push', async () => (await received(phone)).length >= 1, 10_000);
  const m1 = decrypt(phone, (await received(phone))[0]);
  const raw = JSON.stringify(m1);
  check('lock-screen text is modest: what needs you, no names or details', m1.title === 'Agent Ops' && /actions? need(s)? your approval/.test(m1.body)
    && !/secret-person|merger|Confidential/.test(raw), m1);
  check('approvals share one notification tag; the link opens the app', m1.tag === 'approval_needed' && m1.url.startsWith('/app/#/'), m1);
  const h = (await received(phone))[0].headers;
  check('push carries VAPID auth, a TTL and a Topic', /^vapid /.test(h.authorization ?? '') && Number(h.ttl) > 0 && (h.topic ?? '').length > 0, h);

  // Per-device: the PC failed transiently; it is retried on its own until it gets the same item.
  await waitFor('pc retried', async () => (await received(pc)).length >= 1, 15_000);
  const d1 = await one(db, `select status, attempts from ops.notification_deliveries where ref = $1 and device_id = $2`, [a1.id, regC.body.id]);
  const dp = await one(db, `select status, attempts from ops.notification_deliveries where ref = $1 and device_id = $2`, [a1.id, regP.body.id]);
  check('transient failure on one device is retried for that device only (phone sent once, PC on attempt 3)',
    d1.status === 'sent' && d1.attempts === 3 && dp.status === 'sent' && dp.attempts === 1 && (await received(phone)).length === 1, { pc: d1, phone: dp });
  await settle();
  check('a delivered item is not pushed again', (await received(phone)).length === 1 && (await received(pc)).length === 1);

  // Inbox-only kinds never interrupt.
  await db.query(`insert into ops.briefs (agent_id, brief_date, timezone, time_min, time_max, connection_id, source_workflow_id, items, mirror_status, mirror_error)
    values ('calendar-prep', ((now() at time zone 'America/New_York')::date + 1), 'America/New_York', now(), now(), 'google:primary', 'wf', '[]', 'failed', 'x')`);
  await settle();
  check('inbox-only item (calendar mirror failed) is not pushed', (await received(phone)).length === 1);

  // Quiet hours defer, they don't drop; release happens without any new event.
  await db.query(`update ops.settings set value = jsonb_build_object('quietStart', '00:00', 'quietEnd', '23:59', 'timezone', 'UTC') where key = 'notifications'`);
  const inQuiet = new Date().getUTCHours() * 60 + new Date().getUTCMinutes() < 23 * 60 + 59;
  const a2 = await approval(2);
  await settle();
  check('during quiet hours a new approval is held back', !inQuiet || (await received(phone)).length === 1);
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  await waitFor('released', async () => (await received(phone)).length >= 2, 10_000);
  check('…and released when quiet hours end, counting open approvals', /3 actions need your approval/.test(decrypt(phone, (await received(phone))[1]).body),
    decrypt(phone, (await received(phone))[1]));

  // A revoked subscription (410) retires that device only; the phone keeps receiving.
  const gone = device('gone');
  const regG = await w.http('POST', '/push/devices', { subscription: gone.subscription, label: 'Old laptop' });
  const test = await w.http('POST', `/push/devices/${regP.body.id}/test`);
  check('test notification reaches the device', test.status === 200 && decrypt(phone, (await received(phone)).at(-1)!).kind === 'test', test.body);
  await w.http('POST', `/actions/${old.id}/reject`);
  await w.http('POST', `/actions/${a1.id}/reject`);
  await w.http('POST', `/actions/${a2.id}/reject`);
  const a3 = await approval(3);
  await waitFor('a3 to phone', async () => (await received(phone)).some((r) => decrypt(phone, r).body === '1 action needs your approval'), 10_000);
  await waitFor('gone retired', async () => Boolean((await one(db, `select disabled_at from ops.push_devices where id = $1`, [regG.body.id])).disabled_at), 10_000);
  const g = await one(db, `select status from ops.notification_deliveries where ref = $1 and device_id = $2`, [a3.id, regG.body.id]);
  check('a 410 retires that device and its delivery is "gone"; others still receive', g?.status === 'gone', g);
  const again = await w.http('POST', '/push/devices', { subscription: gone.subscription, label: 'Old laptop' });
  const back = await one(db, `select disabled_at from ops.push_devices where id = $1`, [again.body.id]);
  check('re-enabling the same browser re-activates its device record cleanly', again.body.id === regG.body.id && back.disabled_at === null, back);

  const before = (await received(phone)).length;
  await w.http('POST', `/actions/${a3.id}/reject`);
  await settle();
  check('a resolved item produces no further pushes', (await received(phone)).length === before);

  const devs = (await w.http('GET', '/push/devices')).body as any[];
  check('devices list exposes no endpoints or keys', devs.length === 3 && devs.every((d) => !('ciphertext' in d) && !('endpoint_hash' in d)), devs);
  const del = await w.http('DELETE', `/push/devices/${regG.body.id}`);
  check('a device can be removed (and its deliveries with it)', del.status === 200
    && !(await one(db, `select 1 from ops.notification_deliveries where device_id = $1`, [regG.body.id])));
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall push checks passed');
process.exit(failures.length ? 1 : 0);
