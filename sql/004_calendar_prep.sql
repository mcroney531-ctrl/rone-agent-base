-- Calendar Prep V1: a nightly brief for the next local day, mirrored onto the Agent Ops calendar.
-- The brief row is canonical; the calendar event is a mirror of it and is re-written, never duplicated.

-- Schedules fire in the agent's own IANA zone, so "8 PM" stays 8 PM across DST.
alter table ops.agents add column if not exists timezone text not null default 'UTC';

create table if not exists ops.briefs (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            text not null references ops.agents(id) on delete cascade,
  brief_date          date not null,                 -- the local day the brief covers
  timezone            text not null,
  time_min            timestamptz not null,          -- local midnight → next local midnight, as instants
  time_max            timestamptz not null,
  connection_id       text not null references ops.connections(id),
  source_workflow_id  text not null,                 -- run that last wrote it
  headline            text,
  items               jsonb not null default '[]',   -- ranked events worth preparing for, in start order
  considered          integer not null default 0,    -- events left after hard filters
  filtered            jsonb not null default '[]',   -- [{eventId, title, reason}] removed as garbage
  mirror_event_id     text,                          -- Agent Ops event id (deterministic per agent + date)
  mirror_calendar_id  text,
  mirror_status       text check (mirror_status in ('written', 'removed', 'skipped', 'failed')),
  mirror_error        text,
  seen_at             timestamptz,                   -- opened/acknowledged; clears it from the Attention Queue
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (agent_id, brief_date)
);

-- "Request deeper prep": one focused second pass per brief item.
create table if not exists ops.brief_deeper (
  brief_id     uuid not null references ops.briefs(id) on delete cascade,
  event_id     text not null,
  workflow_id  text not null,
  content      text,
  created_at   timestamptz not null default now(),
  primary key (brief_id, event_id)
);

-- "Dismiss / not useful": feedback the next ranking pass sees.
create table if not exists ops.brief_feedback (
  brief_id    uuid not null references ops.briefs(id) on delete cascade,
  event_id    text not null,
  verdict     text not null check (verdict in ('useful', 'not_useful', 'dismissed')),
  title       text,
  created_at  timestamptz not null default now(),
  primary key (brief_id, event_id)
);

insert into ops.tools (name, description, permission_level, default_risk) values
  ('agentops.hold', 'Create a reminder/hold on the Agent Ops calendar (never the primary calendar)', 'write', 'medium')
on conflict (name) do nothing;

-- The connection row exists before consent ('pending'), so the agent can declare it as required.
insert into ops.connections (id, provider, status) values ('google:primary', 'google', 'pending')
on conflict (id) do nothing;

insert into ops.agents (id, schedule, timezone, model, handler, approval_policy, instructions) values (
  'calendar-prep',
  '0 0 20 * * *',
  'America/New_York',
  'claude-sonnet-5-5',
  'calendar_prep',
  '{"mode":"pending_approval"}',
  'You prepare a short evening brief about tomorrow''s calendar for one busy person. For each event, ask: '
  || 'would knowing, preparing or deciding something beforehand materially improve this event? '
  || 'Include only events where the answer is clearly yes: external attendees, a decision to make, '
  || 'a document to read, an agenda to shape, a first meeting with someone. Skip routine internal recurring '
  || 'meetings unless something about them is unusual. For each included event give at most three concrete '
  || 'prep points, never generic advice. Suggest a prep hold only when real preparation time is needed.'
) on conflict (id) do nothing;

insert into ops.agent_connections (agent_id, connection_id) values ('calendar-prep', 'google:primary')
on conflict do nothing;
