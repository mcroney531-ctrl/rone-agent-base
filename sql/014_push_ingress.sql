-- Push ingress (Gmail push → Pub/Sub → POST /ingress/gmail). A push is a wake-up signal, not a processing
-- path: it records the event and starts the existing Inbox Triage run. The 20-minute schedule stays as the
-- recovery path.

-- 1. Claims, so overlapping runs (push + schedule + manual) never triage the same message twice.
--    pending → claimed (by one workflow) → triaged. A claim is reclaimable only when its owner workflow is
--    terminal (not PENDING/ENQUEUED in DBOS): a live or recovering run keeps its claim.
alter table ops.inbox_items drop constraint if exists inbox_items_status_check;
alter table ops.inbox_items add constraint inbox_items_status_check check (status in ('pending', 'claimed', 'triaged'));
alter table ops.inbox_items add column if not exists claimed_by text;
alter table ops.inbox_items add column if not exists claimed_at timestamptz;
-- The actions a triage decided on, written in the same transaction as the triage itself; proposed_at is set
-- once they are inserted into ops.actions. A run that died between the two is repaired from this column
-- (no second model call, no reclassification); the insert is keyed per message, so repair never duplicates.
alter table ops.inbox_items add column if not exists proposals jsonb;
alter table ops.inbox_items add column if not exists proposed_at timestamptz;
-- Which kind of run triaged it (push | schedule | manual | repair), for push latency and "missed by push".
alter table ops.inbox_items add column if not exists triaged_by text;

-- 2. Inbound events. One canonical row per provider event (Pub/Sub messageId); a redelivery bumps
--    delivery_count, never adds a row. state: received → started | skipped | ignored. A redelivery of an
--    event still 'received' (recorded, but the wake failed) retries the wake before acknowledging.
create table if not exists ops.ingress_events (
  id               bigserial primary key,
  source           text not null,                 -- 'gmail'
  external_id      text not null,                 -- Pub/Sub messageId
  account          text,                          -- emailAddress from the notification
  history_id       text,                          -- Gmail historyId in the notification (observability only)
  state            text not null default 'received' check (state in ('received', 'started', 'skipped', 'ignored')),
  detail           text,
  workflow_ids     text[] not null default '{}',
  delivery_count   integer not null default 1,
  first_received_at timestamptz not null default now(),
  last_received_at  timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists ingress_events_recent_idx on ops.ingress_events (source, first_received_at desc);
