// Credential Watch V1A: a deadline tracker for credentials (spec: Agent Hub, credential-watch/v1a-spec.md rev 3).
//
// Deterministic and nonblocking: no workflow, no model, no probes. Nothing here writes connection status or
// touches ops.agent_connections, so tracking a credential can never block an agent. Values are never stored:
// secret_ref is where a secret lives, by name, and every free-text field refuses anything key-shaped.
//
// Warnings are the Attention Queue's `credential_expiry` item (sql/002_views.sql), one per credential, raised
// again at each stage (14 days, 7 days, date passed). This module owns the only writer of the stored stage:
// the date-edit path below.
import type pg from 'pg';
import { pool, withTx } from './db.js';

export const KINDS = ['oauth', 'api_key', 'pat', 'admin_key', 'secret', 'other'] as const;
export const DATE_KINDS = ['expires', 'provider_target', 'review_by'] as const;
export type DateKind = (typeof DATE_KINDS)[number];

export class CredentialError extends Error {}

const OWNER_TZ = () => process.env.OWNER_TIMEZONE ?? 'America/New_York';

// One implementation of "looks like a secret": the SQL function the secret_ref constraint uses.
async function assertNoSecrets(c: pg.PoolClient | pg.Pool, fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, v]) => typeof v === 'string' && v !== '') as [string, string][];
  if (!entries.length) return;
  const { rows } = await c.query(`select x.n from unnest($1::text[], $2::text[]) as x(n, v) where ops.looks_like_secret(x.v)`,
    [entries.map(([k]) => k), entries.map(([, v]) => v)]);
  if (rows.length) throw new CredentialError(`That looks like a secret value in "${rows[0].n}". Store where it lives (e.g. railway:worker/ANTHROPIC_API_KEY), never the value.`);
}

function text(v: unknown, name: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new CredentialError(`${name} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw new CredentialError(`${name} must be text.`);
  const s = v.trim();
  if (s.length > max) throw new CredentialError(`${name} is too long (max ${max}).`);
  if (required && !s) throw new CredentialError(`${name} is required.`);
  return s || null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new CredentialError(`${name} must be one of: ${allowed.join(', ')}.`);
  return v as T;
}

function url(v: unknown): string | null {
  const s = text(v, 'Renewal URL', 500);
  if (s && !/^https:\/\//.test(s)) throw new CredentialError('Renewal URL must start with https://');
  return s;
}

/**
 * A date the owner typed. A bare day (2026-12-31, what the app's date picker sends) means "through the end of
 * that day" in the owner's timezone; anything else must be a full ISO timestamp. null = no date.
 */
async function parseDate(c: pg.PoolClient, v: unknown): Promise<Date | null> {
  if (v === undefined || v === null || v === '' || v === 'none') return null;
  if (typeof v !== 'string') throw new CredentialError('Date must be YYYY-MM-DD or an ISO timestamp.');
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const { rows } = await c.query(`select (($1::date + 1)::timestamp at time zone $2) as t`, [v, OWNER_TZ()]);
    return rows[0].t;
  }
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(d.getTime())) throw new CredentialError('Date must be YYYY-MM-DD or an ISO timestamp.');
  return d;
}

/**
 * The date-edit path: the ONLY writer of alert_stage / alert_stage_since. In the same transaction as the date
 * change, with the row locked:
 *   old effective stage = max(stored, computed from the old date); old effective since = ops.credential_since
 *   new stage > old effective stage  → the edit escalated: since = now() (one new warning)
 *   otherwise                        → carry the old since (no new warning, an ack keeps holding)
 * and the stored stage becomes the new computed stage. Time only raises the computed stage, so afterwards
 * computed >= stored holds again.
 */
async function setDate(c: pg.PoolClient, id: string, date: Date | null) {
  const { rows: [o] } = await c.query(
    `select greatest(alert_stage, ops.credential_stage(expires_at, now())) as stage,
            ops.credential_since(expires_at, alert_stage, alert_stage_since, now()) as since
       from ops.connections where id = $1 for update`, [id]);
  await c.query(
    `update ops.connections
        set expires_at = $2,
            alert_stage = ops.credential_stage($2, now()),
            alert_stage_since = case when ops.credential_stage($2, now()) > $3 then now() else $4 end,
            updated_at = now()
      where id = $1`, [id, date, o.stage, o.since]);
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'credential';
}

export type CredentialInput = {
  name?: unknown; provider?: unknown; kind?: unknown; date?: unknown; dateKind?: unknown;
  secretRef?: unknown; renewUrl?: unknown; notes?: unknown;
};

export async function createCredential(input: CredentialInput): Promise<{ id: string }> {
  const name = text(input.name, 'Name', 80, true)!;
  const provider = text(input.provider, 'Provider', 40, true)!.toLowerCase();
  if (!/^[a-z0-9_.-]{1,40}$/.test(provider)) throw new CredentialError('Provider must be a short lowercase name, e.g. anthropic.');
  const kind = oneOf(input.kind ?? 'api_key', KINDS, 'Kind');
  const dateKind = oneOf(input.dateKind ?? 'expires', DATE_KINDS, 'Date kind');
  const secretRef = text(input.secretRef, 'Where it is stored', 200);
  const renewUrl = url(input.renewUrl);
  const notes = text(input.notes, 'Notes', 2000);
  return withTx(async (c) => {
    await assertNoSecrets(c, { name, secretRef, notes, renewUrl });
    const date = await parseDate(c, input.date);
    // Ids are never reused, not even a removed credential's: its consumers and checks stay with it.
    const base = `cred:${slug(name)}`;
    const { rows: taken } = await c.query(`select id from ops.connections where id = $1 or id like $1 || '-%'`, [base]);
    const used = new Set(taken.map((r) => r.id));
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    await c.query(
      `insert into ops.connections (id, provider, status, display_name, kind, managed_by, secret_ref, date_kind, renew_url, notes, last_checked_at)
       values ($1, $2, 'active', $3, $4, 'manual', $5, $6, $7, $8, null)`,
      [id, provider, name, kind, secretRef, dateKind, renewUrl, notes]);
    await setDate(c, id, date); // registration counts as an edit: inside a window, it warns once, now
    return { id };
  });
}

/** Only manual, unremoved credentials are edited here; integration rows (Google) are read-only. */
async function lockManual(c: pg.PoolClient, id: string) {
  const { rows: [r] } = await c.query(`select managed_by, removed_at from ops.connections where id = $1 and kind is not null for update`, [id]);
  if (!r || r.removed_at) return 'missing' as const;
  if (r.managed_by !== 'manual') return 'integration' as const;
  return 'ok' as const;
}

export async function updateCredential(id: string, patch: CredentialInput): Promise<'ok' | 'missing' | 'integration'> {
  return withTx(async (c) => {
    const state = await lockManual(c, id);
    if (state !== 'ok') return state;
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const has = (k: keyof CredentialInput) => Object.prototype.hasOwnProperty.call(patch, k);
    const checks: Record<string, unknown> = {};
    if (has('name')) { const v = text(patch.name, 'Name', 80, true); checks.name = v; set('display_name', v); }
    if (has('kind')) set('kind', oneOf(patch.kind, KINDS, 'Kind'));
    if (has('dateKind')) set('date_kind', oneOf(patch.dateKind, DATE_KINDS, 'Date kind'));
    if (has('secretRef')) { const v = text(patch.secretRef, 'Where it is stored', 200); checks.secretRef = v; set('secret_ref', v); }
    if (has('renewUrl')) { const v = url(patch.renewUrl); checks.renewUrl = v; set('renew_url', v); }
    if (has('notes')) { const v = text(patch.notes, 'Notes', 2000); checks.notes = v; set('notes', v); }
    await assertNoSecrets(c, checks);
    if (sets.length) await c.query(`update ops.connections set ${sets.join(', ')}, updated_at = now() where id = $1`, vals);
    if (has('date')) await setDate(c, id, await parseDate(c, patch.date));
    return 'ok';
  });
}

/** "Renewed" from Needs You: a new date, or none ("doesn't expire"). Runs the edit path. */
export async function renewCredential(id: string, choice: string): Promise<{ ok: boolean; message: string }> {
  return withTx(async (c) => {
    const state = await lockManual(c, id);
    if (state !== 'ok') return { ok: false, message: 'This credential can only be changed where it is managed.' };
    const date = choice === 'none' ? null : await parseDate(c, choice);
    if (date && date.getTime() <= Date.now()) return { ok: false, message: 'Pick a date in the future.' };
    await setDate(c, id, date);
    return { ok: true, message: date ? 'Updated. Warnings restart from the new date.' : 'Updated: no expiry tracked.' };
  });
}

/** Retire ("not needed"): soft removal, the same mechanism feed sources use. Its item leaves the queue. */
export async function retireCredential(id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update ops.connections set removed_at = now(), updated_at = now() where id = $1 and managed_by = 'manual' and kind is not null and removed_at is null`, [id]);
  return rowCount === 1;
}

async function assertTracked(c: pg.PoolClient, id: string) {
  const { rows } = await c.query(`select 1 from ops.connections where id = $1 and kind is not null and removed_at is null`, [id]);
  if (!rows.length) throw new CredentialError('No such credential.');
}

export async function addConsumer(id: string, b: { consumer?: unknown; confidence?: unknown; evidence?: unknown; agentId?: unknown }, by: string) {
  const consumer = text(b.consumer, 'Consumer', 200, true)!;
  const evidence = text(b.evidence, 'Evidence', 500, true)!;
  const confidence = oneOf(b.confidence ?? 'candidate', ['confirmed', 'candidate'] as const, 'Confidence');
  const agentId = text(b.agentId, 'Agent', 80);
  return withTx(async (c) => {
    await assertTracked(c, id);
    await assertNoSecrets(c, { consumer, evidence });
    if (agentId && !(await c.query(`select 1 from ops.agents where id = $1`, [agentId])).rows.length) throw new CredentialError('No such agent.');
    const { rows: [r] } = await c.query(
      `insert into ops.credential_consumers (connection_id, consumer, confidence, evidence, agent_id, noted_by) values ($1, $2, $3, $4, $5, $6) returning id`,
      [id, consumer, confidence, evidence, agentId, by]);
    return { id: String(r.id) };
  });
}

export async function removeConsumer(id: string, consumerId: string): Promise<boolean> {
  if (!/^\d{1,18}$/.test(consumerId)) return false;
  const { rowCount } = await pool.query(`delete from ops.credential_consumers where id = $2 and connection_id = $1`, [id, consumerId]);
  return rowCount === 1;
}

export async function addCheck(id: string, b: { scope?: unknown; result?: unknown }, by: string) {
  const scope = text(b.scope, 'What was checked', 300, true)!;
  const result = text(b.result, 'Result', 500, true)!;
  return withTx(async (c) => {
    await assertTracked(c, id);
    await assertNoSecrets(c, { scope, result });
    const { rows: [r] } = await c.query(
      `insert into ops.credential_checks (connection_id, scope, result, noted_by) values ($1, $2, $3, $4) returning id`, [id, scope, result, by]);
    return { id: String(r.id) };
  });
}

const STAGE_SQL = `ops.credential_stage(c.expires_at, now())`;
const DETAIL_COLS = `c.id, c.display_name, c.provider, c.kind, c.managed_by, c.status, c.secret_ref, c.date_kind, c.expires_at,
  c.renew_url, c.notes, c.account_label, ${STAGE_SQL} as stage,
  case when c.expires_at is null then null else floor(extract(epoch from c.expires_at - now()) / 86400)::int end as days_left,
  coalesce((select jsonb_agg(jsonb_build_object('id', x.id::text, 'consumer', x.consumer, 'confidence', x.confidence, 'evidence', x.evidence,
            'agentId', x.agent_id, 'notedAt', x.noted_at) order by x.confidence, x.noted_at)
     from ops.credential_consumers x where x.connection_id = c.id), '[]') as consumers,
  coalesce((select jsonb_agg(jsonb_build_object('id', k.id::text, 'scope', k.scope, 'result', k.result, 'checkedAt', k.checked_at) order by k.checked_at)
     from ops.credential_checks k where k.connection_id = c.id), '[]') as checks`;

/** Every tracked credential (integration rows read-only), soonest date first, undated last. */
export async function listCredentials() {
  const { rows } = await pool.query(
    `select ${DETAIL_COLS} from ops.connections c where c.kind is not null and c.removed_at is null
      order by c.expires_at nulls last, c.display_name nulls last, c.id`);
  return rows;
}

export async function getCredential(id: string) {
  const { rows } = await pool.query(`select ${DETAIL_COLS} from ops.connections c where c.id = $1 and c.kind is not null`, [id]);
  return rows[0] ?? null;
}

// ---------- presentation shared by Needs You and the Credentials card ----------

export const KNOWN_ONLY = 'Known consumers only. This list has not been shown to be complete.';

export const DATE_KIND_LABEL: Record<DateKind, string> = {
  expires: 'Expires',
  provider_target: 'Provider deprecation target (not final)',
  review_by: 'Review by',
};

/** "Known impact", derived and always qualified by what was (and wasn't) checked. Never a claim of completeness. */
export function knownImpact(consumers: { confidence: string }[], checks: { scope: string; result: string }[]): string {
  const confirmed = consumers.filter((x) => x.confidence === 'confirmed').length;
  const candidate = consumers.length - confirmed;
  const who = consumers.length ? `${confirmed} confirmed, ${candidate} candidate consumer${candidate === 1 ? '' : 's'}` : 'No known consumers recorded';
  const checked = checks.length ? `checked: ${checks.map((k) => `${k.scope} (${k.result})`).join('; ')}` : 'nothing recorded as checked';
  return `${who}; ${checked}. Others may exist.`;
}
