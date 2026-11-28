-- Edit before approve (D). The owner can change a proposed action's editable fields while it awaits approval.
--   payload           what will execute: the AI's proposal, or the owner's edit of it
--   proposed_payload  the AI's original, kept on first edit (null = never edited), never changed again
--   version           bumped by every change (owner edit or agent refresh); approve and edit carry the version
--                     the owner saw, so a stale screen can never approve or overwrite a newer payload
-- Once approved, the payload is frozen: the executor loads it in a checkpointed step and runs exactly that.
alter table ops.actions add column if not exists proposed_payload jsonb;
alter table ops.actions add column if not exists version integer not null default 1;
alter table ops.actions add column if not exists edited_by text;
alter table ops.actions add column if not exists edited_at timestamptz;

-- Which payload fields the owner may edit, per action type (generic: holds, messages… can opt in later).
alter table ops.tools add column if not exists editable_fields jsonb not null default '[]';
update ops.tools set editable_fields = '[{"name": "draft", "label": "Reply", "multiline": true, "maxLength": 4000, "required": true}]'
 where name = 'gmail.draft';

-- Audit: every owner edit, with what it replaced.
create table if not exists ops.action_edits (
  id          bigserial primary key,
  action_id   uuid not null references ops.actions(id) on delete cascade,
  version     integer not null,          -- the version this edit produced
  edited_by   text not null,
  edited_at   timestamptz not null default now(),
  before      jsonb not null,            -- the edited fields' previous values
  after       jsonb not null
);
create index if not exists action_edits_action_idx on ops.action_edits (action_id, version);
