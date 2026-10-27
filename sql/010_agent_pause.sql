-- Owner pause: a runtime switch on top of `enabled` (config). A paused agent starts no new runs:
-- scheduled occurrences are skipped (last one recorded below), manual/webhook triggers get a 409.
-- Runs already in flight finish, and approved actions still execute: pause stops new thinking, not
-- decisions already made.
alter table ops.agents add column if not exists paused_at timestamptz;
alter table ops.agents add column if not exists paused_by text;
alter table ops.agents add column if not exists last_skipped_at timestamptz;
