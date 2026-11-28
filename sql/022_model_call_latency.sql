-- Spend log: latency and outcome per provider call (still an operational ledger, observation only).
-- Every attempt that reached the provider gets a row, failed ones included. Failed calls have token counts and
-- cost only when the provider reported usage; otherwise they are NULL (unknown), never a faked zero.
alter table ops.model_calls add column if not exists started_at          timestamptz;
alter table ops.model_calls add column if not exists duration_ms         integer;
alter table ops.model_calls add column if not exists outcome             text not null default 'success'
  check (outcome in ('success', 'provider_error', 'timeout', 'cancelled'));
alter table ops.model_calls add column if not exists attempt_number      integer;   -- DBOS step attempt (1 = first try)
alter table ops.model_calls add column if not exists provider_request_id text;      -- e.g. Anthropic's request-id header

-- Token counts are unknown for a failed call without a usage report.
alter table ops.model_calls alter column input_tokens drop not null;
alter table ops.model_calls alter column output_tokens drop not null;
alter table ops.model_calls alter column cache_read_tokens drop not null;
alter table ops.model_calls alter column cache_write_tokens drop not null;

-- Views: same columns as 021 (unpriced = successful calls with no price), plus failed calls and latency at the end.
create or replace view ops.v_spend_runs as
select run_id, agent_id, min(at) as first_call_at, count(*)::int as calls,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null and outcome = 'success')::int as unpriced_calls,
       count(*) filter (where outcome <> 'success')::int as failed_calls,
       sum(duration_ms)::bigint as model_ms
  from ops.model_calls
 where run_id is not null
 group by run_id, agent_id;

create or replace view ops.v_spend_agent_daily as
select (at at time zone 'UTC')::date as day_utc, agent_id, count(*)::int as calls, count(distinct run_id)::int as runs,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null and outcome = 'success')::int as unpriced_calls,
       count(*) filter (where outcome <> 'success')::int as failed_calls,
       (percentile_cont(0.5) within group (order by duration_ms) filter (where outcome = 'success'))::int as p50_ms,
       (percentile_cont(0.95) within group (order by duration_ms) filter (where outcome = 'success'))::int as p95_ms
  from ops.model_calls
 group by 1, 2;

create or replace view ops.v_spend_daily as
select (at at time zone 'UTC')::date as day_utc, count(*)::int as calls, count(distinct run_id)::int as runs,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
       sum(cache_read_tokens)::bigint as cache_read_tokens, sum(cache_write_tokens)::bigint as cache_write_tokens,
       sum(estimated_cost_usd)::numeric(12,6) as estimated_cost_usd,
       count(*) filter (where estimated_cost_usd is null and outcome = 'success')::int as unpriced_calls,
       count(*) filter (where outcome <> 'success')::int as failed_calls,
       (percentile_cont(0.5) within group (order by duration_ms) filter (where outcome = 'success'))::int as p50_ms,
       (percentile_cont(0.95) within group (order by duration_ms) filter (where outcome = 'success'))::int as p95_ms
  from ops.model_calls
 group by 1;
