-- Per-device delivery: "notified once" means once per subscribed device, not once globally. A transient
-- failure on one device is retried for that device only; a 404/410 retires just that device.
create table if not exists ops.notification_deliveries (
  kind             text not null,
  ref              text not null,
  device_id        uuid not null references ops.push_devices(id) on delete cascade,
  since            timestamptz not null,               -- the attention item's `since` this delivery is for
  status           text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'gone', 'abandoned')),
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  sent_at          timestamptz,
  primary key (kind, ref, device_id)
);
create index if not exists notification_deliveries_due_idx on ops.notification_deliveries (next_attempt_at) where status in ('pending', 'failed');

-- Superseded by per-device deliveries.
drop table if exists ops.attention_notifications;
