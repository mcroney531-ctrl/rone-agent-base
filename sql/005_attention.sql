-- "Got it" for informational attention items (a failed run you've seen, a stuck executor you've checked).
-- An ack hides an item until it is raised again (its `since` moves past the ack). Items that need a real
-- decision (approvals, broken connections) can't be acked away; they leave the queue when resolved.
create table if not exists ops.attention_acks (
  kind      text not null,
  ref       text not null,
  acked_at  timestamptz not null default now(),
  acked_by  text not null,
  primary key (kind, ref)
);
