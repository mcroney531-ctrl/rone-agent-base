# #1 Agent Base: DBOS spike closeout

## Board status

```
#1 FOUNDATION   DBOS + AI SDK + our ops.* control plane
Architecture    selected (DBOS); Flue off the critical path unless a real-env check fails
Local suite     PASSED (13/13, no ARCHITECTURAL PROBLEM)
Production      validation pending: Supabase session pooler, Railway lifecycle, real Anthropic model
```

When the three production validations at the end of this doc pass, "provisional" comes off: #1 becomes **Locked**, and the next work is a useful workflow on this foundation, not more framework evaluation. Rule 4 is amended to patching mode (below), and that rule is absolute.

- **Pinned:** `@dbos-inc/dbos-sdk@5.3.0`, `@dbos-inc/vercel-ai@0.5.4`, `ai@7.0.153`, `@ai-sdk/anthropic@4.0.88`, `@ai-sdk/mcp@2.0.84`, `@modelcontextprotocol/sdk@1.32.2`
- **Where it ran:** local Postgres 16, a pgbouncer stand-in for the pooler, and a scripted model (no API key in the sandbox).
- **Raw evidence:** `docs/spike-results.json`, from `scripts/failure-suite.ts`; all 13 tests pass on the current code.

## Decision gates

| Gate | Result | Evidence |
|---|---|---|
| Scheduled occurrence identity is clean | **PASS** | ID is `sched-<schedule>-<scheduled ISO>`, derived from schedule + scheduled time, not fire time. t3: two live schedulers for ~6s gave 9 occurrences, 9 distinct runs, 0 doubled. |
| AI SDK + MCP ergonomics acceptable | **PASS** (real-model smoke pending) | `ToolLoopAgent` + `durableCalls` + `durableMCPTools` + `durableTools` against a real streamable-HTTP MCP server. Every model call, MCP listing, MCP call and tool call is a checkpointed step (16 per run). One adjustment: Anthropic needs an object at the top of a tool schema, so the action union is wrapped as `{ proposal }`. |
| Mid-run crash recovery works | **PASS WITH ADAPTER** | t1 (process restarted on the same replica: new executor ID, Railway IDs recorded only as metadata) and t1b (a different container): the heartbeat sweep took over in ~9s at test timings. Completed model calls replayed, not re-paid; only the in-flight call re-ran. |
| ACTION executor survives the crash window | **PASS** | t2: killed after the provider accepted, before the checkpoint. **4 attempts → 2 committed effects.** Executor workflow ID = idempotency key; a second enqueue under that ID returned the existing workflow. |
| Railway rolling deploy has a clean pattern | **PASS WITH ADAPTER** | t3b: SIGTERM drain finished in-flight work on the old container, nothing re-ran. t3: old container SIGKILLed mid-run during overlap; all 4 in-flight workflows taken over by the new one in ~11s, each re-ran only its in-flight turn; 0 duplicate actions; nothing left non-terminal. |
| Code-version change doesn't strand short-lived work | **PASS** in patching mode / **PASS WITH ADAPTER** in build-version mode | t4a: step-inserting change deployed mid-flight; old execution kept its sequence, new took the patched branch, no extra provider call. t4d (old code SIGTERMed, drain shorter than the work, patched new code overlapping): left PENDING, taken over by the new executor in ~11s, **old branch resumed**. t4c: with version = build ID, old-build work is stranded until an old-build executor runs. See **Rule 4**. |
| `ops.v_runs` without coupling health to internals | **PASS WITH ADAPTER** | t6: zero `pg_depend` edges from `ops.*` to `dbos.*`; health/attention views never name `dbos`; `v_runs` status counts equal the public `listWorkflows()` API exactly. |
| Supabase connection mode behaves correctly | **PASS WITH ADAPTER** (stand-in, re-run on Supabase) | t7 on pgbouncer: session pooler passes crash recovery + approvals; transaction pooler is refused at startup by our guard (port check + live LISTEN/NOTIFY probe). See finding F5. |

Supporting tests:

- **t4b (PASS):** an *unpatched* step change is caught loudly (DBOS error 26) and surfaced as `action_stuck` + `run_failed`; it is never executed silently.
- **t5 (PASS):** error classification and health states behave as designed.
- **t8 (PASS):** DBOS upgrade under live data, 5.1.10 → 5.2.11 → 5.3.0, with a workflow killed mid-flight before each hop.

## Open question answers

### Railway recovery pattern → A + B, with a bounded adapter for A

- **Executor identity contract: one executor = one process.** Every boot gets a fresh ID (`<deployment8>-<replica8>-<boot UUID>`, `src/config.ts`), which matches DBOS's own definition of `executorID` as a unique process ID. Railway deployment/replica IDs and git SHA are recorded in `ops.executors` as **metadata only**. Nothing depends on how Railway's IDs behave across restarts or overlapping deployments, which Railway doesn't document. A restarted process is a new executor; the worker refuses to register an ID that was already used.
- **Why something is needed at all:** DBOS's launch-time recovery only reclaims PENDING work whose `executor_id` equals *its own* ID *and* whose version equals its own (`reenqueueWorkflowsForRecovery`, `dbos-executor.js`). With per-process IDs, every dead process's PENDING work (crash, restart, or an old deployment) is orphaned until a live executor takes it over. The default ID, `'local'` for every container, would instead let a new container steal the old one's live work during overlap. DBOS v5 also **removed the admin server**, so older self-hosting recovery examples no longer apply.
- **B, drain:** on SIGTERM, `DBOS.shutdown({ workflowCompletionTimeoutMS })`. This is DBOS-native and covers normal deploys. Railway's default draining time is **0s**, so it must be set explicitly. 20s is a spike value; derive the production number from measured shutdown times in the Railway validation.
- **A, reclaim (adapter, `src/recovery.ts` + `ops.executors`):** each container heartbeats. A live container atomically claims an executor whose heartbeat is stale, then calls the public `DBOS.resumeWorkflows()` on its PENDING workflows. That re-enqueues them under the **same workflow ID** with checkpoints kept. A container that finds itself reaped exits (fencing). It uses only public DBOS APIs.
- **Not chosen:**
  - C, Conductor: would replace A, but adds an external dependency we don't need.
  - D: no DBOS-documented Railway pattern was found.

### `ops.v_runs` source → adapter view, no projection

This is controlled coupling, not no coupling. `sql/002_views.sql` (`ops.dbos_workflows()` + `ops.v_runs`) is the **only module permitted to know DBOS's storage shape**. Everything else (health, attention queue, dashboards, future agents) reads `ops.v_runs` and `ops.*` only. A DBOS upgrade that changes storage is absorbed in that one file.

- `dbos.workflow_status` is the system table shared by every DBOS SDK. Its 57-migration history is **add-column-only**: no column was ever renamed, retyped or dropped.
- `v_runs` reads it through a string-bodied `LANGUAGE sql` function, which Postgres doesn't record as a dependency but still inlines. So:
  - a future DBOS migration can never be blocked by our views (verified: 0 `pg_depend` edges; the 122 → 123 migration ran with the views in place);
  - if DBOS ever drops a column we use, health queries error loudly while the worker keeps booting.
- Domain facts DBOS doesn't have (agent, trigger, outcome class) come from our own `ops.runs` ledger, written by steps.
- Since there's no projection, no reconciliation sweep is required.

### Approval policy shape

`ops.agents.approval_policy` supports three modes:

- `{"mode":"pending_approval"}` (the default)
- `{"mode":"auto"}`
- `{"mode":"risk_threshold","auto_at_or_below":"low"}`, with risk taken from `ops.tools.default_risk`

Auto-approval uses the same atomic approve-and-enqueue path as a human approval. This is enough for the first real agents; revisit when one needs per-target rules.

## Rule 4 needs an amendment (Rone's decision)

The locked rule: *"App version = build version … Never pin `DBOS__APPVERSION` across changed workflow code."*

As written, t4c shows it strands work on Railway. DBOS executors only dequeue rows stamped with their own version, so when the old build's container dies (crash, or drain timeout), its in-flight work waits for an old-build executor that will never come back. The only escape hatches, `forkWorkflow` and `rewindWorkflow` across versions, either change the workflow ID (breaking rule 2) or force-replay old history on new code.

**Proposed rule 4:** run with `enablePatching: true` (DBOS uses one constant version, `PATCHING_ENABLED`). Any change that inserts, removes or reorders steps in a workflow is guarded with `DBOS.patch('<name>')`, later `deprecatePatch`, then removed. This is DBOS's supported mechanism, it's what made t4a pass, and t4b shows violations fail loudly instead of corrupting anything. `src/config.ts` defaults to this; `DBOS_VERSIONING=build` switches back to the original rule if you decide otherwise.

## Findings worth knowing

- **F1. Default executor ID is `'local'`:** that's the rule-5 trap, confirmed in source. The worker refuses to start if `DBOS__VMID` is set, and generates a fresh executor ID per process.
- **F2. Schedules and queues are database-backed in v5:** they're registered *after* `DBOS.launch()` (`applySchedules`, `registerQueue`). Schedules here come from `ops.agents` rows, so adding a scheduled agent is a row, not a deploy. `automaticBackfill` defaults to off, so ticks missed during a full outage are skipped, not replayed in a burst.
- **F3. Approval is atomic:** the approval flips the row and enqueues the executor in one Postgres transaction (`DBOSClient.enqueueInTransaction`). That closes the "approved but executor never started" window. `attention_queue.action_stuck` is the backstop.
- **F4. Client-enqueued work goes to the latest version:** enqueued work without an `appVersion` is picked up by the latest registered version, so approvals made during a deploy aren't tied to the old build.
- **F5. Transaction pooler degrades silently:** behind a transaction pooler, DBOS 5.3 self-tests LISTEN/NOTIFY, logs a warning, and **falls back to polling**. It does work (t7: a run completed in ~2.2s with the guard bypassed), but silently degraded. Our startup guard turns that into a hard refusal, which keeps the locked rule enforceable.
- **F6. Errors moved out of `workflow_status`:** DBOS moved workflow errors and outputs into `dbos.workflow_output`. `workflow_status.error` still exists but is empty. Any health query reading it directly would have silently broken, which is exactly the coupling rule 7 forbids. `v_runs` never read it.
- **F7. Failure classes:** our code classifies failures it can catch (`provider_auth`, `provider_unavailable`, `connection_unavailable`, `validation`, `internal`). DBOS-level failures (crash loop, step-sequence mismatch) never reach our catch block, so `v_runs` labels them from status (`crash_loop`, `unclassified_workflow_error`).
- **F8. Recovery latency with the adapter** is about `DEAD_AFTER_MS` + one sweep interval: ~10s at suite settings, ~40s at the defaults (5s heartbeat, 30s dead-after). That's fine for seconds-to-minutes workflows. With per-process IDs this applies to a plain crash-restart too, not only to deploys.
- **F9. The crash window shows up in tests too:** one t4a run killed the old process after the provider accepted but *before* DBOS checkpointed `callProvider`. That workflow then correctly took the new branch and the provider deduplicated the re-call. The test now waits for the checkpoint itself. Same lesson as rule 3, seen from the harness side.

## Production validation (do before Locked)

Runbook and Railway layout: [`railway-validation.md`](railway-validation.md). The Railway project `rone-agent-base` exists with `worker` / `externals` / `validator` configured but not yet deployed (waiting on secrets).

1. **Real Supabase, session mode.** Use the actual **Session pooler** URI copied from the project's Connect panel; don't infer the mode from the port. Supabase lists: direct `:5432` (IPv6 by default), session pooler `:5432` (IPv4), transaction pooler `:6543` (IPv4); session mode is its recommended IPv4 path for persistent backends. Check DBOS migrations, scheduling, the live LISTEN/NOTIFY probe (the guard that matters more than the port check), and crash recovery.
2. **Real Railway lifecycle.** Prove unique-process executors + heartbeat takeover across:
   - a hard crash (`POST /admin/crash` with `ENABLE_CHAOS=1`) followed by Railway's restart
   - an overlapping redeploy with SIGTERM drain
   - the t4d case on a real deploy: old container on old code, new on patched code, a workflow started under old code, old disappears, new resumes the old branch

   Measure actual shutdown times to set `drainingSeconds` / `DRAIN_TIMEOUT_MS`.
3. **Real Anthropic model.** With `ANTHROPIC_API_KEY` set, check the MCP + tool loop, checkpoint replay after a crash mid-loop, and a transient model failure. The model comes from `ops.agents.model`, default `claude-sonnet-5`.
4. **Untested edges:**
   - fencing of a reaped-but-alive executor (a network partition longer than `DEAD_AFTER_MS`)
   - a same-minor DBOS patch upgrade (npm only carries the latest patch of each 5.x minor)

## Housekeeping

- The superseded build's `agent_base` schema still exists in the **link-hoarder** Supabase project; its SQL is kept in `supabase/legacy/`. Drop it with `drop schema agent_base cascade;` once you've confirmed nothing uses it.
- The spike's `dbos.*` / `ops.*` schemas haven't been created in any Supabase project yet.
