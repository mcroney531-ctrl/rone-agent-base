-- Research Watch: an item first seen AFTER a source was added, but published well before it (a feed rotating
-- an old post back into its window), is baseline, not new. src/feedWatch.ts applies this rule at checkpoint
-- time; this fixes rows that were filed as 'new' before the rule existed and are still waiting to be judged.
-- Idempotent (re-runs on every boot touch nothing new). Grace = 7 days, the same as OLD_ITEM_GRACE_DAYS.
update ops.feed_items i set change_kind = 'baseline', processing_state = 'skipped'
  from (select connection_id, min(first_seen_at) as since from ops.feed_items group by connection_id) s
 where s.connection_id = i.connection_id
   and i.change_kind = 'new' and i.processing_state = 'pending'
   and i.published_at is not null and i.published_at < s.since - interval '7 days';
