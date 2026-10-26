-- CONNECTIONS lifecycle: OAuth as infrastructure, not per-workflow auth.
-- A connection row is the integration's health record; its secret lives encrypted in a separate table.

alter table ops.connections
  add column if not exists account_label text,               -- e.g. the Google account email, once known
  add column if not exists scopes text[] not null default '{}',
  add column if not exists metadata jsonb not null default '{}'; -- provider facts, e.g. {"agentOpsCalendarId": "..."}

-- 'pending' = created, never authorized; 'reauth_required' = provider rejected our refresh token.
alter table ops.connections drop constraint if exists connections_status_check;
alter table ops.connections add constraint connections_status_check
  check (status in ('pending', 'active', 'reauth_required', 'expired', 'revoked', 'error'));

-- Refresh tokens encrypted with AES-256-GCM under CONNECTION_KEY (env), never stored in plaintext.
create table if not exists ops.connection_secrets (
  connection_id text primary key references ops.connections(id) on delete cascade,
  key_version   integer not null default 1,
  iv            bytea not null,
  tag           bytea not null,
  ciphertext    bytea not null,
  updated_at    timestamptz not null default now()
);

-- OAuth `state`: random, single-use, short-lived. The callback is public and trusts nothing else.
create table if not exists ops.oauth_states (
  state         text primary key,
  connection_id text not null references ops.connections(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz
);
create index if not exists oauth_states_expires_idx on ops.oauth_states (expires_at);
