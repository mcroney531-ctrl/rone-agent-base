-- Prep holds V2: deterministic placement + execution-time re-check.
-- 'superseded' = replaced without the owner rejecting it (re-proposed elsewhere, or no longer proposed).
alter table ops.actions drop constraint if exists actions_status_check;
alter table ops.actions add constraint actions_status_check
  check (status in ('pending_approval', 'approved', 'rejected', 'executed', 'failed', 'superseded'));

-- Per-agent knobs, e.g. {"prepHolds": {"dayStart": "08:00", "dayEnd": "19:00", "bufferMinutes": 10}}.
alter table ops.agents add column if not exists settings jsonb not null default '{}';
