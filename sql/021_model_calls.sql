-- Model usage / spend log, V1: observation only. No caps, no alerts, no budget engine.
-- One row per REAL provider call (written by the usage middleware inside the durable step, so a replayed checkpoint
-- is never logged and never double-counted; a retried attempt that the provider answered IS logged, because it was paid).
-- Totals per run / per agent / per day are derived by the views below, never stored as aggregates.

-- Price list, per million tokens, USD. A price change is a NEW row with a later effective_from (old calls keep the
-- price they were costed at). Rows are only inserted if missing, so a boot never overwrites a price edited in the DB.
create table if not exists ops.model_prices (
  id                  bigserial primary key,
  provider            text not null,
  model               text not null,
  effective_from      timestamptz not null default '2026-01-01',
  input_per_mtok      numeric(10,4) not null,   -- uncached input
  output_per_mtok     numeric(10,4) not null,   -- output (thinking/reasoning tokens are billed as output)
  cache_read_per_mtok numeric(10,4) not null,
  cache_write_per_mtok numeric(10,4) not null,  -- 5-minute cache write (1.25x input)
  unique (provider, model, effective_from)
);
-- Anthropic first-party list prices as of Nov 2026.
insert into ops.model_prices (provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok) values
  ('anthropic', 'claude-sonnet-5-5', 2.00, 10.00, 0.10, 2.50),
  ('anthropic', 'claude-sonnet-5',   2.00, 10.00, 0.20, 2.50),
  ('anthropic', 'claude-opus-5-5',   4.00, 20.00, 0.20, 5.00),
  ('anthropic', 'claude-haiku-5-5',  0.10,  0.50, 0.01, 0.125)
on conflict (provider, model, effective_from) do nothing;

create table if not exists ops.model_calls (
  id                 bigserial primary key,
  at                 timestamptz not null default now(),
  provider           text not null,
  model              text not null,             -- the model that served the call (response model id when given)
  agent_id           text,                      -- from ops.runs for the workflow; null outside an agent run
  run_id             text,                      -- DBOS workflow id
  step_id            integer,                   -- DBOS step (function) id within the run
  input_tokens       integer not null default 0, -- uncached input
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  reasoning_tokens   integer,                   -- part of output_tokens, when reported
  price_id           bigint references ops.model_prices(id),
  estimated_cost_usd numeric(12,6)              -- null when the model has no price row (shown as unpriced, never as $0)
);
create index if not exists model_calls_at_idx on ops.model_calls (at);
create index if not exists model_calls_run_idx on ops.model_calls (run_id);
create index if not exists model_calls_agent_idx on ops.model_calls (agent_id, at);

-- Per run.
create or replace view ops.v_spend_runs as
select run_id, agent_id, min(at) as first_call_at, count(*)::int as calls,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null)::int as unpriced_calls
  from ops.model_calls
 where run_id is not null
 group by run_id, agent_id;

-- Per agent per day (UTC).
create or replace view ops.v_spend_agent_daily as
select (at at time zone 'UTC')::date as day_utc, agent_id, count(*)::int as calls, count(distinct run_id)::int as runs,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null)::int as unpriced_calls
  from ops.model_calls
 group by 1, 2;

-- Per day (UTC), all agents.
create or replace view ops.v_spend_daily as
select (at at time zone 'UTC')::date as day_utc, count(*)::int as calls, count(distinct run_id)::int as runs,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null)::int as unpriced_calls
  from ops.model_calls
 group by 1;
