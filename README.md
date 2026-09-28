# rone-agent-base

Reusable orchestration control plane. Every future agent idea should cost
"add a row + maybe one new tool," not "build a new app." Calendar (or any
other trigger surface) plugs into this as trigger adapter #2+; Supabase +
a single worker is the spine.

```
Railway cron dispatcher (~5 min tick)
        ↓
  queries Supabase: which agents are due?
        ↓
  Worker runs agent → calls Anthropic API → tool loop
        ↓
  Agent proposes ACTIONS (typed, schema-validated)
        ↓
  Approval policy check (auto or pending_approval)
        ↓
  Execute via TOOLS registry → external integrations
```

## Status

Steps 1–5 of the build sequencing are done: schema, dispatcher, Anthropic
tool-use loop, ACTIONS layer with idempotency, and a minimal dashboard.
Calendar/webhook trigger adapters (steps 6–7) are **not** built yet —
intentionally, per the original sequencing (OAuth setup is its own session).

## Where the data lives

The `agent_base` Postgres **schema** (not a new project) lives inside the
existing **`link-hoarder`** Supabase project (`nprjsjiihevovxcondqb`). A
dedicated project was skipped to avoid tripping the free-tier's 2-project
cap — this org already has 3 (ProjDash, Reading Center, link-hoarder). The
schema is fully isolated from `link-hoarder`'s own `public.links` /
`public.categories` tables. Move it to its own project later if/when a paid
plan or a fresh org makes sense; nothing here assumes it stays put.

Tables: `agent_base.agents`, `triggers`, `runs`, `actions`, `state`,
`tools`, `connections`. Full definitions in
`supabase/migrations/20260928000000_agent_base_control_plane_schema.sql`
(already applied to the live project — this file is the record, re-running
it isn't necessary unless you're setting up a new project).

A single seed row (`heartbeat-test` agent + `state.write` tool) exists to
prove the dispatcher → worker → Supabase → Anthropic → ACTIONS path end to
end without any real external side effects.

## Repo layout

```
src/
  lib/
    supabase.js     service-role client, scoped to the agent_base schema
    anthropic.js    Anthropic SDK client + rough per-model cost estimate
    cron.js         cron-expression due/next-run helpers
  tools/
    registry.js     TOOL_HANDLERS (code) — schemas/descriptions live in agent_base.tools
  actions.js         propose → approval policy → execute, with idempotency
  runAgent.js        the Anthropic tool-use loop for one run
  runOnce.js         trigger+run bookkeeping around runAgent (shared by cron + manual)
  dispatch.js        Railway cron entry point: finds due agents, calls runOnce

dashboard/
  netlify/functions/ thin API (agents/runs/actions/run-now) using the service-role key server-side
  public/            static PWA — no client ever sees the service-role key

supabase/migrations/ SQL history
```

## Key design decisions (carried over from the handoff doc)

1. Agents are config rows by default. `handler`/`workflow_type` on
   `agents` are escape hatches for anything needing real custom code —
   `dispatch.js` currently just logs and skips agents with a `handler` set
   until that's implemented, rather than guessing at behavior.
2. ACTIONS are separate from RUNS — one run can propose several actions,
   each approved/rejected independently.
3. `actions.idempotency_key` is a mandatory unique column:
   `agent_id + tool_name + target + run_id`. `proposeAction()` treats a
   unique-constraint violation as "already proposed" and returns the
   existing row instead of erroring.
4. One Railway cron dispatcher, ~5 min tick, Railway's own
   "skip overlapping invocation" as the scheduler-level concurrency guard.
   That is a *different* guard from the idempotency key — the key protects
   an individual action even if two runs somehow both propose it.
5. Direct Anthropic API calls from the worker with a strict tool-use
   schema (`agent_base.tools.input_schema`), not MCP. Read-only tools
   (`permission_level = 'read'`) execute inline; write/send tools always
   go through the ACTIONS layer, never called directly from the loop.

## Setup

```bash
npm install
cp .env.example .env   # fill in SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY
```

`SUPABASE_URL` in `.env.example` already points at the `link-hoarder`
project. Get the service-role key from that project's Supabase dashboard
(Settings → API) — never commit it.

Run the dispatcher once locally:

```bash
npm run dispatch
```

This queries `agent_base.agents` for anything due, runs it (currently just
`heartbeat-test`), and writes the run/action rows.

## Deploying the worker (Railway)

1. New Railway project → **Cron Job** service (not a regular
   always-on service) pointed at this repo.
2. Start command: `node src/dispatch.js`.
3. Schedule: `*/5 * * * *`.
4. Env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`.
5. Leave "skip overlapping invocation" on (Railway's default for cron
   services) — it's the scheduler-level concurrency guard mentioned above.

## Deploying the dashboard (Netlify)

Follows the same "connect the repo, let Netlify build" pattern as other
projects. `netlify.toml` already points at `dashboard/public` and
`dashboard/netlify/functions`.

1. New Netlify site from this repo.
2. Env vars (Site settings → Environment): `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, and optionally
   `DASHBOARD_TOKEN` (a shared secret gate — see caveat below).
3. Local dev: `netlify dev` from the repo root (requires the Netlify CLI).

The dashboard shows recent runs, actions pending approval (approve/reject
buttons), and a manual "run now" per agent. All Supabase access happens
server-side in the Netlify Functions — the browser never sees the
service-role key.

**Auth caveat:** `DASHBOARD_TOKEN` is a single shared secret compared in
plain text (`dashboard/netlify/functions/_shared.js`), not real
authentication. Fine for one person hitting their own dashboard; replace
with proper auth before sharing access with anyone else.

## Adding a new agent

No code, just a row:

```sql
insert into agent_base.agents (name, schedule, model, system_prompt, allowed_tools, approval_policy)
values (
  'my-new-agent',
  '0 * * * *',
  'claude-sonnet-5',
  'You are ...',
  array['state.write'],
  '{"mode": "pending_approval"}'::jsonb
);
```

## Adding a new tool

1. Insert a row into `agent_base.tools` with its JSON Schema and
   `permission_level` (`read` executes inline; `write`/`send` always route
   through the ACTIONS layer).
2. Add a handler function to `TOOL_HANDLERS` in `src/tools/registry.js`.
3. Add the tool's name to whichever agents' `allowed_tools` should have it.

## Not built yet (by design — see original build sequencing)

- Calendar trigger adapter (`>>`-prefixed "Agent Ops" calendar commands,
  OAuth as the calendar owner, Production-status app to dodge the 7-day
  Testing-status token expiry).
- Webhook trigger adapter.
- Real auth on the dashboard beyond the shared-secret gate.
- A second, dedicated Supabase project once one is worth paying for.
