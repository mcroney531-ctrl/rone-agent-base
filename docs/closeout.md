# #1 Agent Base: DBOS spike closeout

**Recommendation:** lock DBOS as the foundation. No result was an ARCHITECTURAL PROBLEM, so Flue stays on the bench. Three things couldn't be exercised in the build sandbox and should be confirmed in the real environment before flipping #1 to **Locked**:

1. Supabase pooler
2. a real Railway deploy
3. one real-model run

They're listed at the end. One locked rule (#4) needs an amendment, and that's Rone's decision.

- **Pinned:** `@dbos-inc/dbos-sdk@5.3.0`, `@dbos-inc/vercel-ai@0.5.4`, `ai@7.0.153`, `@ai-sdk/anthropic@4.0.88`, `@ai-sdk/mcp@2.0.84`, `@modelcontextprotocol/sdk@1.32.2`
- **Where it ran:** local Postgres 16, a pgbouncer stand-in for the pooler, and a scripted model (no API key in the sandbox).
- **Raw evidence:** `docs/spike-results.json`, from one clean run of `scripts/failure-suite.ts`, all 12 tests in a single pass.

## Decision gates

| Gate | Result | Evidence |
|---|---|---|
| Scheduled occurrence identity is clean | **PASS** | ID is `sched-<schedule>-<scheduled ISO>`, derived from schedule + scheduled time, not fire time. t3: two live schedulers for ~6s gave 9 occurrences, 9 distinct runs, 0 doubled. |
| AI SDK + MCP ergonomics acceptable | **PASS** (real-model smoke pending) | `ToolLoopAgent` + `durableCalls` + `durableMCPTools` + `durableTools` against a real streamable-HTTP MCP server. Every model call, MCP listing, MCP call and tool call is a checkpointed step (16 per run). One adjustment: Anthropic needs an object at the top of a tool schema, so the action union is wrapped as `{ proposal }`. |
| Mid-run crash recovery works | **PASS** / **PASS WITH ADAPTER** | t1 (same container restarts): completed model calls replayed, not re-paid; only the in-flight call re-ran. t1b (a *different* container takes over): needs the recovery adapter below; recovered in ~10s at test timings. |
| ACTION executor survives the crash window | **PASS** | t2: killed after the provider accepted, before the checkpoint. **4 attempts → 2 committed effects.** Executor workflow ID = idempotency key; a second enqueue under that ID returned the existing workflow. |
| Railway rolling deploy has a clean pattern | **PASS WITH ADAPTER** | t3b: SIGTERM drain finished in-flight work on the old container, nothing re-ran. t3: old container SIGKILLed mid-run during overlap; all 4 in-flight workflows taken over by the new one in ~11s, each re-ran only its in-flight turn; 0 duplicate actions; nothing left non-terminal. |
| Code-version change doesn't strand short-lived work | **PASS** in patching mode / **PASS WITH ADAPTER** in build-version mode | t4a: step-inserting change deployed mid-flight; old execution kept its sequence, new took the patched branch, nothing stranded, no extra provider call. t4c: with version = build ID, the old build's in-flight work is stranded until an old-build executor runs. See **Rule 4** below. |
| `ops.v_runs` without coupling health to internals | **PASS WITH ADAPTER** | t6: zero `pg_depend` edges from `ops.*` to `dbos.*`; health/attention views never name `dbos`; `v_runs` status counts equal the public `listWorkflows()` API exactly. |
| Supabase connection mode behaves correctly | **PASS WITH ADAPTER** (stand-in, re-run on Supabase) | t7 on pgbouncer: session pooler passes crash recovery + approvals; transaction pooler is refused at startup by our guard (port check + live LISTEN/NOTIFY probe). See finding F5. |

Supporting tests:

- **t4b (PASS):** an *unpatched* step change is caught loudly (DBOS error 26) and surfaced as `action_stuck` + `run_failed`; it is never executed silently.
- **t5 (PASS):** error classification and health states behave as designed.
- **t8 (PASS):** DBOS upgrade under live data, 5.1.10 → 5.2.11 → 5.3.0, with a workflow killed mid-flight before each hop.

## Open question answers

### Railway recovery pattern → A + B, with a bounded adapter for A

- **Why something is needed at all:** DBOS's launch-time recovery only reclaims PENDING work whose `executor_id` equals *its own* ID *and* whose version equals its own (`reenqueueWorkflowsForRecovery`, `dbos-executor.js`). Rule 5 (unique ID per container) is correct: the default ID is `'local'` for every container, which would let a new container steal the old one's live work during overlap. But it means a container that disappears for good leaves its PENDING work orphaned. DBOS v5 also **removed the admin server**, so older self-hosting recovery examples no longer apply.
- **B, drain:** on SIGTERM, `DBOS.shutdown({ workflowCompletionTimeoutMS })`. This is DBOS-native and covers normal deploys.
- **A, reclaim (adapter, `src/recovery.ts` + `ops.executors`):** each container heartbeats. A live container atomically claims an executor whose heartbeat is stale, then calls the public `DBOS.resumeWorkflows()` on its PENDING workflows. That re-enqueues them under the **same workflow ID** with checkpoints kept. A container that finds itself reaped exits (fencing). It uses only public DBOS APIs.
- **Not chosen:**
  - C, Conductor: would replace A, but adds an external dependency we don't need.
  - D: no DBOS-documented Railway pattern was found.

### `ops.v_runs` source → adapter view, no projection

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

- **F1. Default executor ID is `'local'`:** that's the rule-5 trap, confirmed in source. The worker refuses to start if `DBOS__VMID` is set, and derives its ID from `RAILWAY_REPLICA_ID`.
- **F2. Schedules and queues are database-backed in v5:** they're registered *after* `DBOS.launch()` (`applySchedules`, `registerQueue`). Schedules here come from `ops.agents` rows, so adding a scheduled agent is a row, not a deploy. `automaticBackfill` defaults to off, so ticks missed during a full outage are skipped, not replayed in a burst.
- **F3. Approval is atomic:** the approval flips the row and enqueues the executor in one Postgres transaction (`DBOSClient.enqueueInTransaction`). That closes the "approved but executor never started" window. `attention_queue.action_stuck` is the backstop.
- **F4. Client-enqueued work goes to the latest version:** enqueued work without an `appVersion` is picked up by the latest registered version, so approvals made during a deploy aren't tied to the old build.
- **F5. Transaction pooler degrades silently:** behind a transaction pooler, DBOS 5.3 self-tests LISTEN/NOTIFY, logs a warning, and **falls back to polling**. It does work (t7: a run completed in ~2.2s with the guard bypassed), but silently degraded. Our startup guard turns that into a hard refusal, which keeps the locked rule enforceable.
- **F6. Errors moved out of `workflow_status`:** DBOS moved workflow errors and outputs into `dbos.workflow_output`. `workflow_status.error` still exists but is empty. Any health query reading it directly would have silently broken, which is exactly the coupling rule 7 forbids. `v_runs` never read it.
- **F7. Failure classes:** our code classifies failures it can catch (`provider_auth`, `provider_unavailable`, `connection_unavailable`, `validation`, `internal`). DBOS-level failures (crash loop, step-sequence mismatch) never reach our catch block, so `v_runs` labels them from status (`crash_loop`, `unclassified_workflow_error`).
- **F8. Recovery latency with the adapter** is about `DEAD_AFTER_MS` + one sweep interval: ~10s at suite settings, ~40s at the defaults (5s heartbeat, 30s dead-after). That's fine for seconds-to-minutes workflows.

## Not verified here (do before Locked)

1. **Real Supabase.** Run the suite against the actual project, over the **session pooler** (`*.pooler.supabase.com:5432`) or the direct connection. Two things to know:
   - Supabase's direct host is IPv6-only unless the IPv4 add-on is enabled, so from Railway the session pooler is likely the practical choice.
   - Its pooler is Supavisor, not pgbouncer.

   The Supabase connector in this session needed re-authorization, so nothing was applied to Supabase this time.
2. **Real Railway.** Confirm that `RAILWAY_REPLICA_ID` is stable across restarts of one deployment and new per deployment. Set the draining time ≥ `DRAIN_TIMEOUT_MS`, then repeat t3/t3b with an actual redeploy.
3. **Real model.** Set `ANTHROPIC_API_KEY` and run one scheduled tick (the model comes from `ops.agents.model`, default `claude-sonnet-5`) to confirm that schema conversion and tool calling behave the same as the scripted model.
4. **Untested edges:**
   - fencing of a reaped-but-alive executor (a network partition longer than `DEAD_AFTER_MS`)
   - a same-minor DBOS patch upgrade (npm only carries the latest patch of each 5.x minor)

## Housekeeping

- The superseded build's `agent_base` schema still exists in the **link-hoarder** Supabase project; its SQL is kept in `supabase/legacy/`. Drop it with `drop schema agent_base cascade;` once you've confirmed nothing uses it.
- The spike's `dbos.*` / `ops.*` schemas haven't been created in any Supabase project yet.
