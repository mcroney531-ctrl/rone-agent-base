-- Model-provider health (Anthropic). Detected from the provider's own failure responses on real calls, never
-- from a guessed balance: Anthropic exposes no cheap balance endpoint for a normal API key. One row per provider
-- = one Needs You item per outage, however many runs or agents hit it. Cleared by the next successful call.
create table if not exists ops.provider_status (
  provider        text primary key,
  state           text not null default 'ok' check (state in ('ok', 'credits_exhausted', 'auth_failed')),
  since           timestamptz,             -- start of the current outage (null when ok)
  last_failure_at timestamptz,
  last_error      text,
  failures        integer not null default 0, -- failed calls in the current outage
  last_ok_at      timestamptz,
  updated_at      timestamptz not null default now()
);
insert into ops.provider_status (provider) values ('anthropic') on conflict do nothing;

-- Outage history: run_failed cards that fall inside an outage window are covered by the provider item, so they
-- stay out of Needs You (run history is untouched: ops.runs / ops.v_runs keep every failed run).
create table if not exists ops.provider_outages (
  id         bigserial primary key,
  provider   text not null,
  kind       text not null check (kind in ('credits_exhausted', 'auth_failed')),
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  failures   integer not null default 0
);
create unique index if not exists provider_outages_open_idx on ops.provider_outages (provider) where ended_at is null;
