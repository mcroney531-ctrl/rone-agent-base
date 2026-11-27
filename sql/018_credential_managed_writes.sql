-- Credential Watch: managed inventory writes (docs/credential-watch.md "Managed writes").
-- Who changed what, when, and on what evidence; safe retries; stale-write protection.
-- One transaction (applySql); idempotent on every boot.

-- Row version: bumped by every credential mutation (src/credentials.ts touch()). An agent write must name
-- the version it read (ifVersion), so a sweep can't land on top of a change it never saw.
alter table ops.connections add column if not exists version bigint not null default 1;

-- Per-field provenance for tracked credentials: { "<field>": { "level": ..., "by": ..., "at": ... } }.
-- level: provider_verified | owner_confirmed | inferred. Missing field = no provenance recorded (pre-018 data,
-- which only the owner could have entered, is treated as owner_confirmed; see fieldLevel()).
alter table ops.connections add column if not exists field_provenance jsonb not null default '{}'::jsonb;

-- Audit: one row per mutation, committed in the same transaction as the change it describes.
-- before/after hold only the tracked columns (never a value: those are refused on the way in, and the
-- secret_ref inside them must pass the same frozen check as the column itself).
create table if not exists ops.credential_events (
  id              bigserial primary key,
  connection_id   text not null references ops.connections(id),
  actor           text not null check (length(actor) between 1 and 200),
  op              text not null check (op in ('create', 'update', 'renew', 'retire', 'consumer_add', 'consumer_update',
                                              'consumer_remove', 'check_add')),
  evidence_level  text check (evidence_level in ('provider_verified', 'owner_confirmed', 'inferred')),
  evidence        text check (evidence is null or length(evidence) between 1 and 500),
  idempotency_key text,
  before          jsonb,
  after           jsonb,
  at              timestamptz not null default now(),
  constraint credential_events_secret_ref_v1 check (
    ops.secret_ref_ok_v1(before->>'secret_ref') and ops.secret_ref_ok_v1(after->>'secret_ref'))
);
create index if not exists credential_events_conn_idx on ops.credential_events (connection_id, id);

-- Idempotency: the first response to (actor, key) is kept; a retry with the same body gets it back,
-- a different body under the same key is refused. Written in the mutation's own transaction, so a failed
-- request leaves no key behind and can simply be retried.
create table if not exists ops.credential_requests (
  actor        text not null,
  key          text not null check (length(key) between 8 and 200),
  request_hash text not null,
  status       smallint not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (actor, key)
);

-- Consumer identity: one row per (credential, consumer), compared case- and space-insensitively.
-- A re-observation updates that row; it never adds a second.
create unique index if not exists credential_consumers_identity
  on ops.credential_consumers (connection_id, lower(btrim(consumer)));

-- Consumers carry the evidence level of whoever last set them. Rows from before managed writes were entered
-- by the owner. The agent never changes an owner_confirmed consumer.
alter table ops.credential_consumers add column if not exists evidence_level text
  check (evidence_level in ('provider_verified', 'owner_confirmed', 'inferred'));
update ops.credential_consumers set evidence_level = 'owner_confirmed' where evidence_level is null;

-- Manual credentials from before managed writes: every field, set or empty, was the owner's decision.
-- Stamped once (only rows with no provenance yet), so the agent can't fill an owner's deliberate blank.
update ops.connections c
   set field_provenance = (
     select jsonb_object_agg(f, jsonb_build_object('level', 'owner_confirmed', 'by', 'pre-managed-writes', 'at', now()))
       from unnest(array['name', 'provider', 'kind', 'date', 'dateKind', 'secretRef', 'renewUrl', 'notes']) as f)
 where c.managed_by = 'manual' and c.kind is not null and c.field_provenance = '{}'::jsonb;
