// Push delivery for Needs You. The Attention Queue is canonical; a push is only a nudge that deep-links
// into the app, which re-fetches live state (a tapped notification for something already resolved just
// shows "no longer needs you"). Payloads are never authoritative.
//
//   new attention item → interruption policy → (quiet hours? defer) → claim → Web Push to every device
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { pool } from './db.js';
import { open, seal } from './connections/crypto.js';
import { listAttention, type AttentionItem } from './attention.js';
import { inQuietHours } from './quietHours.js';

// Restrained by default: interrupt only for things that need the owner. Everything else is inbox-only.
export const PUSH_KINDS = new Set([
  'approval_needed', 'brief_ready', 'deeper_ready', 'connection_problem',
  'run_failed', 'run_stuck', 'queued_too_long', 'no_executor_for_version', 'executor_unreaped',
  'action_failed', 'action_stuck',
]);

// ---------- VAPID keys: generated once, private half sealed in the database ----------

let vapid: { publicKey: string; privateKey: string } | undefined;
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (vapid) return vapid;
  const read = async () => (await pool.query(`select * from ops.app_secrets where name = 'vapid'`)).rows[0];
  let row = await read();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    const s = seal(k.privateKey, 'app_secret:vapid');
    // Replicas booting together race here; the loser adopts the winner's keys.
    await pool.query(
      `insert into ops.app_secrets (name, public_value, key_version, iv, tag, ciphertext) values ('vapid', $1, $2, $3, $4, $5)
       on conflict (name) do nothing`,
      [k.publicKey, s.keyVersion, s.iv, s.tag, s.ciphertext],
    );
    row = await read();
  }
  vapid = {
    publicKey: row.public_value,
    privateKey: open({ iv: row.iv, tag: row.tag, ciphertext: row.ciphertext, keyVersion: row.key_version }, 'app_secret:vapid'),
  };
  return vapid;
}

// ---------- devices ----------

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');

export async function registerDevice(sub: Subscription, label: string, userAgent: string) {
  if (!sub?.endpoint || !/^https?:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription');
  const hash = endpointHash(sub.endpoint);
  const s = seal(JSON.stringify(sub), `push:${hash}`);
  const { rows } = await pool.query(
    `insert into ops.push_devices (endpoint_hash, label, user_agent, key_version, iv, tag, ciphertext) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (endpoint_hash) do update set label = excluded.label, user_agent = excluded.user_agent, iv = excluded.iv, tag = excluded.tag,
       ciphertext = excluded.ciphertext, key_version = excluded.key_version, disabled_at = null, last_error = null
     returning id`,
    [hash, label.slice(0, 80), userAgent.slice(0, 300), s.keyVersion, s.iv, s.tag, s.ciphertext],
  );
  return { id: rows[0].id as string };
}

export async function listDevices() {
  const { rows } = await pool.query(
    `select id, label, created_at, last_sent_at, last_error, disabled_at from ops.push_devices order by created_at`,
  );
  return rows;
}

export async function removeDevice(id: string) {
  return (await pool.query(`delete from ops.push_devices where id = $1::uuid`, [id])).rowCount === 1;
}

type DeviceRow = { id: string; endpoint_hash: string; iv: Buffer; tag: Buffer; ciphertext: Buffer; key_version: number };
const subscriptionOf = (d: DeviceRow): Subscription =>
  JSON.parse(open({ iv: d.iv, tag: d.tag, ciphertext: d.ciphertext, keyVersion: d.key_version }, `push:${d.endpoint_hash}`));

export type PushMessage = { title: string; body: string; tag: string; url: string; kind: string };

// web-push builds the encrypted (aes128gcm) request with VAPID auth; we send it, so status handling is ours.
async function sendTo(d: DeviceRow, msg: PushMessage): Promise<'sent' | 'gone' | 'failed'> {
  const { publicKey, privateKey } = await vapidKeys();
  try {
    const req = webpush.generateRequestDetails(subscriptionOf(d), JSON.stringify(msg), {
      vapidDetails: { subject: vapidSubject(), publicKey, privateKey },
      TTL: 12 * 3600,
      urgency: msg.kind === 'approval_needed' || msg.kind === 'connection_problem' ? 'high' : 'normal',
      // Same tag → same Topic: the push service replaces an undelivered older message instead of stacking.
      topic: createHash('sha256').update(msg.tag).digest('base64url').slice(0, 32),
    });
    const res = await fetch(req.endpoint, {
      method: req.method, headers: req.headers as Record<string, string>, body: req.body ? new Uint8Array(req.body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`push service ${res.status}`), { statusCode: res.status });
    await pool.query(`update ops.push_devices set last_sent_at = now(), last_error = null where id = $1`, [d.id]);
    return 'sent';
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    const gone = status === 404 || status === 410; // subscription expired or revoked: stop using it
    await pool.query(
      `update ops.push_devices set last_error = $2, disabled_at = case when $3 then now() else disabled_at end where id = $1`,
      [d.id, (e as Error).message.slice(0, 300), gone],
    );
    return gone ? 'gone' : 'failed';
  }
}

function vapidSubject(): string {
  const base = process.env.APP_URL ?? (process.env.GOOGLE_REDIRECT_URI ? new URL(process.env.GOOGLE_REDIRECT_URI).origin : '');
  return base.startsWith('https://') ? base : 'https://agent-ops.invalid';
}

async function activeDevices(): Promise<DeviceRow[]> {
  return (await pool.query(`select * from ops.push_devices where disabled_at is null`)).rows;
}

export async function sendTest(id: string) {
  const { rows: [d] } = await pool.query(`select * from ops.push_devices where id = $1::uuid and disabled_at is null`, [id]);
  if (!d) return false;
  return (await sendTo(d, { title: 'Agent Ops', body: 'Notifications are working on this device.', tag: 'test', url: '/app/#/', kind: 'test' })) === 'sent';
}

// ---------- policy + delivery tick ----------

export function deepLink(i: AttentionItem): string {
  if (i.type === 'brief_ready') return `/app/#/brief/${encodeURIComponent(i.ref)}`;
  if (i.type === 'deeper_ready') return `/app/#/brief/${encodeURIComponent(i.ref.split('/')[0])}`;
  return `/app/#/item/${encodeURIComponent(i.type)}/${encodeURIComponent(i.ref)}`;
}

let ticking = false;
export async function notifyTick(now = new Date()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    const devices = await activeDevices();
    if (!devices.length) return 0; // nothing is claimed while no device could receive it
    const { rows: [cfg] } = await pool.query(`select value from ops.settings where key = 'notifications'`);
    // Quiet hours defer delivery; nothing is claimed, so it goes out when the window ends if still open.
    if (cfg && inQuietHours(now, cfg.value)) return 0;
    let sent = 0;
    for (const item of (await listAttention()).filter((i) => PUSH_KINDS.has(i.type))) {
      // Claim (kind, ref, since): exactly one worker wins per new or re-raised item.
      const { rowCount } = await pool.query(
        `insert into ops.attention_notifications (kind, ref, since) values ($1, $2, $3)
         on conflict (kind, ref) do update set since = excluded.since, notified_at = now()
           where ops.attention_notifications.since < excluded.since`,
        [item.type, item.ref, item.createdAt],
      );
      if (!rowCount) continue;
      const msg: PushMessage = {
        title: `${item.source}: ${item.title}`.slice(0, 80), body: item.summary.slice(0, 180), tag: item.id, url: deepLink(item), kind: item.type,
      };
      const results = await Promise.all(devices.map((d) => sendTo(d, msg)));
      sent += results.filter((r) => r === 'sent').length;
      // Nobody got it and the failure was transient (push service down, network): release the claim so
      // the next tick retries instead of silently dropping the notification.
      if (!results.includes('sent') && results.includes('failed')) {
        await pool.query(`delete from ops.attention_notifications where kind = $1 and ref = $2 and since = $3`, [item.type, item.ref, item.createdAt]);
      }
    }
    return sent;
  } finally {
    ticking = false;
  }
}

export function startNotifier(): () => void {
  const every = Number(process.env.NOTIFY_INTERVAL_MS ?? 20_000);
  const t = setInterval(() => notifyTick().catch((e) => console.error('[notify]', (e as Error).message)), every);
  return () => clearInterval(t);
}
