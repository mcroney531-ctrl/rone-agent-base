-- Agent Base / Control Plane schema
-- Isolated in its own schema so it never collides with link-hoarder's app tables.

create schema if not exists agent_base;

create extension if not exists pgcrypto;

-- ============================================================
-- AGENTS: config rows. Simple agents = schedule + prompt + tools + policy.
-- `handler` is the escape hatch for anything needing custom code.
-- ============================================================
create table agent_base.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  enabled boolean not null default true,
  schedule text not null,                       -- cron expression, e.g. '*/5 * * * *'
  model text not null default 'claude-sonnet-5',
  system_prompt text not null,
  allowed_tools text[] not null default '{}',   -- names referencing agent_base.tools.name
  approval_policy jsonb not null default '{"mode": "pending_approval"}'::jsonb,
  -- approval_policy shapes: {"mode":"auto"} | {"mode":"pending_approval"} | {"mode":"risk_threshold","auto_below":"low"}
  handler text,                                  -- optional escape hatch: name of custom handler fn
  workflow_type text,                            -- optional escape hatch: custom workflow identifier
  next_run_at timestamptz,                       -- computed by dispatcher from schedule
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table agent_base.agents is 'Agent config rows. Default path is pure config; handler/workflow_type are escape hatches for custom code.';

-- ============================================================
-- TRIGGERS: source of a run
-- ============================================================
create table agent_base.triggers (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agent_base.agents(id) on delete cascade,
  type text not null check (type in ('cron', 'manual', 'calendar', 'webhook')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index triggers_agent_id_idx on agent_base.triggers(agent_id);
create index triggers_created_at_idx on agent_base.triggers(created_at);

-- ============================================================
-- RUNS: one reasoning/execution cycle
-- ============================================================
create table agent_base.runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agent_base.agents(id) on delete cascade,
  trigger_id uuid references agent_base.triggers(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  tokens_input integer,
  tokens_output integer,
  cost_usd numeric(10, 6),
  retry_count integer not null default 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index runs_agent_id_idx on agent_base.runs(agent_id);
create index runs_status_idx on agent_base.runs(status);
create index runs_created_at_idx on agent_base.runs(created_at);

-- ============================================================
-- ACTIONS: proposed external side effect(s) from a run
-- ============================================================
create table agent_base.actions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_base.runs(id) on delete cascade,
  agent_id uuid not null references agent_base.agents(id) on delete cascade,
  action_type text not null,                     -- e.g. 'email.send', 'calendar.write'
  target text not null,                          -- e.g. recipient address, calendar event id
  payload jsonb not null default '{}'::jsonb,
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'executed', 'failed')),
  idempotency_key text not null unique,           -- agent_id + logical_action + target + source_event/version
  execution_result jsonb,
  approved_by text,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index actions_run_id_idx on agent_base.actions(run_id);
create index actions_agent_id_idx on agent_base.actions(agent_id);
create index actions_status_idx on agent_base.actions(status);

-- ============================================================
-- STATE: small durable per-agent facts/checkpoints between runs
-- ============================================================
create table agent_base.state (
  agent_id uuid not null references agent_base.agents(id) on delete cascade,
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (agent_id, key)
);

-- ============================================================
-- TOOLS: shared capability registry
-- ============================================================
create table agent_base.tools (
  name text primary key,                          -- e.g. 'calendar.read', 'email.send'
  description text not null,
  input_schema jsonb not null,                     -- JSON Schema for strict tool-use validation
  permission_level text not null default 'read' check (permission_level in ('read', 'write', 'send')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

-- ============================================================
-- CONNECTIONS: OAuth/integration credential lifecycle
-- ============================================================
create table agent_base.connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                          -- 'google_calendar', 'gmail', 'slack', 'github', ...
  label text not null,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'error')),
  credentials jsonb,                               -- encrypted at rest via Supabase Vault in production
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, label)
);

-- ============================================================
-- Seed: one hardcoded heartbeat test agent + its tool (build step 2)
-- ============================================================
insert into agent_base.tools (name, description, input_schema, permission_level)
values (
  'state.write',
  'Write or update a small durable per-agent state value. Used for heartbeat/checkpoint style facts.',
  '{"type":"object","properties":{"key":{"type":"string"},"value":{"type":"object"}},"required":["key","value"],"additionalProperties":false}'::jsonb,
  'write'
);

insert into agent_base.agents (name, description, schedule, model, system_prompt, allowed_tools, approval_policy)
values (
  'heartbeat-test',
  'Hardcoded test agent to prove dispatcher + worker + Supabase wiring end to end. No real side effects.',
  '*/5 * * * *',
  'claude-haiku-4-5-20251001',
  'You are a heartbeat test agent. Call the state.write tool once with key "heartbeat" and a value object containing the current ISO timestamp under "ranAt". Then stop.',
  array['state.write'],
  '{"mode": "auto"}'::jsonb
);
