-- ops.v_runs: the ONLY object in ops.* that reads DBOS internals (hard rule 7).
--
-- Adapter, not projection: dbos.workflow_status is the cross-SDK system table (Python/Go/Java/TS
-- share it) and its 57-migration history is add-column-only. We still keep DBOS migrations
-- un-blockable: the read goes through a string-bodied LANGUAGE sql function, which records no
-- pg_depend entry on dbos.* (so a future DBOS ALTER/DROP can never fail because of us) yet is still
-- inlined by the planner. If DBOS ever removes a column we use, health queries error loudly while
-- the worker keeps booting — the right failure direction.

create or replace function ops.dbos_workflows()
returns table (
  workflow_id text, workflow_name text, dbos_status text, executor_id text, app_version text,
  queue_name text, recovery_attempts bigint, created_at timestamptz, updated_at timestamptz,
  started_at timestamptz, completed_at timestamptz, parent_workflow_id text, schedule_name text
)
language sql stable
as $fn$
  select workflow_uuid, name, status, executor_id, application_version,
         queue_name, recovery_attempts,
         to_timestamp(created_at / 1000.0), to_timestamp(updated_at / 1000.0),
         to_timestamp(started_at_epoch_ms / 1000.0), to_timestamp(completed_at / 1000.0),
         parent_workflow_id, schedule_name
    from dbos.workflow_status
   where name in ('agentRun', 'scheduledAgentRun', 'executeAction')
$fn$;

create or replace view ops.v_runs as
select
  w.workflow_id,
  coalesce(r.kind, case when w.workflow_name = 'executeAction' then 'executor' else 'agent_run' end) as kind,
  r.agent_id,
  r.trigger_type,
  r.source_event,
  r.action_id,
  case w.dbos_status
    when 'ENQUEUED' then 'queued'
    when 'DELAYED' then 'queued'
    when 'PENDING' then 'running'
    when 'SUCCESS' then 'succeeded'
    when 'ERROR' then 'failed'
    when 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' then 'failed'
    when 'CANCELLED' then 'cancelled'
    else 'unknown'                                   -- a new DBOS status shows up instead of vanishing
  end as run_state,
  w.dbos_status,
  -- Our code classifies failures it can catch. A DBOS-level failure (crash loop, replay/step-sequence
  -- mismatch after an unpatched deploy) never reaches our catch block, so label it from the status.
  coalesce(r.error_class, case w.dbos_status
    when 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' then 'crash_loop'
    when 'ERROR' then 'unclassified_workflow_error'
  end) as error_class,
  r.error_message,
  r.actions_proposed,
  w.executor_id,
  (e.executor_id is not null and e.reaped_at is null and e.last_seen_at > now() - interval '30 seconds') as executor_alive,
  w.app_version,
  w.queue_name,
  w.recovery_attempts,
  w.created_at,
  w.started_at,
  coalesce(w.completed_at, r.finished_at) as finished_at,
  w.updated_at,
  w.parent_workflow_id,
  w.schedule_name
from ops.dbos_workflows() w
left join ops.runs r on r.workflow_id = w.workflow_id
left join ops.executors e on e.executor_id = w.executor_id;

-- Everything below reads ops.v_runs and ops.* only.

create or replace view ops.agent_health as
with recent as (
  select * from ops.v_runs where kind = 'agent_run' and created_at > now() - interval '24 hours'
),
last_finished as (
  select distinct on (agent_id) agent_id, run_state, error_class, finished_at
    from ops.v_runs where kind = 'agent_run' and run_state in ('succeeded', 'failed') and agent_id is not null
   order by agent_id, finished_at desc nulls last
),
blocked as (
  select ac.agent_id, array_agg(c.id order by c.id) as connections
    from ops.agent_connections ac join ops.connections c on c.id = ac.connection_id
   where ac.required and (c.status <> 'active' or not (ac.scopes <@ c.scopes))
   group by ac.agent_id
)
select
  a.id as agent_id,
  case
    when a.paused_at is not null then 'paused'
    when b.connections is not null then 'blocked'
    when lf.run_state = 'failed' then 'failing'
    when exists (select 1 from recent x where x.agent_id = a.id and x.run_state = 'running'
                  and (not x.executor_alive or x.updated_at < now() - interval '15 minutes')) then 'degraded'
    when exists (select 1 from recent x where x.agent_id = a.id and x.recovery_attempts > 1) then 'degraded'
    when lf.run_state = 'succeeded' then 'healthy'
    else 'idle'
  end as health_state,
  lf.run_state as last_outcome,
  lf.error_class as last_error_class,
  lf.finished_at as last_finished_at,
  (select count(*) from recent x where x.agent_id = a.id) as runs_24h,
  (select count(*) from recent x where x.agent_id = a.id and x.run_state = 'failed') as failures_24h,
  (select count(*) from recent x where x.agent_id = a.id and x.run_state = 'running') as running_now,
  (select count(*) from ops.actions x where x.agent_id = a.id and x.status = 'pending_approval') as pending_approvals,
  b.connections as blocked_connections
from ops.agents a
left join last_finished lf on lf.agent_id = a.id
left join blocked b on b.agent_id = a.id
where a.enabled;

-- Gmail push health, per Inbox Triage agent with a watch (src/ingress.ts). push_state:
--   on       watch live and the last renewal succeeded
--   failing  the last renewal failed (triage continues on the schedule)
--   expired  the watch lapsed
-- A "miss" is a message the schedule picked up more than 2 minutes after it arrived, while the watch was
-- live, with no push received in between: push should have woken triage and didn't. Google may delay or
-- drop a notification now and then, so a single miss is normal; misses on 2+ separate scheduled runs in
-- 24h mean push is probably broken even though the watch looks healthy.
create or replace view ops.mail_push_health as
with w as (
  select s.agent_id, s.value->>'topic' as topic, (s.value->>'expiration')::timestamptz as expiration,
         (s.value->>'renewedAt')::timestamptz as renewed_at, (s.value->>'since')::timestamptz as since,
         s.value->>'lastError' as last_error, (s.value->>'lastErrorAt')::timestamptz as last_error_at
    from ops.state s where s.key = 'gmail.watch'
), acct as (
  select ac.agent_id, lower(c.account_label) as account
    from ops.agent_connections ac join ops.connections c on c.id = ac.connection_id where c.provider = 'google'
), ev as (
  select a.agent_id, max(e.first_received_at) as last_push_at,
         count(*) filter (where e.first_received_at > now() - interval '24 hours') as pushes_24h,
         coalesce(sum(e.delivery_count - 1) filter (where e.first_received_at > now() - interval '24 hours'), 0) as redeliveries_24h
    from acct a join ops.ingress_events e on e.source = 'gmail' and e.account = a.account group by a.agent_id
), lag as (
  select i.agent_id,
         count(*) filter (where i.triaged_by = 'push') as push_triaged_24h,
         count(*) filter (where i.triaged_by = 'schedule') as schedule_triaged_24h,
         percentile_cont(0.5) within group (order by extract(epoch from i.triaged_at - i.received_at)) filter (where i.triaged_by = 'push') as push_lag_p50_s,
         max(extract(epoch from i.triaged_at - i.received_at)) filter (where i.triaged_by = 'push') as push_lag_max_s
    from ops.inbox_items i where i.status = 'triaged' and i.triaged_at > now() - interval '24 hours' and i.received_at is not null
   group by i.agent_id
), miss as (
  select i.agent_id, count(*) as missed_24h, count(distinct i.source_workflow_id) as missed_runs_24h, max(i.triaged_at) as last_miss_at
    from ops.inbox_items i join w on w.agent_id = i.agent_id left join acct a on a.agent_id = i.agent_id
   where i.status = 'triaged' and i.triaged_by = 'schedule' and i.triaged_at > now() - interval '24 hours'
     and i.triaged_at - i.received_at > interval '2 minutes'
     and w.since is not null and i.received_at > w.since
     and not exists (select 1 from ops.ingress_events e where e.source = 'gmail' and e.account = a.account
                       and e.first_received_at between i.received_at and i.triaged_at)
   group by i.agent_id
)
select w.agent_id, w.topic,
       case when w.last_error is not null then 'failing'
            when w.expiration is null or w.expiration < now() then 'expired'
            else 'on' end as push_state,
       w.expiration, w.renewed_at, w.since, w.last_error, w.last_error_at,
       ev.last_push_at, coalesce(ev.pushes_24h, 0)::int as pushes_24h, coalesce(ev.redeliveries_24h, 0)::int as redeliveries_24h,
       coalesce(lag.push_triaged_24h, 0)::int as push_triaged_24h, coalesce(lag.schedule_triaged_24h, 0)::int as schedule_triaged_24h,
       round(lag.push_lag_p50_s::numeric, 1) as push_lag_p50_s, round(lag.push_lag_max_s::numeric, 1) as push_lag_max_s,
       coalesce(miss.missed_24h, 0)::int as missed_24h, coalesce(miss.missed_runs_24h, 0)::int as missed_runs_24h, miss.last_miss_at
  from w left join ev on ev.agent_id = w.agent_id left join lag on lag.agent_id = w.agent_id left join miss on miss.agent_id = w.agent_id;

create or replace view ops.attention_queue as
select 'approval_needed' as kind, a.id::text as ref, a.agent_id, a.created_at as since,
       a.logical_action || ' → ' || a.target as detail
  from ops.actions a where a.status = 'pending_approval'
union all
select 'action_failed', a.id::text, a.agent_id, a.updated_at, a.error
  from ops.actions a where a.status = 'failed'
union all
select 'run_failed', v.workflow_id, v.agent_id, v.finished_at, coalesce(v.error_class, '?') || ': ' || coalesce(v.error_message, v.dbos_status)
  from ops.v_runs v where v.run_state = 'failed' and v.finished_at > now() - interval '24 hours'
union all
select 'action_stuck', a.id::text, a.agent_id, a.decided_at,
       'approved but executor ' || coalesce(v.run_state, 'never started')
  from ops.actions a left join ops.v_runs v on v.workflow_id = a.idempotency_key
 where a.status = 'approved'
   and (v.run_state in ('failed', 'cancelled') or (v.workflow_id is null and a.decided_at < now() - interval '2 minutes'))
union all
select 'no_executor_for_version', v.workflow_id, v.agent_id, v.created_at,
       v.run_state || ' at version ' || v.app_version || ' but no live executor runs that version'
  from ops.v_runs v
 where v.run_state in ('queued', 'running') and v.app_version is not null
   and not exists (select 1 from ops.executors e where e.app_version = v.app_version
                     and e.reaped_at is null and e.stopped_at is null and e.last_seen_at > now() - interval '30 seconds')
union all
select 'run_stuck', v.workflow_id, v.agent_id, v.updated_at,
       case when not v.executor_alive then 'executor ' || coalesce(v.executor_id, '?') || ' is not alive' else 'no progress for 15m' end
  from ops.v_runs v where v.run_state = 'running' and (not v.executor_alive or v.updated_at < now() - interval '15 minutes')
union all
select 'queued_too_long', v.workflow_id, v.agent_id, v.created_at, 'queued on ' || coalesce(v.queue_name, '?') || ' at version ' || coalesce(v.app_version, 'latest')
  from ops.v_runs v where v.run_state = 'queued' and v.created_at < now() - interval '10 minutes'
union all
-- Every unhealthy connection, whether or not an agent uses it yet ('pending' = never authorized: not a problem).
select 'connection_problem', c.id, min(ac.agent_id), coalesce(c.last_checked_at, c.updated_at),
       case c.status when 'reauth_required' then 'Reauthorization needed' else c.status end
         || coalesce(coalesce(' (' || c.account_label || ')', '') || ': ' || c.last_error, '')
  from ops.connections c left join ops.agent_connections ac on ac.connection_id = c.id
 where c.status not in ('active', 'pending')
 group by c.id, c.last_checked_at, c.updated_at, c.status, c.account_label, c.last_error
union all
-- An active connection that lacks a scope some agent needs (e.g. Gmail for Inbox Triage): only those
-- agents are blocked; the fix is the same Reconnect, which asks for every scope.
select 'connection_problem', c.id, min(ac.agent_id), c.updated_at,
       'More access needed (' || coalesce(c.account_label, c.id) || '): reconnect to let '
         || string_agg(distinct initcap(replace(ac.agent_id, '-', ' ')), ', ') || ' use it'
  from ops.connections c join ops.agent_connections ac on ac.connection_id = c.id
 where c.status = 'active' and ac.required and not (ac.scopes <@ c.scopes)
 group by c.id, c.updated_at, c.account_label
union all
-- Briefs: tomorrow's (or today's) brief until it's been opened, and any brief whose calendar mirror failed.
select 'brief_ready', b.id::text, b.agent_id, b.updated_at,
       b.brief_date::text || ': ' || coalesce(b.headline, '') || ' (' || jsonb_array_length(b.items) || ' to prep)'
  from ops.briefs b
 where b.seen_at is null and jsonb_array_length(b.items) > 0
   and b.brief_date >= (now() at time zone b.timezone)::date
union all
select 'brief_mirror_failed', b.id::text, b.agent_id, b.updated_at,
       'Agent Ops mirror for ' || b.brief_date::text || ' not written: ' || coalesce(b.mirror_error, '?')
  from ops.briefs b
 where b.mirror_status = 'failed' and b.brief_date >= (now() at time zone b.timezone)::date
union all
select 'deeper_ready', d.brief_id::text || '/' || d.event_id, b.agent_id, d.created_at,
       coalesce((select i->>'title' from jsonb_array_elements(b.items) i where i->>'eventId' = d.event_id), d.event_id)
  from ops.brief_deeper d join ops.briefs b on b.id = d.brief_id
 where d.content is not null and d.seen_at is null and b.brief_date >= (now() at time zone b.timezone)::date
union all
-- Follow-up Tracker: a message the owner sent is past due with no reply. The item itself is the reminder.
select 'follow_up_due', f.id::text, f.agent_id, f.surfaced_at,
       coalesce(f.counterpart_name, f.counterpart[1]) || ' · ' || coalesce(f.expects, f.subject, '')
  from ops.follow_up_items f where f.status = 'due'
union all
-- Gmail push: an objectively broken watch shows at once; inferred breakage (misses) only when repeated.
select 'mail_push_off', h.agent_id, h.agent_id, coalesce(h.last_error_at, h.expiration),
       case h.push_state when 'failing' then 'Renewing the Gmail watch failed: ' || h.last_error
                         else 'The Gmail watch expired' end
  from ops.mail_push_health h where h.push_state <> 'on'
union all
select 'mail_push_degraded', h.agent_id, h.agent_id, h.last_miss_at,
       h.missed_24h || ' message(s) on ' || h.missed_runs_24h || ' scheduled runs in 24h arrived with no push'
  from ops.mail_push_health h where h.push_state = 'on' and h.missed_runs_24h >= 2
union all
select 'executor_unreaped', e.executor_id, null, e.last_seen_at, 'stale heartbeat, not yet reaped — is any worker alive?'
  from ops.executors e where e.reaped_at is null and e.last_seen_at < now() - interval '2 minutes';
