-- Credential Watch V1A: a deadline tracker for credentials, on top of ops.connections.
-- Spec: Agent Hub project, credential-watch/v1a-spec.md (rev 3).
--
-- Rules this schema keeps:
--   * No secret values. secret_ref is a LOCATION by name ("railway:worker/ANTHROPIC_API_KEY"); a versioned,
--     frozen CHECK refuses key-shaped text there (connections_secret_ref_v1). Other text is checked by the API.
--   * Ownership: rows written here are managed_by = 'manual'; integration code only touches 'integration' rows.
--   * Nonblocking. Nothing here writes status, and nothing touches ops.agent_connections, so loadAgent and
--     agent_health cannot be affected by tracking a credential. A passed date never changes status.
--   * Say what kind of date it is: the credential's own expiry, a provider's announced deprecation target
--     (may move), or a review date the owner chose.
--   * Consumers and checks are what is KNOWN, with evidence; they are never presented as complete.
-- Migrations re-run on every boot: everything below is idempotent.

-- Secret detection is DEFENSE IN DEPTH, not a guarantee (see docs/credential-watch.md for the exact boundary).
-- No field stores a credential VALUE; these checks catch values pasted into fields meant for names and notes.
--
-- ops.secret_patterns: well-known key formats, JWTs, private keys, URLs with an embedded password, and long
-- mixed-case/digit tokens. Case-sensitive on purpose: real prefixes are lowercase (github_pat_, sk-ant-), so
-- an env-var NAME such as GITHUB_PAT_FOR_RELEASE never matches. The API applies it (best effort) to free text;
-- it may be widened over time because it is not a database constraint.
create or replace function ops.looks_like_secret(s text) returns boolean language sql immutable as $$
  select s is not null and (
    s ~ '(^|[^A-Za-z0-9])(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}|[sr]k_(live|test)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|1//0[A-Za-z0-9_-]{20,}|A[KS]IA[0-9A-Z]{16}|sb_(secret|publishable)_[A-Za-z0-9_-]{10,})'
    or s ~ 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'                         -- a JWT (header.payload)
    or s ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    or s ~ 'hooks\.slack\.com/services/'
    or s ~ '[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'       -- Discord bot token
    or s ~* '[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@'                          -- URL with user:password@
    -- a long token with a digit and at least 2 upper- and 2 lowercase letters (standard or URL-safe base64, most opaque
    -- keys). Names, env vars and slug-plus-hex page ids (Runbook-0123…abcd) do not mix like that.
    or exists (select 1 from regexp_matches(s, '[A-Za-z0-9+/=]{32,}|[A-Za-z0-9_-]{32,}', 'g') m(t)
                where m.t[1] ~ '[0-9]' and regexp_count(m.t[1], '[a-z]') >= 2 and regexp_count(m.t[1], '[A-Z]') >= 2)
  )
$$;

-- The DATABASE-ENFORCED check on secret_ref, versioned and frozen. NEVER edit this function's body: a CHECK
-- constraint is validated only when it is added, so editing it would silently apply new rules to new writes
-- while old rows went unchecked, and re-adding it on boot could stop every replica (review finding D8).
-- To change the rules: create ops.secret_ref_ok_v2, add connections_secret_ref_v2 NOT VALID in a new
-- migration, clean up any rows it flags, run ALTER TABLE ... VALIDATE CONSTRAINT deliberately, then drop v1.
-- v1 = a frozen COPY of ops.looks_like_secret as first shipped (not a call to it, so widening the API check
-- never changes this constraint), plus hex runs (a location name never holds 32 hex characters).
create or replace function ops.secret_ref_ok_v1(s text) returns boolean language sql immutable as $$
  select s is null or (length(s) <= 200 and s !~ '[0-9a-f]{32,}' and not (
      s ~ '(^|[^A-Za-z0-9])(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}|[sr]k_(live|test)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|1//0[A-Za-z0-9_-]{20,}|A[KS]IA[0-9A-Z]{16}|sb_(secret|publishable)_[A-Za-z0-9_-]{10,})'
      or s ~ 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'                         -- a JWT (header.payload)
      or s ~ '-----BEGIN [A-Z ]*PRIVATE KEY-----'
      or s ~ 'hooks\.slack\.com/services/'
      or s ~ '[MN][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'       -- Discord bot token
      or s ~* '[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@'                          -- URL with user:password@
      -- a long token with a digit and at least 2 upper- and 2 lowercase letters (standard or URL-safe base64, most opaque
      -- keys). Names, env vars and slug-plus-hex page ids (Runbook-0123…abcd) do not mix like that.
      or exists (select 1 from regexp_matches(s, '[A-Za-z0-9+/=]{32,}|[A-Za-z0-9_-]{32,}', 'g') m(t)
                  where m.t[1] ~ '[0-9]' and regexp_count(m.t[1], '[a-z]') >= 2 and regexp_count(m.t[1], '[A-Z]') >= 2)
    ))
$$;

alter table ops.connections
  add column if not exists display_name      text,
  add column if not exists kind              text,   -- null = not a tracked credential (e.g. a feed source)
  add column if not exists managed_by        text not null default 'integration',
  add column if not exists secret_ref        text,
  add column if not exists date_kind         text,
  add column if not exists renew_url         text,
  add column if not exists notes             text,   -- renewal notes, incl. shared-fate warnings
  -- Alert stage as of the last date edit, and when that stage's warning was raised. Written ONLY by the
  -- date-edit path (src/credentials.ts); stages reached by time passing are derived in the view.
  add column if not exists alert_stage       smallint not null default 0,
  add column if not exists alert_stage_since timestamptz;

alter table ops.connections drop constraint if exists connections_kind_check;
alter table ops.connections add constraint connections_kind_check
  check (kind is null or kind in ('oauth', 'api_key', 'pat', 'admin_key', 'secret', 'other'));
alter table ops.connections drop constraint if exists connections_managed_by_check;
alter table ops.connections add constraint connections_managed_by_check check (managed_by in ('integration', 'manual'));
alter table ops.connections drop constraint if exists connections_date_kind_check;
alter table ops.connections add constraint connections_date_kind_check
  check (date_kind is null or date_kind in ('expires', 'provider_target', 'review_by'));
-- Unversioned constraint from the first V1A deploy: replaced by connections_secret_ref_v1 (no-op once dropped).
alter table ops.connections drop constraint if exists connections_secret_ref_check;
-- Added ONCE (validating existing rows at that moment), never dropped and re-added on boot.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'connections_secret_ref_v1' and conrelid = 'ops.connections'::regclass) then
    alter table ops.connections add constraint connections_secret_ref_v1 check (ops.secret_ref_ok_v1(secret_ref));
  end if;
end $$;
alter table ops.connections drop constraint if exists connections_renew_url_check;
alter table ops.connections add constraint connections_renew_url_check check (renew_url is null or renew_url ~ '^https://');
alter table ops.connections drop constraint if exists connections_alert_stage_check;
alter table ops.connections add constraint connections_alert_stage_check check (alert_stage between 0 and 4);

update ops.connections set kind = 'oauth' where provider = 'google' and kind is null;

-- STABLE, not immutable: subtracting days from a timestamptz depends on the session TimeZone (review D7).
-- Stage of a date at a moment: 0 none, 1 within 30 days (Credentials card only), 2 within 14 days,
-- 3 within 7 days, 4 passed.
create or replace function ops.credential_stage(d timestamptz, at timestamptz) returns smallint language sql stable as $$
  select (case when d is null then 0
               when at >= d then 4
               when at >= d - interval '7 days' then 3
               when at >= d - interval '14 days' then 2
               when at >= d - interval '30 days' then 1
               else 0 end)::smallint
$$;

create or replace function ops.credential_threshold(stage smallint, d timestamptz) returns timestamptz language sql stable as $$
  select case stage when 1 then d - interval '30 days' when 2 then d - interval '14 days'
                    when 3 then d - interval '7 days' when 4 then d end
$$;

-- When the CURRENT stage's warning was raised. Time only raises the computed stage, so computed >= stored
-- always; computed > stored means a threshold was crossed by time since the last edit, and the warning
-- dates from that crossing. Otherwise it dates from the edit (carried, or now() if the edit escalated).
-- The notifier re-pushes an item only when this gets newer, and an ack hides it until it does.
create or replace function ops.credential_since(d timestamptz, stored smallint, stored_since timestamptz, at timestamptz)
returns timestamptz language sql stable as $$
  select case when ops.credential_stage(d, at) > coalesce(stored, 0)
              then greatest(ops.credential_threshold(ops.credential_stage(d, at), d), stored_since)
              else stored_since end
$$;

create table if not exists ops.credential_consumers (
  id            bigserial primary key,
  connection_id text not null references ops.connections(id) on delete cascade,
  consumer      text not null check (length(consumer) between 1 and 200),
  confidence    text not null check (confidence in ('confirmed', 'candidate')),
  evidence      text not null check (length(evidence) between 1 and 500),
  agent_id      text references ops.agents(id) on delete set null,  -- display only; never used for blocking
  noted_at      timestamptz not null default now(),
  noted_by      text
);
create index if not exists credential_consumers_conn_idx on ops.credential_consumers (connection_id);

-- Coverage, kept light: what was checked, what it showed, when. "Not checked" is a valid result.
create table if not exists ops.credential_checks (
  id            bigserial primary key,
  connection_id text not null references ops.connections(id) on delete cascade,
  scope         text not null check (length(scope) between 1 and 300),
  result        text not null check (length(result) between 1 and 500),
  checked_at    timestamptz not null default now(),
  noted_by      text
);
create index if not exists credential_checks_conn_idx on ops.credential_checks (connection_id);
