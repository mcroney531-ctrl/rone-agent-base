-- Push delivery for Needs You. The Attention Queue stays canonical; this is only delivery state.

-- Server-generated secrets (e.g. the VAPID key pair), sealed with CONNECTION_KEY like connection secrets.
create table if not exists ops.app_secrets (
  name          text primary key,
  public_value  text,                -- non-secret half, if any (VAPID public key)
  key_version   integer not null default 1,
  iv            bytea not null,
  tag           bytea not null,
  ciphertext    bytea not null,
  created_at    timestamptz not null default now()
);

-- One row per browser/device push subscription (Pixel, desktop Chrome, ...). A push endpoint is a
-- bearer capability, so the subscription is stored sealed; endpoint_hash is the lookup key.
create table if not exists ops.push_devices (
  id             uuid primary key default gen_random_uuid(),
  endpoint_hash  text not null unique,
  label          text,
  user_agent     text,
  key_version    integer not null default 1,
  iv             bytea not null,
  tag            bytea not null,
  ciphertext     bytea not null,
  created_at     timestamptz not null default now(),
  last_sent_at   timestamptz,
  last_error     text,
  disabled_at    timestamptz            -- the push service said the subscription is gone (404/410)
);

-- Which attention items were already pushed (kind, ref, and the `since` they were pushed at).
-- Claiming a row is how one worker among several replicas wins the right to send; a re-raised
-- item (newer `since`) is pushed again.
create table if not exists ops.attention_notifications (
  kind         text not null,
  ref          text not null,
  since        timestamptz not null,
  notified_at  timestamptz not null default now(),
  primary key (kind, ref)
);

create table if not exists ops.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
insert into ops.settings (key, value) values
  ('notifications', '{"quietStart": "22:00", "quietEnd": "07:00", "timezone": "America/New_York"}')
on conflict (key) do nothing;
