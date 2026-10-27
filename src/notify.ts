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

// Lock-screen text stays modest: what kind of thing needs you, never meeting names or details. Those
// appear after opening the authenticated app. Approvals share one notification that counts them.
export function messageFor(item: AttentionItem, open: AttentionItem[]): PushMessage {
  const base = { title: 'Agent Ops', kind: item.type, url: deepLink(item), tag: item.id };
  switch (item.type) {
    case 'approval_needed': {
      const n = open.filter((i) => i.type === 'approval_needed').length;
      return { ...base, tag: 'approval_needed', url: n === 1 ? deepLink(item) : '/app/#/', body: n === 1 ? '1 action needs your approval' : `${n} actions need your approval` };
    }
    case 'brief_ready': return { ...base, body: `${item.source} brief is ready` };
    case 'deeper_ready': return { ...base, body: 'Deeper prep is ready' };
    case 'connection_problem': return { ...base, body: `${item.source} connection needs attention` };
    case 'run_failed': return { ...base, body: `${item.source}: a run failed` };
    case 'action_failed': return { ...base, body: `${item.source}: an action could not be completed` };
    default: return { ...base, body: `${item.source} needs attention` };
  }
}

const MAX_ATTEMPTS = 8;
const retryDelayMs = (attempts: number) =>
  Math.min(Number(process.env.NOTIFY_RETRY_BASE_MS ?? 30_000) * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);

let ticking = false;
// One delivery per (open item, device). Each device is retried on its own; a 404/410 retires only that
// device. An item is done once every active device has it or is gone.
export async function notifyTick(now = new Date()): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  try {
    if (!(await activeDevices()).length) return 0;
    const { rows: [cfg] } = await pool.query(`select value from ops.settings where key = 'notifications'`);
    // Quiet hours: nothing is claimed or sent; pending deliveries go out when the window ends if still open.
    if (cfg && inQuietHours(now, cfg.value)) return 0;
    const open = (await listAttention()).filter((i) => PUSH_KINDS.has(i.type));
    if (!open.length) return 0;
    const kinds = open.map((i) => i.type);
    const refs = open.map((i) => i.ref);

    // Plan: a delivery per (item, device), for items raised after the device subscribed (turning
    // notifications on doesn't replay the backlog). A re-raised item (newer `since`) starts over.
    await pool.query(
      `insert into ops.notification_deliveries (kind, ref, device_id, since)
       select i.kind, i.ref, d.id, i.since
         from unnest($1::text[], $2::text[], $3::timestamptz[]) as i(kind, ref, since)
         join ops.push_devices d on d.disabled_at is null and i.since >= d.created_at
       on conflict (kind, ref, device_id) do update set since = excluded.since, status = 'pending', attempts = 0,
         next_attempt_at = now(), last_error = null, sent_at = null
         where ops.notification_deliveries.since < excluded.since`,
      [kinds, refs, open.map((i) => i.createdAt)],
    );

    // Claim due deliveries of still-open items. The lease (next_attempt_at pushed out) makes this safe
    // across replicas and lets a crashed worker's claim expire into a retry.
    const { rows: due } = await pool.query(
      `update ops.notification_deliveries d set next_attempt_at = now() + interval '2 minutes', attempts = d.attempts + 1
        where (d.kind, d.ref, d.device_id) in (
          select x.kind, x.ref, x.device_id
            from ops.notification_deliveries x
            join unnest($1::text[], $2::text[]) as i(kind, ref) on i.kind = x.kind and i.ref = x.ref
            join ops.push_devices p on p.id = x.device_id and p.disabled_at is null
           where x.status in ('pending', 'failed') and x.next_attempt_at <= now()
           for update of x skip locked)
        returning d.kind, d.ref, d.device_id, d.attempts`,
      [kinds, refs],
    );
    if (!due.length) return 0;

    const devices = new Map((await activeDevices()).map((d) => [d.id, d]));
    const byId = new Map(open.map((i) => [`${i.type}:${i.ref}`, i]));
    const results = await Promise.all(due.map(async (r) => {
      const item = byId.get(`${r.kind}:${r.ref}`)!;
      const device = devices.get(r.device_id);
      const outcome = device ? await sendTo(device, messageFor(item, open)) : 'gone';
      if (outcome === 'sent') {
        await pool.query(`update ops.notification_deliveries set status = 'sent', sent_at = now(), last_error = null where kind = $1 and ref = $2 and device_id = $3`, [r.kind, r.ref, r.device_id]);
      } else if (outcome === 'gone') {
        await pool.query(`update ops.notification_deliveries set status = 'gone' where kind = $1 and ref = $2 and device_id = $3`, [r.kind, r.ref, r.device_id]);
      } else {
        const giveUp = r.attempts >= MAX_ATTEMPTS;
        await pool.query(
          `update ops.notification_deliveries set status = $4, next_attempt_at = now() + ($5 || ' milliseconds')::interval,
                  last_error = (select last_error from ops.push_devices where id = $3)
            where kind = $1 and ref = $2 and device_id = $3`,
          [r.kind, r.ref, r.device_id, giveUp ? 'abandoned' : 'failed', String(retryDelayMs(r.attempts))],
        );
      }
      return outcome;
    }));
    return results.filter((o) => o === 'sent').length;
  } finally {
    ticking = false;
  }
}

export function startNotifier(): () => void {
  const every = Number(process.env.NOTIFY_INTERVAL_MS ?? 20_000);
  const t = setInterval(() => notifyTick().catch((e) => console.error('[notify]', (e as Error).message)), every);
  return () => clearInterval(t);
}
