// External event ingress: Gmail push (users.watch → Pub/Sub → push subscription → POST /ingress/gmail).
// A push is a WAKE-UP SIGNAL, not a processing path: this module never reads or interprets mail. It
// authenticates the delivery, records one canonical row per event, and starts the existing Inbox Triage run,
// which reads from its own history cursor. The 20-minute schedule stays as the recovery path for anything
// a push misses (Google may delay or drop notifications).
//
// Delivery contract (Pub/Sub retries anything that isn't 2xx):
//   - bad/missing OIDC token     → 401/403 (not ours; Pub/Sub keeps retrying, which is visible in its metrics)
//   - unparseable payload        → 204 + recorded 'ignored' (retrying can't fix it)
//   - new event                  → record 'received' → start the run(s) → mark 'started' → 204
//   - wake fails                 → 500, row stays 'received'; the redelivery retries the wake
//   - redelivery of a done event → bump delivery_count → 204, nothing started
import crypto from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pool } from './db.js';
import { AGENT_QUEUE, agentRun } from './workflows.js';
import { watchInbox } from './connections/gmail.js';

// ---------- configuration ----------

export type PushConfig = { topic: string; audience: string; serviceAccount: string; jwksUrl: string };
/** Push is on only when the topic and the OIDC identity are configured; otherwise everything behaves as before. */
export function pushConfig(): PushConfig | null {
  const topic = process.env.GMAIL_PUSH_TOPIC, audience = process.env.PUSH_OIDC_AUDIENCE, serviceAccount = process.env.PUSH_OIDC_EMAIL;
  if (!topic || !audience || !serviceAccount) return null;
  return { topic, audience, serviceAccount, jwksUrl: process.env.PUSH_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs' };
}

// ---------- OIDC: Pub/Sub signs each push with a Google-issued ID token for our service account ----------

type Jwk = { kid?: string; kty?: string; n?: string; e?: string; [k: string]: unknown };
let jwks: { url: string; keys: Jwk[]; at: number } | null = null;
async function signingKey(url: string, kid: string): Promise<crypto.KeyObject | null> {
  const fresh = jwks && jwks.url === url && Date.now() - jwks.at < 3600_000;
  if (!fresh || !jwks!.keys.some((k) => k.kid === kid)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    jwks = { url, keys: ((await r.json()) as { keys: Jwk[] }).keys, at: Date.now() };
  }
  const k = jwks!.keys.find((x) => x.kid === kid);
  return k ? crypto.createPublicKey({ key: k, format: 'jwk' }) : null;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Verify "Authorization: Bearer <jwt>": RS256, Google issuer, our audience, our push service account. */
export async function verifyPushToken(authorization: string | undefined, cfg: PushConfig): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
  if (!token) return { ok: false, reason: 'no bearer token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return { ok: false, reason: 'malformed token' }; }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'unexpected alg' };
  const key = await signingKey(cfg.jwksUrl, header.kid);
  if (!key) return { ok: false, reason: 'unknown signing key' };
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!valid) return { ok: false, reason: 'bad signature' };
  const now = Date.now() / 1000;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(String(claims.iss))) return { ok: false, reason: 'wrong issuer' };
  if (claims.aud !== cfg.audience) return { ok: false, reason: 'wrong audience' };
  if (claims.email !== cfg.serviceAccount || claims.email_verified !== true) return { ok: false, reason: 'wrong service account' };
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) return { ok: false, reason: 'expired' };
  return { ok: true };
}

// ---------- the webhook ----------

type PushBody = { message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string }; subscription?: string };
export type IngressResult = { status: number; state: string; workflowIds?: string[]; duplicate?: boolean; reason?: string };

/** Why an agent can't run right now (paused, or a required connection is down / lacks a scope), or null. */
async function blockedReason(agentId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `select case when a.paused_at is not null then 'paused'
                 when exists (select 1 from ops.agent_connections ac join ops.connections c on c.id = ac.connection_id
                               where ac.agent_id = a.id and ac.required and (c.status <> 'active' or not (ac.scopes <@ c.scopes))) then 'blocked'
            end as reason
       from ops.agents a where a.id = $1`, [agentId]);
  return rows[0]?.reason ?? null;
}

export async function handleGmailPush(body: unknown): Promise<IngressResult> {
  const msg = (body as PushBody)?.message;
  const messageId = msg?.messageId ?? msg?.message_id;
  if (!messageId) return { status: 204, state: 'ignored', reason: 'no messageId' }; // nothing to key a row on
  let account: string | null = null, historyId: string | null = null;
  try {
    const d = JSON.parse(Buffer.from(msg?.data ?? '', 'base64').toString('utf8'));
    account = typeof d.emailAddress === 'string' ? d.emailAddress.toLowerCase() : null;
    historyId = d.historyId != null ? String(d.historyId) : null;
  } catch { /* recorded as ignored below */ }

  // One canonical row per event; a redelivery bumps delivery_count and returns the row's current state.
  const { rows: [ev] } = await pool.query(
    `insert into ops.ingress_events (source, external_id, account, history_id, state, detail)
     values ('gmail', $1, $2, $3, case when $2::text is null then 'ignored' else 'received' end, case when $2::text is null then 'unparseable payload' end)
     on conflict (source, external_id) do update set delivery_count = ops.ingress_events.delivery_count + 1, last_received_at = now()
     returning id, state, delivery_count, workflow_ids`,
    [messageId, account, historyId]);
  const duplicate = ev.delivery_count > 1;
  if (ev.state !== 'received') return { status: 204, state: ev.state, duplicate, workflowIds: ev.workflow_ids };

  // Still 'received' (new, or an earlier delivery whose wake failed): wake now. Deterministic workflow IDs,
  // so a retried wake maps onto the run it already started instead of a second one.
  const { rows: agents } = await pool.query(
    `select a.id from ops.connections c
       join ops.agent_connections ac on ac.connection_id = c.id
       join ops.agents a on a.id = ac.agent_id
      where c.provider = 'google' and lower(c.account_label) = $1 and a.enabled and a.handler = 'inbox_triage'
      order by a.id`, [account]);
  if (!agents.length) {
    await pool.query(`update ops.ingress_events set state = 'ignored', detail = 'no Inbox Triage agent for this mailbox' where id = $1`, [ev.id]);
    return { status: 204, state: 'ignored', duplicate };
  }
  const started: string[] = [], skipped: string[] = [];
  for (const a of agents) {
    const why = await blockedReason(a.id);
    if (why) { skipped.push(`${a.id}: ${why}`); continue; }
    const workflowID = `push-${a.id}-${messageId}`;
    await DBOS.startWorkflow(agentRun, { workflowID, queueName: AGENT_QUEUE })(a.id, { type: 'push', sourceEvent: messageId });
    started.push(workflowID);
  }
  const state = started.length ? 'started' : 'skipped';
  await pool.query(`update ops.ingress_events set state = $2, workflow_ids = $3, detail = $4 where id = $1`,
    [ev.id, state, started, skipped.join('; ') || null]);
  return { status: 204, state, workflowIds: started, duplicate };
}

// ---------- watch lifecycle (called from Inbox Triage's scheduled runs, as a checkpointed step) ----------

export const WATCH_KEY = 'gmail.watch';
const RENEW_EVERY_MS = 24 * 3600_000;    // Google recommends renewing daily
const RENEW_BEFORE_EXPIRY_MS = 48 * 3600_000;

export type WatchState = {
  topic: string; expiration: string | null; renewedAt: string | null;
  since: string | null;                   // when the current unbroken stretch of watching began
  lastError: string | null; lastErrorAt: string | null;
};

/**
 * Keep the watch alive. Renews when there is none, it's a day old, it expires within 48h, the topic
 * changed, or the last attempt failed. Never throws: a failed renewal is recorded (and shows in Needs You),
 * and triage carries on from the schedule. With push not configured, forgets any watch state, so an old
 * expiration can't raise an alarm about a feature that's switched off.
 */
export async function maintainWatch(agentId: string, connectionId: string, now = new Date()): Promise<string> {
  const cfg = pushConfig();
  if (!cfg) {
    const { rowCount } = await pool.query(`delete from ops.state where agent_id = $1 and key = $2`, [agentId, WATCH_KEY]);
    return rowCount ? 'push off: watch state cleared' : 'push off';
  }
  const { rows } = await pool.query(`select value from ops.state where agent_id = $1 and key = $2`, [agentId, WATCH_KEY]);
  const prev = (rows[0]?.value ?? null) as WatchState | null;
  const t = now.getTime();
  const due = !prev || prev.topic !== cfg.topic || !prev.expiration || !prev.renewedAt || prev.lastError
    || t - Date.parse(prev.renewedAt) >= RENEW_EVERY_MS || Date.parse(prev.expiration) - t <= RENEW_BEFORE_EXPIRY_MS;
  if (!due) return `watch ok until ${prev!.expiration}`;
  let next: WatchState;
  try {
    const w = await watchInbox(connectionId, cfg.topic);
    // An unbroken stretch continues only if the previous watch was still live when we renewed it.
    const unbroken = prev?.since && prev.expiration && Date.parse(prev.expiration) > t && prev.topic === cfg.topic;
    next = { topic: cfg.topic, expiration: w.expiration, renewedAt: now.toISOString(), since: unbroken ? prev!.since : now.toISOString(), lastError: null, lastErrorAt: null };
  } catch (e) {
    next = { topic: cfg.topic, expiration: prev?.expiration ?? null, renewedAt: prev?.renewedAt ?? null, since: prev?.since ?? null,
      lastError: (e as Error).message.slice(0, 300), lastErrorAt: now.toISOString() };
  }
  await pool.query(
    `insert into ops.state (agent_id, key, value) values ($1, $2, $3)
     on conflict (agent_id, key) do update set value = excluded.value, updated_at = now()`, [agentId, WATCH_KEY, next]);
  return next.lastError ? `watch renewal failed: ${next.lastError}` : `watch renewed until ${next.expiration}`;
}
