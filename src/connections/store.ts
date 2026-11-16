// Provider-agnostic CONNECTIONS lifecycle. Providers (google.ts, later gmail/slack/...) call these;
// health and the Attention Queue read ops.connections directly, so every provider gets them for free.
import { randomBytes } from 'node:crypto';
import { pool } from '../db.js';
import { open, seal } from './crypto.js';

export type ConnectionStatus = 'pending' | 'active' | 'reauth_required' | 'expired' | 'revoked' | 'error';
export type Connection = {
  id: string;
  provider: string;
  managed_by?: string;
  status: ConnectionStatus;
  account_label: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  last_error: string | null;
  last_checked_at: string | null;
  updated_at: string;
};

const COLS = 'id, provider, status, account_label, scopes, metadata, last_error, last_checked_at, updated_at, managed_by';
// Ownership boundary: ops.connections is shared with Credential Watch (managed_by = 'manual'). Integration code
// (Google OAuth, feeds) may only list, write status or metadata on rows it owns (managed_by = 'integration');
// a manually tracked credential that happens to say provider 'google' is never treated as an integration row.
const OWNED = `managed_by = 'integration'`;

export async function getConnection(id: string): Promise<Connection | undefined> {
  return (await pool.query(`select ${COLS} from ops.connections where id = $1`, [id])).rows[0];
}

export async function listConnections(): Promise<Connection[]> {
  return (await pool.query(`select ${COLS} from ops.connections order by id`)).rows;
}

/** Integration-owned connections only: what integration code may iterate over. */
export async function listIntegrationConnections(provider: string): Promise<Connection[]> {
  return (await pool.query(`select ${COLS} from ops.connections where provider = $1 and ${OWNED} order by id`, [provider])).rows;
}

export async function ensurePending(id: string, provider: string): Promise<Connection> {
  await pool.query(
    `insert into ops.connections (id, provider, status) values ($1, $2, 'pending') on conflict (id) do nothing`,
    [id, provider],
  );
  return (await getConnection(id))!;
}

export async function saveSecret(id: string, secret: string): Promise<void> {
  const s = seal(secret, id);
  await pool.query(
    `insert into ops.connection_secrets (connection_id, key_version, iv, tag, ciphertext) values ($1, $2, $3, $4, $5)
     on conflict (connection_id) do update set key_version = excluded.key_version, iv = excluded.iv, tag = excluded.tag,
       ciphertext = excluded.ciphertext, updated_at = now()`,
    [id, s.keyVersion, s.iv, s.tag, s.ciphertext],
  );
}

export async function loadSecret(id: string): Promise<string | undefined> {
  const row = (await pool.query(`select key_version, iv, tag, ciphertext from ops.connection_secrets where connection_id = $1`, [id])).rows[0];
  return row ? open({ iv: row.iv, tag: row.tag, ciphertext: row.ciphertext, keyVersion: row.key_version }, id) : undefined;
}

export async function markActive(id: string, f: { accountLabel?: string; scopes?: string[]; metadata?: Record<string, unknown> }): Promise<void> {
  await pool.query(
    `update ops.connections set status = 'active', last_error = null, last_checked_at = now(), updated_at = now(),
       account_label = coalesce($2, account_label), scopes = coalesce($3, scopes), metadata = metadata || coalesce($4, '{}'::jsonb)
     where id = $1 and ${OWNED}`,
    [id, f.accountLabel ?? null, f.scopes ?? null, f.metadata ?? null],
  );
}

export async function mergeMetadata(id: string, metadata: Record<string, unknown>): Promise<void> {
  await pool.query(`update ops.connections set metadata = metadata || $2::jsonb, updated_at = now() where id = $1 and ${OWNED}`, [id, metadata]);
}

// The provider rejected our credential: only a human re-consenting fixes it. Shows up in the Attention Queue.
export async function markReauthRequired(id: string, error: string): Promise<void> {
  await pool.query(
    `update ops.connections set status = 'reauth_required', last_error = $2, last_checked_at = now(), updated_at = now() where id = $1 and ${OWNED}`,
    [id, error],
  );
}

// A check that reached the provider. Transient failures record the error but keep the status.
export async function markChecked(id: string, error?: string): Promise<void> {
  await pool.query(
    `update ops.connections set last_checked_at = now(), last_error = $2, updated_at = now() where id = $1 and ${OWNED}`,
    [id, error ?? null],
  );
}

export async function newOAuthState(connectionId: string, ttlMS = 10 * 60_000): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  await pool.query(
    `insert into ops.oauth_states (state, connection_id, expires_at) values ($1, $2, now() + ($3::int * interval '1 millisecond'))`,
    [state, connectionId, ttlMS],
  );
  return state;
}

// Single use, atomically: a replayed or expired state yields nothing.
export async function consumeOAuthState(state: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `update ops.oauth_states set used_at = now() where state = $1 and used_at is null and expires_at > now() returning connection_id`,
    [state],
  );
  return rows[0]?.connection_id;
}
