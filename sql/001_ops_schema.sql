-- ops.* = our domain + control plane. DBOS owns dbos.* (created by DBOS itself at launch).
-- Nothing in ops.* except the ops.v_runs adapter view may reference dbos.*.

create schema if not exists ops;

-- AGENTS: config rows. `handler` is the escape hatch for custom code.
create table if not exists ops.agents (
  id               text primary key,                 -- slug, also used in schedule + workflow IDs
  enabled          boolean not null default true,
  schedule         text,                             -- 6-field cron (sec min hour dom mon dow); null = trigger-only
  model            text not null default 'claude-sonnet-5',
  instructions     text not null,
  mcp_server_url   text,
  approval_policy  jsonb not null default '{"mode":"pending_approval"}',
  handler          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- TOOLS: shared capability registry.
create table if not exists ops.tools (
  name             text primary key,                 -- e.g. 'email.draft'
  description      text not null,
  permission_level text not null check (permission_level in ('read', 'write', 'send')),
  default_risk     text not null default 'medium' check (default_risk in ('low', 'medium', 'high'))
);

-- CONNECTIONS: integration credential lifecycle. Secrets live outside this table (Vault/env); this tracks state.
create table if not exists ops.connections (
  id               text primary key,                 -- e.g. 'google_calendar:rone'
  provider         text not null,
  status           text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  expires_at       timestamptz,
  last_error       text,
  last_checked_at  timestamptz,
  updated_at       timestamptz not null default now()
);

-- AGENT_CONNECTIONS: required integrations are relational (hard rule 8), not JSON blobs.
create table if not exists ops.agent_connections (
  agent_id         text not null references ops.agents(id) on delete cascade,
  connection_id    text not null references ops.connections(id),
  required         boolean not null default true,
  primary key (agent_id, connection_id)
);

-- STATE: durable business/domain facts per agent.
create table if not exists ops.state (
  agent_id            text not null references ops.agents(id) on delete cascade,
  key                 text not null,
  value               jsonb not null,
  source_workflow_id  text,                          -- which run last wrote it
  updated_at          timestamptz not null default now(),
  primary key (agent_id, key)
);

-- ACTIONS: proposed external side effects. Proposed by a reasoning workflow (which then ENDS),
-- decided by a human/policy later, executed by a short executor workflow whose ID = idempotency_key.
create table if not exists ops.actions (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            text not null references ops.agents(id),
  source_workflow_id  text not null,                 -- reasoning run that proposed it (occurrence identity)
  logical_action      text not null references ops.tools(name),
  target              text not null,
  payload             jsonb not null,
  risk_level          text not null check (risk_level in ('low', 'medium', 'high')),
  status              text not null default 'pending_approval'
                      check (status in ('pending_approval', 'approved', 'rejected', 'executed', 'failed')),
  -- agent_id + logical_action + target + source_event/version. Doubles as executor workflow ID.
  idempotency_key     text not null unique,
  decided_by          text,
  decided_at          timestamptz,
  result              jsonb,
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists actions_status_idx on ops.actions (status);
create index if not exists actions_agent_idx on ops.actions (agent_id, created_at desc);

-- RUNS: our domain-level ledger of each workflow (one row per workflow ID), written by steps.
-- Holds facts DBOS doesn't know (agent, trigger, outcome class). Liveness comes from DBOS via ops.v_runs.
create table if not exists ops.runs (
  workflow_id     text primary key,
  kind            text not null check (kind in ('agent_run', 'executor')),
  agent_id        text not null references ops.agents(id),
  trigger_type    text not null,                     -- schedule | manual | webhook | calendar | approval
  source_event    text,
  action_id       uuid references ops.actions(id),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  outcome         text check (outcome in ('succeeded', 'failed')),
  error_class     text,
  error_message   text,
  actions_proposed integer
);
create index if not exists runs_agent_idx on ops.runs (agent_id, started_at desc);

-- EXECUTORS: liveness heartbeats. DBOS OSS has no executor liveness table (Conductor does);
-- this is the bounded adapter that lets a live container reclaim a dead container's PENDING work.
create table if not exists ops.executors (
  executor_id   text primary key,
  app_version   text not null,
  started_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  stopped_at    timestamptz,                         -- clean shutdown (drained)
  reaped_at     timestamptz,                         -- declared dead; its PENDING work resumed elsewhere
  reaped_by     text,
  reaped_count  integer
);

-- Seed: tools + one test agent (every 30s) wired to the local test MCP server.
insert into ops.tools (name, description, permission_level, default_risk) values
  ('crm.note',      'Attach a note to a contact record',            'write', 'low'),
  ('email.draft',   'Create an email draft (not sent)',             'write', 'medium'),
  ('calendar.hold', 'Place a tentative hold on the calendar',       'write', 'medium')
on conflict (name) do nothing;

insert into ops.connections (id, provider) values ('fake_provider:spike', 'fake_provider')
on conflict (id) do nothing;

insert into ops.agents (id, schedule, instructions, mcp_server_url, approval_policy) values (
  'spike-agent',
  '*/30 * * * * *',
  'You are a test agent for a durability spike. First call lookup_contact for "ada". '
  || 'Then call read_state for key "last_seen_contact". Then propose exactly three actions with propose_action: '
  || 'a crm.note, an email.draft, and a calendar.hold, all targeting the contact you looked up. '
  || 'Then call write_state to record the contact under "last_seen_contact". Finally reply with a one-line summary.',
  'http://127.0.0.1:7801/mcp',
  '{"mode":"pending_approval"}'
) on conflict (id) do nothing;

insert into ops.agent_connections (agent_id, connection_id) values ('spike-agent', 'fake_provider:spike')
on conflict do nothing;
