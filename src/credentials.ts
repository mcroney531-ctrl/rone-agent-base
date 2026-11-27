// Credential Watch V1A: a deadline tracker for credentials (spec: Agent Hub, credential-watch/v1a-spec.md rev 3).
//
// Deterministic and nonblocking: no workflow, no model, no probes. Nothing here writes connection status or
// touches ops.agent_connections, so tracking a credential can never block an agent. Values are never stored:
// secret_ref is where a secret lives, by name (DB-enforced, versioned CHECK); other free text gets a
// best-effort API check. See docs/credential-watch.md "Secret handling" for the exact boundary.
//
// Warnings are the Attention Queue's `credential_expiry` item (sql/002_views.sql), one per credential, raised
// again at each stage (14 days, 7 days, date passed). This module owns the only writer of the stored stage:
// the date-edit path below.
import type pg from 'pg';
import { createHash } from 'node:crypto';
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
    // Validate the calendar day in JS first: an impossible day (2026-02-31) is the owner's typo, a 400, not a 500.
    const [y, m, d] = v.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw new CredentialError(`${v} is not a real date.`);
    const { rows } = await c.query(`select (($1::date + 1)::timestamp at time zone $2) as t`, [v, OWNER_TZ()]);
    return rows[0].t;
  }
  // A full timestamp must carry its offset (Z or ±hh:mm): without one, JS would read it in the SERVER's zone.
  const d = new Date(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(d.getTime())) {
    throw new CredentialError('Date must be YYYY-MM-DD, or an ISO timestamp with its offset (e.g. 2026-12-31T17:00:00Z).');
  }
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

/** Request bodies must be JSON objects ("null", arrays and strings are a 400, not a crash). */
export function asObject<T>(b: unknown): T {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new CredentialError('Body must be a JSON object.');
  return b as T;
}

// ---------- managed writes: who, on what evidence, against which version ----------
//
// Every mutation runs in one transaction that also writes its ops.credential_events row (atomic audit) and,
// when an Idempotency-Key is given, its ops.credential_requests row (safe retries). The owner (and the API
// token, which is the owner's scripts) writes as before. The scoped agent identity is held to stricter rules,
// enforced here as well as by the route allowlist in src/auth.ts:
//   - every write carries an Idempotency-Key and evidence {level: provider_verified | inferred, note}
//   - every change to an existing credential names the version it read (ifVersion); stale → 409
//   - it may not retire, remove a consumer, renew from Needs You, or remove a deadline
//   - extending a deadline needs provider_verified evidence
//   - it may not overwrite a field whose current evidence is stronger than its own; owner-set fields
//     (owner_confirmed, and every pre-existing value) are never overwritten by the agent
// See docs/credential-watch.md "Managed writes".

export const LEVELS = ['provider_verified', 'owner_confirmed', 'inferred'] as const;
export type Level = (typeof LEVELS)[number];
const RANK: Record<Level, number> = { inferred: 1, provider_verified: 2, owner_confirmed: 3 };

export type Actor = { label: string; agent: boolean };
export type Evidence = { level: Level; note: string };
export type WriteCtx = { actor: Actor; key?: string; ifVersion?: unknown; evidence?: unknown };
export type Result = { status: number; body: unknown };

/** A refusal that is not the caller's syntax: stale version, weaker evidence, duplicate, key reuse. */
export class ConflictError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}

const conflict = (message: string, detail: Record<string, unknown> = {}) => new ConflictError(message, detail);

function evidenceFor(ctx: WriteCtx): Evidence {
  if (!ctx.actor.agent) return { level: 'owner_confirmed', note: '' };
  const e = ctx.evidence as { level?: unknown; note?: unknown } | undefined;
  if (!e || typeof e !== 'object' || Array.isArray(e)) throw new CredentialError('evidence {level, note} is required.');
  const level = oneOf(e.level, ['provider_verified', 'inferred'] as const, 'evidence.level');
  const note = text(e.note, 'evidence.note', 500, true)!;
  return { level, note };
}

function versionFor(ctx: WriteCtx, required: boolean): number | null {
  if (ctx.ifVersion === undefined || ctx.ifVersion === null) {
    if (required) throw new CredentialError('ifVersion (the version you read) is required.');
    return null;
  }
  if (typeof ctx.ifVersion !== 'number' || !Number.isSafeInteger(ctx.ifVersion) || ctx.ifVersion < 1) throw new CredentialError('ifVersion must be a positive integer.');
  return ctx.ifVersion;
}

/** The agent states exactly what it is changing: unknown fields are a 400, not silently ignored. */
function onlyFields(body: Record<string, unknown>, allowed: readonly string[], actor: Actor) {
  if (!actor.agent) return;
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new CredentialError(`Not allowed for this identity: ${extra.join(', ')}.`);
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Run one mutation: transaction, idempotency, audit-in-the-same-transaction. `run` does the change and
 * returns the response; it writes its own audit rows through audit(). A key seen before with the same
 * request returns the stored response (nothing runs); with a different request it is refused.
 */
async function managed(ctx: WriteCtx, op: string, request: unknown, run: (c: pg.PoolClient) => Promise<Result>): Promise<Result> {
  if (ctx.actor.agent && !ctx.key) throw new CredentialError('Idempotency-Key header is required.');
  // A plain token (it is stored and shown in the audit trail): 8-200 of [A-Za-z0-9._:-], and not secret-shaped.
  if (ctx.key !== undefined && !/^[A-Za-z0-9._:-]{8,200}$/.test(ctx.key)) throw new CredentialError('Idempotency-Key must be 8-200 characters of A-Z a-z 0-9 . _ : -');
  const hash = createHash('sha256').update(`${op}\n${stableJson(request)}`).digest('hex');
  return withTx(async (c) => {
    if (ctx.key) await assertNoSecrets(c, { 'Idempotency-Key': ctx.key });
    if (ctx.key) {
      // Same-key requests run one at a time, so a concurrent retry waits and then replays.
      await c.query(`select pg_advisory_xact_lock(hashtext('credreq:' || $1 || ':' || $2))`, [ctx.actor.label, ctx.key]);
      const { rows: [prev] } = await c.query(`select request_hash, status, response from ops.credential_requests where actor = $1 and key = $2`, [ctx.actor.label, ctx.key]);
      if (prev) {
        if (prev.request_hash !== hash) throw conflict('This Idempotency-Key was already used for a different request.');
        return { status: prev.status, body: { ...prev.response, replayed: true } };
      }
    }
    const out = await run(c);
    if (ctx.key) {
      await c.query(`insert into ops.credential_requests (actor, key, request_hash, status, response) values ($1, $2, $3, $4, $5)`,
        [ctx.actor.label, ctx.key, hash, out.status, JSON.stringify(out.body)]);
    }
    return out;
  });
}

const SNAPSHOT = `jsonb_build_object('display_name', display_name, 'provider', provider, 'kind', kind, 'managed_by', managed_by,
  'secret_ref', secret_ref, 'date_kind', date_kind, 'renew_url', renew_url, 'notes', notes, 'expires_at', expires_at,
  'removed_at', removed_at, 'version', version, 'field_provenance', field_provenance)`;
const snapshot = async (c: pg.PoolClient, id: string) =>
  (await c.query(`select ${SNAPSHOT} as s from ops.connections where id = $1`, [id])).rows[0]?.s ?? null;

async function audit(c: pg.PoolClient, ctx: WriteCtx, ev: Evidence, id: string, op: string, before: unknown, after: unknown) {
  await c.query(
    `insert into ops.credential_events (connection_id, actor, op, evidence_level, evidence, idempotency_key, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ctx.actor.label, op, ev.level, ev.note || null, ctx.key ?? null, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
}

/** Every mutation of a credential (its row, consumers or checks) moves its version on. */
async function touch(c: pg.PoolClient, id: string): Promise<number> {
  const { rows: [r] } = await c.query(`update ops.connections set version = version + 1, updated_at = now() where id = $1 returning version`, [id]);
  return Number(r.version);
}

type Locked = { managed_by: string; removed_at: Date | null; version: string; expires_at: Date | null; field_provenance: Record<string, { level: Level }>; [col: string]: unknown };

/** Lock a tracked credential and check the caller saw its current version. */
async function lockTracked(c: pg.PoolClient, id: string, ifVersion: number | null, agentWrite = false): Promise<Locked> {
  const { rows: [r] } = await c.query(
    `select managed_by, removed_at, version, expires_at, field_provenance, provider, display_name, kind, date_kind, secret_ref, renew_url, notes
       from ops.connections where id = $1 and kind is not null for update`, [id]);
  if (!r || r.removed_at) throw new NotFound('no such credential');
  if (agentWrite && r.managed_by !== 'manual') throw conflict('managed by its integration; the agent does not annotate it');
  if (ifVersion !== null && Number(r.version) !== ifVersion) {
    throw conflict('This credential changed since you read it. Read it again and re-apply.', { currentVersion: Number(r.version) });
  }
  return r;
}

export class NotFound extends Error {}

/** The evidence behind a field's current value. A value with no recorded provenance predates managed writes: owner-entered. */
function fieldLevel(r: Locked, field: string, current: unknown): Level | null {
  const p = r.field_provenance?.[field];
  if (p && (LEVELS as readonly string[]).includes(p.level)) return p.level;
  return current === null || current === undefined ? null : 'owner_confirmed';
}

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date || b instanceof Date ? (a == null ? null : new Date(a as Date).getTime()) === (b == null ? null : new Date(b as Date).getTime()) : (a ?? null) === (b ?? null);

/**
 * For the agent: one tracked credential per (provider, secret location). Serialized per location, so
 * concurrent creates (or a create racing a PATCH of secretRef) can't both pass the check.
 */
async function assertLocationFree(c: pg.PoolClient, provider: string, secretRef: string, self: string | null) {
  await c.query(`select pg_advisory_xact_lock(hashtext('credloc:' || $1 || ':' || lower($2)))`, [provider, secretRef]);
  const { rows: [dup] } = await c.query(
    `select id from ops.connections where provider = $1 and lower(secret_ref) = lower($2) and kind is not null and removed_at is null
        and id is distinct from $3 limit 1`, [provider, secretRef, self]);
  if (dup) throw conflict('A tracked credential already lives there. Update it instead.', { existingId: dup.id });
}

const UPDATE_FIELDS = ['name', 'kind', 'date', 'dateKind', 'secretRef', 'renewUrl', 'notes'] as const;
const COLUMN: Record<(typeof UPDATE_FIELDS)[number], string> = {
  name: 'display_name', kind: 'kind', date: 'expires_at', dateKind: 'date_kind', secretRef: 'secret_ref', renewUrl: 'renew_url', notes: 'notes',
};

export async function createCredential(input: CredentialInput & { evidence?: unknown }, ctx: WriteCtx): Promise<Result> {
  onlyFields(input as Record<string, unknown>, ['name', 'provider', 'kind', 'date', 'dateKind', 'secretRef', 'renewUrl', 'notes', 'evidence'], ctx.actor);
  const ev = evidenceFor(ctx);
  const name = text(input.name, 'Name', 80, true)!;
  const provider = text(input.provider, 'Provider', 40, true)!.toLowerCase();
  if (!/^[a-z0-9_.-]{1,40}$/.test(provider)) throw new CredentialError('Provider must be a short lowercase name, e.g. anthropic.');
  const kind = oneOf(input.kind ?? 'api_key', KINDS, 'Kind');
  const dateKind = oneOf(input.dateKind ?? 'expires', DATE_KINDS, 'Date kind');
  const secretRef = text(input.secretRef, 'Where it is stored', 200);
  const renewUrl = url(input.renewUrl);
  const notes = text(input.notes, 'Notes', 2000);
  const { evidence: _e, ...request } = input as Record<string, unknown>;
  return managed(ctx, 'create', { ...request, evidence: ev }, async (c) => {
    await assertNoSecrets(c, { name, secretRef, notes, renewUrl, evidence: ev.note });
    const date = await parseDate(c, input.date);
    // Identity is never the name. For the agent, the same secret location at the same provider is the same
    // credential: it gets a 409 naming the existing one (update that), never a silent merge or a duplicate.
    if (ctx.actor.agent && secretRef) await assertLocationFree(c, provider, secretRef, null);
    // Ids are never reused, not even a removed credential's: its consumers and checks stay with it.
    const base = `cred:${slug(name)}`;
    // Serialize creates that share a base id: without this, concurrent same-name creates collide (review D5).
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [base]);
    const { rows: taken } = await c.query(`select id from ops.connections where id = $1 or id like $1 || '-%'`, [base]);
    const used = new Set(taken.map((r) => r.id));
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    const stamp = { level: ev.level, by: ctx.actor.label, at: new Date().toISOString() };
    const given: Record<string, unknown> = { name, provider, kind, dateKind, secretRef, renewUrl, notes, date };
    // Stamp what the caller decided, null included: an explicit "no date" or "no notes" is a decision too.
    // The owner decides every field (the app's defaults included); the agent only the fields it sent.
    const sent = (k: string) => k === 'name' || k === 'provider' || Object.prototype.hasOwnProperty.call(input, k);
    const prov = Object.fromEntries(Object.keys(given).filter((k) => !ctx.actor.agent || sent(k)).map((k) => [k, stamp]));
    await c.query(
      `insert into ops.connections (id, provider, status, display_name, kind, managed_by, secret_ref, date_kind, renew_url, notes, last_checked_at, field_provenance)
       values ($1, $2, 'active', $3, $4, 'manual', $5, $6, $7, $8, null, $9)`,
      [id, provider, name, kind, secretRef, dateKind, renewUrl, notes, JSON.stringify(prov)]);
    await setDate(c, id, date); // registration counts as an edit: inside a window, it warns once, now
    await audit(c, ctx, ev, id, 'create', null, await snapshot(c, id));
    return { status: 201, body: { id, version: 1 } };
  });
}

export async function updateCredential(id: string, patch: CredentialInput & { ifVersion?: unknown; evidence?: unknown }, ctx: WriteCtx): Promise<Result> {
  onlyFields(patch as Record<string, unknown>, [...UPDATE_FIELDS, 'ifVersion', 'evidence'], ctx.actor);
  const ev = evidenceFor(ctx);
  const ifVersion = versionFor(ctx, ctx.actor.agent);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);
  const { ifVersion: _v, evidence: _e, ...request } = patch as Record<string, unknown>;
  return managed(ctx, `update:${id}`, { ...request, ifVersion, evidence: ev }, async (c) => {
    const r = await lockTracked(c, id, ifVersion);
    if (r.managed_by !== 'manual') throw conflict('managed by its integration; change it there');
    const next: Record<string, unknown> = {};
    if (has('name')) next.name = text(patch.name, 'Name', 80, true);
    if (has('kind')) next.kind = oneOf(patch.kind, KINDS, 'Kind');
    if (has('dateKind')) next.dateKind = oneOf(patch.dateKind, DATE_KINDS, 'Date kind');
    if (has('secretRef')) next.secretRef = text(patch.secretRef, 'Where it is stored', 200);
    if (has('renewUrl')) next.renewUrl = url(patch.renewUrl);
    if (has('notes')) next.notes = text(patch.notes, 'Notes', 2000);
    await assertNoSecrets(c, { name: next.name, secretRef: next.secretRef, renewUrl: next.renewUrl, notes: next.notes, evidence: ev.note });
    if (has('date')) next.date = await parseDate(c, patch.date);

    // Decide field by field: a changed value, or the same value with stronger evidence (an upgrade).
    const changes: Record<string, unknown> = {};
    const stamped: string[] = [];
    for (const [field, value] of Object.entries(next)) {
      const current = r[COLUMN[field as keyof typeof COLUMN]];
      let have = fieldLevel(r, field, current);
      // What the date means (expires / provider target / review by) is as strong as the date it labels.
      if (field === 'dateKind') {
        const d = fieldLevel(r, 'date', r.expires_at);
        if (d && (!have || RANK[d] > RANK[have])) have = d;
      }
      const same = sameValue(current, value);
      // Nothing new: the same value without stronger evidence. Exception: the owner restating a value that has
      // no provenance yet (e.g. "Doesn't expire" on an undated row) records that it is the owner's decision.
      if (same && (have ? RANK[ev.level] <= RANK[have] : ctx.actor.agent)) continue;
      if (ctx.actor.agent) {
        if (have && RANK[have] > RANK[ev.level]) {
          throw conflict(have === 'owner_confirmed'
            ? `"${field}" was set by the owner; only the owner changes it.`
            : `"${field}" is backed by stronger evidence (${have}) than this change (${ev.level}).`, { field, currentLevel: have });
        }
        if (field === 'date' && !same) {
          if (value === null) throw conflict('Removing a deadline needs the owner.', { field });
          if (current !== null && (value as Date).getTime() > new Date(current as Date).getTime() && ev.level !== 'provider_verified') {
            throw conflict('Extending a deadline needs provider_verified evidence.', { field });
          }
        }
      }
      if (field === 'secretRef' && ctx.actor.agent && !same && value) await assertLocationFree(c, String(r.provider), String(value), id);
      if (!same) changes[field] = value;
      stamped.push(field);
    }
    if (!stamped.length) return { status: 200, body: { ...(await readOne(c, id)), changed: false } };

    const before = await snapshot(c, id);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [field, value] of Object.entries(changes)) {
      if (field === 'date') continue; // the date goes through setDate (the only alert-stage writer)
      vals.push(value);
      sets.push(`${COLUMN[field as keyof typeof COLUMN]} = $${vals.length}`);
    }
    const stamp = { level: ev.level, by: ctx.actor.label, at: new Date().toISOString() };
    vals.push(JSON.stringify(Object.fromEntries(stamped.map((f) => [f, stamp]))));
    sets.push(`field_provenance = field_provenance || $${vals.length}::jsonb`);
    await c.query(`update ops.connections set ${sets.join(', ')}, updated_at = now() where id = $1`, vals);
    if ('date' in changes) await setDate(c, id, changes.date as Date | null);
    await touch(c, id);
    await audit(c, ctx, ev, id, 'update', before, await snapshot(c, id));
    return { status: 200, body: { ...(await readOne(c, id)), changed: true } };
  });
}

/** "Renewed" from Needs You (owner only): a new date, or none ("doesn't expire"). Runs the edit path. */
export async function renewCredential(id: string, choice: string, by: string): Promise<{ ok: boolean; message: string }> {
  const ctx: WriteCtx = { actor: { label: by, agent: false } };
  try {
    return (await managed(ctx, `renew:${id}`, { choice }, async (c) => {
      const r = await lockTracked(c, id, null);
      if (r.managed_by !== 'manual') return { status: 409, body: { ok: false, message: 'This credential can only be changed where it is managed.' } };
      const date = choice === 'none' ? null : await parseDate(c, choice);
      if (date && date.getTime() <= Date.now()) return { status: 400, body: { ok: false, message: 'Pick a date in the future.' } };
      const before = await snapshot(c, id);
      await c.query(`update ops.connections set field_provenance = field_provenance || $2::jsonb where id = $1`,
        [id, JSON.stringify({ date: { level: 'owner_confirmed', by, at: new Date().toISOString() } })]);
      await setDate(c, id, date);
      await touch(c, id);
      await audit(c, ctx, evidenceFor(ctx), id, 'renew', before, await snapshot(c, id));
      return { status: 200, body: { ok: true, message: date ? 'Updated. Warnings restart from the new date.' : 'Updated: no expiry tracked.' } };
    })).body as { ok: boolean; message: string };
  } catch (e) {
    if (e instanceof NotFound) return { ok: false, message: 'This credential can only be changed where it is managed.' };
    throw e;
  }
}

/** Retire ("not needed"), owner only: soft removal, the same mechanism feed sources use. Its item leaves the queue. */
export async function retireCredential(id: string, actor: Actor): Promise<boolean> {
  if (actor.agent) throw conflict('Retiring a credential needs the owner.');
  const ctx: WriteCtx = { actor };
  return withTx(async (c) => {
    const { rows: [r] } = await c.query(
      `select 1 from ops.connections where id = $1 and managed_by = 'manual' and kind is not null and removed_at is null for update`, [id]);
    if (!r) return false;
    const before = await snapshot(c, id);
    await c.query(`update ops.connections set removed_at = now() where id = $1`, [id]);
    await touch(c, id);
    await audit(c, ctx, evidenceFor(ctx), id, 'retire', before, await snapshot(c, id));
    return true;
  });
}

const CONSUMER_SNAP = `jsonb_build_object('id', id::text, 'consumer', consumer, 'confidence', confidence, 'evidence', evidence, 'agent_id', agent_id,
  'noted_by', noted_by, 'evidence_level', evidence_level)`;

/**
 * Record a consumer. Identity is (credential, consumer name, case- and space-insensitive): observing it again
 * updates that row. The agent may add candidates (any evidence) and confirm one only with provider_verified
 * evidence; it never downgrades a confirmed consumer and never removes one.
 */
export async function addConsumer(id: string, b: { consumer?: unknown; confidence?: unknown; evidence?: unknown; agentId?: unknown; ifVersion?: unknown }, ctx: WriteCtx): Promise<Result> {
  const agent = ctx.actor.agent;
  onlyFields(b as Record<string, unknown>, ['consumer', 'confidence', 'evidence', 'agentId', 'ifVersion'], ctx.actor);
  // The owner's form sends evidence as text; the agent sends {level, note} and the note is the consumer's evidence.
  const ev = evidenceFor(ctx);
  const consumer = text(b.consumer, 'Consumer', 200, true)!;
  const evidence = agent ? ev.note : text(b.evidence, 'Evidence', 500, true)!;
  const confidence = oneOf(b.confidence ?? 'candidate', ['confirmed', 'candidate'] as const, 'Confidence');
  const agentId = text(b.agentId, 'Agent', 80);
  const ifVersion = versionFor(ctx, agent);
  if (agent && confidence === 'confirmed' && ev.level !== 'provider_verified') throw new CredentialError('Confirming a consumer needs provider_verified evidence.');
  return managed(ctx, `consumer:${id}`, { consumer, confidence, evidence, agentId, ifVersion, level: ev.level }, async (c) => {
    await lockTracked(c, id, ifVersion, agent);
    await assertNoSecrets(c, { consumer, evidence });
    if (agentId && !(await c.query(`select 1 from ops.agents where id = $1`, [agentId])).rows.length) throw new CredentialError('No such agent.');
    const { rows: [old] } = await c.query(
      `select id, confidence, evidence, evidence_level, ${CONSUMER_SNAP} as s from ops.credential_consumers
        where connection_id = $1 and lower(btrim(consumer)) = lower(btrim($2)) for update`, [id, consumer]);
    if (old) {
      // The owner's word on a consumer stands: the agent never changes a row the owner noted (or a legacy one).
      if (agent && (old.evidence_level ?? 'owner_confirmed') === 'owner_confirmed') {
        if (old.confidence === confidence) return { status: 200, body: { id: String(old.id), changed: false } };
        throw conflict('The owner recorded this consumer; only the owner changes it.', { consumerId: String(old.id) });
      }
      if (agent && old.confidence === 'confirmed' && confidence === 'candidate') throw conflict('This consumer is confirmed; only the owner downgrades it.', { consumerId: String(old.id) });
      // Same confidence: nothing new for the agent; for the owner, new evidence text is an edit.
      if (old.confidence === confidence && (agent || old.evidence === evidence)) return { status: 200, body: { id: String(old.id), changed: false } };
      const { rows: [n] } = await c.query(
        `update ops.credential_consumers set confidence = $2, evidence = $3, evidence_level = $4, noted_at = now(), noted_by = $5 where id = $1 returning ${CONSUMER_SNAP} as s`,
        [old.id, confidence, evidence, ev.level, ctx.actor.label]);
      const version = await touch(c, id);
      await audit(c, ctx, ev, id, 'consumer_update', old.s, n.s);
      return { status: 200, body: { id: String(old.id), changed: true, version } };
    }
    const { rows: [r] } = await c.query(
      `insert into ops.credential_consumers (connection_id, consumer, confidence, evidence, agent_id, noted_by, evidence_level)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, ${CONSUMER_SNAP} as s`,
      [id, consumer, confidence, evidence, agentId, ctx.actor.label, ev.level]);
    const version = await touch(c, id);
    await audit(c, ctx, ev, id, 'consumer_add', null, r.s);
    return { status: 201, body: { id: String(r.id), changed: true, version } };
  });
}

export async function removeConsumer(id: string, consumerId: string, actor: Actor): Promise<boolean> {
  if (actor.agent) throw conflict('Removing a consumer needs the owner.');
  if (!/^\d{1,18}$/.test(consumerId)) return false;
  const ctx: WriteCtx = { actor };
  return withTx(async (c) => {
    // Credential row first, then the consumer: the same lock order as addConsumer (review: deadlock).
    const { rows: [cred] } = await c.query(`select 1 from ops.connections where id = $1 and kind is not null for update`, [id]);
    if (!cred) return false;
    const { rows: [r] } = await c.query(`delete from ops.credential_consumers where id = $2 and connection_id = $1 returning ${CONSUMER_SNAP} as s`, [id, consumerId]);
    if (!r) return false;
    await touch(c, id);
    await audit(c, ctx, evidenceFor(ctx), id, 'consumer_remove', r.s, null);
    return true;
  });
}

/**
 * Record a coverage check. Checks are observations: each new Idempotency-Key is a new row (a fresh look),
 * a retry under the same key returns the first row. No ifVersion: a check overwrites nothing.
 */
export async function addCheck(id: string, b: { scope?: unknown; result?: unknown; evidence?: unknown }, ctx: WriteCtx): Promise<Result> {
  onlyFields(b as Record<string, unknown>, ['scope', 'result', 'evidence'], ctx.actor);
  const ev = evidenceFor(ctx);
  const scope = text(b.scope, 'What was checked', 300, true)!;
  const result = text(b.result, 'Result', 500, true)!;
  return managed(ctx, `check:${id}`, { scope, result, level: ev.level, note: ev.note }, async (c) => {
    const locked = await lockTracked(c, id, null, ctx.actor.agent);
    await assertNoSecrets(c, { scope, result, evidence: ev.note });
    const { rows: [r] } = await c.query(
      `insert into ops.credential_checks (connection_id, scope, result, noted_by) values ($1, $2, $3, $4) returning id`, [id, scope, result, ctx.actor.label]);
    // A check overwrites nothing, so it doesn't move the version: a sweep can record checks, then PATCH.
    await audit(c, ctx, ev, id, 'check_add', null, { id: String(r.id), scope, result });
    return { status: 201, body: { id: String(r.id), version: Number(locked.version) } };
  });
}

/** The audit trail of one credential, newest first. */
export async function credentialEvents(id: string) {
  const { rows } = await pool.query(
    `select id::text, actor, op, evidence_level, evidence, idempotency_key, before, after, at from ops.credential_events where connection_id = $1 order by id desc limit 200`, [id]);
  return rows;
}

async function readOne(c: pg.PoolClient, id: string) {
  const { rows } = await c.query(`select ${DETAIL_COLS} from ops.connections c where c.id = $1 and c.kind is not null`, [id]);
  return rows[0] ?? null;
}

const STAGE_SQL = `ops.credential_stage(c.expires_at, now())`;
// The calendar day to SHOW. A bare date is stored as the start of the next day (it means "through the end of
// that day"), so display the instant just before the stored one, in the owner's timezone (review D3).
export const DISPLAY_DAY = `to_char((c.expires_at - interval '1 second') at time zone '${(process.env.OWNER_TIMEZONE ?? 'America/New_York').replace(/'/g, "''")}', 'YYYY-MM-DD')`;
const DETAIL_COLS = `c.id, c.version::int as version, c.field_provenance as provenance, c.display_name, c.provider, c.kind, c.managed_by, c.status, c.secret_ref, c.date_kind, c.expires_at,
  c.renew_url, c.notes, c.account_label, ${STAGE_SQL} as stage,
  case when c.expires_at is null then null else floor(extract(epoch from c.expires_at - now()) / 86400)::int end as days_left,
  ${DISPLAY_DAY} as display_date,
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
