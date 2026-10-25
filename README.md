# rone-agent-base

A durable personal automation platform where some workflow steps happen to be agents. Future agents should cost a config row and maybe one tool, not a new app.

This is the **DBOS spike** (handoff #1, DBOS version). It supersedes the earlier Railway-cron + direct-API build, which has been removed; see git history and `supabase/legacy/`.

- **Results and decisions:** [`docs/closeout.md`](docs/closeout.md)
- **How to work in this code without breaking recovery:** [`docs/durable-workflows.md`](docs/durable-workflows.md) — read it first.

## What's here

```
src/
  config.ts       env, unique executor ID, versioning mode, transaction-pooler guard
  db.ts           pg pool for ops.*
  workflows.ts    reasoning workflow (agentRun / scheduledAgentRun) + executor workflow (executeAction)
  model.ts        AI SDK model wrapped in durableCalls (scripted mock when no ANTHROPIC_API_KEY)
  errors.ts       our failure classification (health never parses DBOS errors)
  recovery.ts     Railway recovery adapter: heartbeats, reap dead executors, resume their work
  main.ts         launch, queues, config-driven schedules, HTTP API, SIGTERM drain
  externals.ts    fake idempotent provider + test MCP server (separate process)
sql/
  001_ops_schema.sql   ops.* domain + control plane
  002_views.sql        ops.v_runs (the only DBOS-aware object), agent_health, attention_queue
scripts/
  failure-suite.ts     failure suite t1–t8 → docs/spike-results.json
  upgrade-test.sh      DBOS upgrade under live data (used by t8)
```

## Ownership

| | Owner |
|---|---|
| Schedules, workflows, queues, retries, recovery | DBOS (`dbos.*`) |
| Model calls, tool loop, MCP | AI SDK + `@dbos-inc/vercel-ai` |
| Agents, tools, connections, agent_connections, state, actions, runs ledger, executors | ours (`ops.*`) |
| Health, attention queue | ours, reading `ops.v_runs` only |

## Flow

1. **A trigger starts a workflow with a deterministic ID.** A schedule from `ops.agents.schedule` gives `sched-agent-<id>-<time>`; `POST /agents/:id/run {requestId}` gives `manual-…`; `POST /webhooks/:id {eventId}` gives `webhook-…`.
2. **The reasoning workflow runs.** It loads config, runs `ToolLoopAgent` (MCP tools plus `read_state`, `write_state`, `propose_action`), writes `ops.actions` rows, and **ends**.
3. **A decision starts the executor.** `POST /actions/:id/approve` (or the auto policy) flips the row and enqueues the executor in one transaction. The executor's workflow ID is the action's idempotency key. `POST /actions/:id/reject` just closes it.
4. **The executor calls the provider.** It sends the `Idempotency-Key`, then records the result.
5. **Health reads the views.** `GET /health` shows `ops.agent_health` and `ops.attention_queue`. `GET /runs` and `GET /actions` show the rest.

## Run it locally

Needs Node 22+ and Postgres; the failure suite also uses pgbouncer for t7.

```bash
npm install
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/spike        # direct or session pooler only
export FAKE_PROVIDER_DATABASE_URL=postgres://postgres@127.0.0.1:5432/fake_provider
npm run externals &          # fake provider + MCP server on :7801
EXECUTOR_ID=local-dev npm start
```

The seeded `spike-agent` runs every 30s and proposes 3 actions. Approve them:

```bash
curl -s localhost:7800/actions?status=pending_approval
curl -s -XPOST localhost:7800/actions/<id>/approve
curl -s localhost:7800/health
```

Set `ANTHROPIC_API_KEY` to use the real model instead of the scripted one.

## Failure suite

With `npm run externals` running and Postgres on `PG_ADMIN_URL`:

```bash
PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres DATABASE_URL=$PG_ADMIN_URL npm run suite          # all
PG_ADMIN_URL=… DATABASE_URL=… npm run suite -- t2 t3                                                      # some
```

t7 expects pgbouncer on `:6432` with `spike_t7_tx` / `spike_t7_sess` / `spike_t7b_tx` pools; see the t7 notes in `docs/closeout.md`.

## Deploying to Railway (once the closeout's real-env checks pass)

- **`DATABASE_URL`:** the Supabase **session pooler** (`…pooler.supabase.com:5432`) or the direct connection. The worker refuses port 6543 and any connection where LISTEN/NOTIFY doesn't round-trip.
- **`API_TOKEN`:** required on Railway. Every request needs `Authorization: Bearer <token>`, because this API can approve external actions. Webhooks will also need provider signature checks before real use.
- **Executor identity:** one fresh ID per process, generated at boot. Railway deployment/replica IDs are recorded in `ops.executors` as metadata only. Never set `DBOS__VMID` or `EXECUTOR_ID` in production.
- **Versioning:** the default `DBOS_VERSIONING=patching` gives DBOS a constant version. Guard step-order changes with `DBOS.patch()`.
- **Draining:** Railway's default draining time is 0s. Set it ≥ `DRAIN_TIMEOUT_MS` (20s is a spike value; tune from measured shutdowns).
- **Healthcheck:** `/livez` (unauthenticated, returns only the executor ID).
- **Tuning:** `HEARTBEAT_MS` (5s) and `DEAD_AFTER_MS` (30s) control how quickly a dead container's work is reclaimed.
