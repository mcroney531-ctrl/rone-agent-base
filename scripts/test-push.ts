// Push delivery for Needs You, against a fake push service. Payloads are decrypted (aes128gcm) with the
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
function device(id: string) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh, auth,
    subscription: { endpoint: `${EXTERNALS}/push/recv/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}
const received = async () => (await (await fetch(`${EXTERNALS}/push/admin/received`)).json()) as { id: string; headers: Record<string, string>; body: string }[];
const decrypt = (dev: ReturnType<typeof device>, body: string) =>
  JSON.parse(ece.decrypt(Buffer.from(body, 'base64'), { version: 'aes128gcm', privateKey: dev.ecdh, authSecret: dev.auth.toString('base64url') }).toString('utf8'));

const { url, db } = await freshDb('spike_push');
await fetch(`${EXTERNALS}/push/admin/reset`, { method: 'POST' });
const w = await startWorker({
  id: 'push-1', port: PORT, dbUrl: url,
  env: { CONNECTION_KEY: randomBytes(32).toString('base64'), NOTIFY_INTERVAL_MS: '500', APP_URL: 'https://ops.example' },
});
const settle = () => sleep(1500); // a few notifier ticks

try {
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  const cfg = (await w.http('GET', '/app/config')).body;
  check('VAPID public key generated and published; private key stored sealed', typeof cfg.pushPublicKey === 'string' && cfg.pushPublicKey.length > 60
    && Boolean(await one(db, `select 1 from ops.app_secrets where name = 'vapid' and ciphertext is not null`)), cfg);

  // Nothing is claimed while there is no device to deliver to.
  const a1 = await one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
    values ('spike-agent', 'wf', 'crm.note', 'ada@example.com', '{"note":"x"}', 'low', 'push:1') returning id`);
  await settle();
  check('no device yet → nothing claimed or sent', !(await one(db, `select 1 from ops.attention_notifications`)) && (await received()).length === 0);

  const phone = device('phone');
  const reg = await w.http('POST', '/push/devices', { subscription: phone.subscription, label: 'Android · Chrome' });
  const stored = await one(db, `select ciphertext from ops.push_devices where id = $1`, [reg.body.id]);
  check('device registered; endpoint stored sealed, not in plaintext', reg.status === 200 && !Buffer.from(stored.ciphertext).toString('utf8').includes('push/recv'), reg);

  await waitFor('first push', async () => (await received()).length >= 1, 10_000);
  const r1 = (await received())[0];
  const m1 = decrypt(phone, r1.body);
  check('approval → one push with title, body, stable tag and a deep link to the item', m1.kind === 'approval_needed' && m1.tag === `approval_needed:${a1.id}`
    && m1.url === `/app/#/item/approval_needed/${a1.id}` && /approve\?/.test(m1.title) && Boolean(m1.body), m1);
  check('push carries VAPID auth, a TTL, and a Topic so repeats collapse', /^vapid /.test(r1.headers.authorization ?? '') && Number(r1.headers.ttl) > 0
    && (r1.headers.topic ?? '').length > 0, r1.headers);
  await settle();
  check('the same open item is not pushed again', (await received()).length === 1, (await received()).length);

  // Inbox-only kinds never interrupt.
  await db.query(`insert into ops.briefs (agent_id, brief_date, timezone, time_min, time_max, connection_id, source_workflow_id, items, mirror_status, mirror_error)
    values ('calendar-prep', ((now() at time zone 'America/New_York')::date + 1), 'America/New_York', now(), now(), 'google:primary', 'wf', '[]', 'failed', 'x')`);
  await settle();
  check('inbox-only item (calendar mirror failed) is not pushed', (await received()).length === 1);

  // Quiet hours defer, they don't drop.
  await db.query(`update ops.settings set value = jsonb_build_object('quietStart', '00:00', 'quietEnd', '23:59', 'timezone', 'UTC') where key = 'notifications'`);
  const a2 = await one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
    values ('spike-agent', 'wf', 'crm.note', 'bob@example.com', '{"note":"y"}', 'low', 'push:2') returning id`);
  const inQuiet = new Date().getUTCHours() * 60 + new Date().getUTCMinutes() < 23 * 60 + 59;
  await settle();
  check('during quiet hours a new approval is held back', !inQuiet || (await received()).length === 1);
  await db.query(`update ops.settings set value = value || '{"quietStart":"00:00","quietEnd":"00:00"}' where key = 'notifications'`);
  await waitFor('deferred push', async () => (await received()).length >= 2, 10_000);
  check('…and delivered once quiet hours end', decrypt(phone, (await received())[1].body).tag === `approval_needed:${a2.id}`);

  // Several devices; an expired one is retired, the live one still receives.
  const gone = device('gone');
  const reg2 = await w.http('POST', '/push/devices', { subscription: gone.subscription, label: 'Old laptop' });
  const test = await w.http('POST', `/push/devices/${reg.body.id}/test`);
  check('test notification reaches the device', test.status === 200 && decrypt(phone, (await received()).at(-1)!.body).kind === 'test', test.body);
  const a3 = await one(db, `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
    values ('spike-agent', 'wf', 'crm.note', 'cy@example.com', '{"note":"z"}', 'low', 'push:3') returning id`);
  await waitFor('third push', async () => (await received()).some((r) => r.id === 'phone' && decrypt(phone, r.body).tag === `approval_needed:${a3.id}`), 10_000);
  const goneRow = await one(db, `select disabled_at, last_error from ops.push_devices where id = $1`, [reg2.body.id]);
  check('a 410 from the push service retires that device; others keep receiving', Boolean(goneRow.disabled_at) && /410/.test(goneRow.last_error), goneRow);

  // Re-raised item (newer `since`) is pushed again; resolved items are simply not re-sent.
  await w.http('POST', `/actions/${a1.id}/reject`);
  const before = (await received()).length;
  await settle();
  check('a resolved item produces no further pushes', (await received()).length === before);

  const devs = (await w.http('GET', '/push/devices')).body as any[];
  check('devices list for the phone UI (no endpoints exposed)', devs.length === 2 && devs.every((d) => !('ciphertext' in d) && !('endpoint_hash' in d)), devs);
  const del = await w.http('DELETE', `/push/devices/${reg2.body.id}`);
  check('a device can be removed', del.status === 200 && (await w.http('GET', '/push/devices')).body.length === 1);
} finally {
  await killAllWorkers();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall push checks passed');
process.exit(failures.length ? 1 : 0);
