-- Eval harness (src/eval/): score an agent's judgment layer (its real prompt, schema and model) against a
-- versioned scenario corpus, without touching providers. One row per run, one per scenario.
-- Every run records what it measured (prompt, model + config, schema, corpus, evaluator, commit), so a change
-- in score can be traced to "the prompt changed" vs "the model/config changed" vs "the labels changed".
create table if not exists ops.eval_runs (
  id                bigserial primary key,
  suite             text not null,                 -- e.g. 'inbox-triage'
  status            text not null default 'running' check (status in ('running', 'passed', 'failed', 'error')),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  git_commit        text,
  prompt_hash       text,
  model             text,
  model_config      jsonb,
  schema_version    text,
  corpus_version    text,
  corpus_hash       text,
  evaluator_version text,
  splits            text[],                         -- which splits were scored: dev, holdout
  metrics           jsonb,                          -- REPORT: accuracy, per-category precision/recall, confusion, draft quality
  critical_failures int,                            -- BLOCK: count of failed critical invariants
  baseline_run_id   bigint references ops.eval_runs(id),
  error             text
);
create index if not exists eval_runs_suite_idx on ops.eval_runs (suite, started_at desc);

create table if not exists ops.eval_results (
  run_id      bigint not null references ops.eval_runs(id) on delete cascade,
  scenario_id text not null,
  split       text not null check (split in ('dev', 'holdout')),
  expected    jsonb not null,
  output      jsonb,
  correct     boolean,                              -- predicted category is acceptable
  checks      jsonb not null default '[]',          -- [{id, critical, pass, detail}]
  primary key (run_id, scenario_id)
);
