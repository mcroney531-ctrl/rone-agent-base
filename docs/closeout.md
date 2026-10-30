# #1 Agent Base: DBOS spike closeout

## Board status

```
#1 — Agent Base / Control Plane
FOUNDATION: DBOS + Vercel AI SDK + ops.* control plane
STATUS: LOCKED (2026-10-26)

Validation:
Local failure suite       PASS
Real Supabase             PASS
Real Claude + MCP         PASS
Railway hard crash        PASS
Railway rolling deploy    PASS
Patch/version migration   PASS
External idempotency      PASS
Graceful drain            PASS
```

Flue is off the critical path. Rule 4 is amended to patching mode, and it is absolute: any change to a workflow's step structure ships behind `DBOS.patch()`.

### Producer #2: Inbox Triage

Chosen to stress what Calendar Prep doesn't: frequent runs (every 20 min), a new scope on a shared connection, event-ish intake with a cursor, per-item classification, new ACTION types and far more Needs You traffic.

- **Intake:** Gmail history API cursor (`ops.state` `gmail.historyId`), bootstrapped from the last 24 h. An expired cursor (404) re-bootstraps. New IDs are queued as `ops.inbox_items` 'pending' in the same transaction that advances the cursor, then triaged 25 per run (dedupe on message ID).
- **Classification:** `can_reply` (a capability: no-reply / auto-submitted senders) is separate from the category, so a no-reply message can still be `action_required`. `needs_reply` requires `can_reply`. Promotions/Social skip the model, recorded as `triage_source = 'heuristic'` (a heuristic we may relax).
- **Actions:** `gmail.label` adds `Agent Ops/*` labels only (low risk, auto-approved by the agent's `risk_threshold` policy). `gmail.draft` creates a threaded draft reply (medium, always needs the owner; approving creates the draft, which can still be edited in Gmail).
- **Never send:** `gmail.modify` lets Google accept a send, so "never send" is an application invariant enforced at the capability boundary. `src/connections/gmail.ts` is the only Gmail code: read inbox, add Agent Ops labels, find/create drafts. No send, delete, trash, archive, read-state, spam or non-Agent-Ops label method exists. The executor refuses any other `gmail.*` action. The test fake records every forbidden call and the suite asserts zero.
- **Drafts are created once:** Gmail has no idempotency key, so each draft carries a deterministic Message-ID from the action's key and we look for it before creating. Tested by killing the worker right after Gmail accepted a draft: the replacement found it and made no second one.
- **Shared connection, per-agent scopes:** `agent_connections.scopes`. An active Google connection without Gmail blocks only Inbox Triage (one Reconnect item naming it), Calendar Prep keeps running. Blocked agents now skip scheduled occurrences (`last_skip_reason = 'blocked'`) instead of failing every tick; manual runs still fail loudly.
- **Genericity (the #1a test):** `test-inbox-triage` runs both producers and checks one Needs You list with one item shape, one health model (pause one, the other stays healthy) and pause/409 working unchanged for the new producer.

### Hardening backlog (after Lock, not architecture)

- **H1. Zombie / reaped-but-alive executor — DONE (failure-suite t9, t9b, t9c).** The test found two real bugs, both fixed: (1) our catch blocks treated DBOS's "workflow no longer owned" (`DBOSWorkflowConflictError`) as a run failure and recorded it, so a stale executor could mark a run its replacement owned as failed; they now rethrow DBOS control errors untouched (`dbosControlError` in `src/errors.ts`) and DBOS adopts the owner's outcome. (2) An executor whose heartbeat could not reach the database kept running after it was reaped and dequeued the very workflow its replacement had resumed, so two executions of one workflow shared a process (the AI SDK durable-call guard then failed the legitimate one). Executors now hold a lease: no renewed heartbeat for 60% of `DEAD_AFTER_MS` → exit 70 before any peer may reap them (18 s in production; a longer database outage restarts workers, which then recover through the normal sweep). Results: heartbeat partition (t9): the zombie fences itself ~3 s in, before the reap; frozen process woken mid-way through the peer's run (t9b): it checks its lease first and exits; lease disabled (t9c): DBOS rejects its next checkpoint, it stands down without recording anything, and its next heartbeat sees the reap and exits. All three: one outcome owned by the peer, 3 actions / 3 keys / 1 ledger row, and health/attention sampled every 400 ms never showed a failure (only a truthful `degraded` while the frozen executor held the run).
- **H2. Real-provider transient model failure.** The 529 vs 401 classification and retry are proven locally; induce a real transient Anthropic failure when there's a clean way to.
- **H3. Simultaneous boot on an empty database.** Two workers booting at the same moment against a fresh DB race DBOS's own system-table migrations ("tuple concurrently updated"); one crashes (found by the push test, 2026-10-27). No production exposure (the DB exists; Railway restarts crashed workers). Test first: two workers, empty DB → exactly one migration path, both eventually healthy. Likely fix: advisory lock around the `DBOS.launch()` boundary. Don't touch production for it until the test reproduces.
- **H4. Client/API compatibility contract — DONE (`src/compat.ts`).** Two producers now feed one generic phone surface, so payload evolution is a platform concern. The contract: (1) the app bakes `CLIENT_COMPAT` into its code and sends it on every call (`x-client-compat`); the server refuses a client below `MIN_CLIENT_COMPAT` with 426 `client_outdated` before the call does anything, and the app reloads once (a second refusal within a minute shows "out of date" instead of looping). Calls without the header (API token, scripts) are not checked. Boot refuses a `MIN_CLIENT_COMPAT` the served app doesn't meet. (2) The shapes the app reads (attention item, drill-in, action result) are zod schemas, non-strict so added fields are compatible; a compile-time check ties them to the server types, and `test-mobile` / `test-inbox-triage` parse every `/attention` response from both producers through them. (3) Tolerant reader: the app must render what it doesn't know (new item types and actions POST generically; missing lists render empty). **Bump rule:** raise `CLIENT_COMPAT` (app) and `MIN_CLIENT_COMPAT` (server) together, in one PR, only for a breaking change: a field the app reads is removed, renamed or changes meaning, or an action/route changes semantics. Additive changes never bump. The `build` check (#16/#18) still reloads stale tabs on resume, focus and every 5 minutes; the contract closes the window between a deploy and that check.
- **Custom SMTP for Supabase Auth.** The built-in sender allows ~2 emails/hour, is best-effort and not meant for production; email is the recovery path into the ops console. Same tier as the remaining #1a hardening.
- **Cross-session auth checks (manual, real devices).** (a) Sign out on PC, phone stays signed in, and the reverse. (b) Agent Ops sign-out leaves Link Hoarder signed in. (c) Audit Link Hoarder (and anything else on this Supabase project) for bare `signOut()` calls, which default to global scope.

### Auth rule (phone app), from INC-2026-10-27

An API 401 never signs the user out directly: 401 → refresh session (single-flight: one refresh shared by every waiting request) → retry once → refresh ok: continue; session really gone: sign out **locally**. Never call `signOut()` without `{ scope: 'local' }`: the supabase-js default is global and revokes every session of the account on every device and in every app on the same Supabase project. Implemented in `public/session.js`, enforced by `scripts/test-session.ts` in CI.

INC-2026-10-27: during push validation a resumed PC app sent an expired access token; the 401 handler called the global `signOut()`, which revoked the phone's session too (Supabase auth logs: `/user` 403 token expired → `/logout` 204 → other device `session_not_found`). Fixed in #13.

Recurrence (same day, 16:33 UTC): a PC tab opened before the #13 deploy was still running the old code; on resume it hit the same 401 path and called `/logout?scope=global`, and the phone's next refresh got `refresh_token_not_found`. The fix was right but never reached that tab. Guard: `/app/config` carries a `build` id (hash of the served app code); on resume (`visibilitychange`, back/forward-cache `pageshow`) the app re-checks it and reloads before any API call goes out if the server has moved on (`beforeRequest` gate in `session.js`, tested in `test-session.ts`). Real-deploy test (2026-10-30) found a gap: an installed desktop app window kept behind other windows is never "hidden", so it never resumed and ran the pre-#17 build for two days (it also kept its token fresh by itself, so no expired-token path either). Fix: also check on window focus, and before any request once the last check is over 5 minutes old.

**INC-2026-10-27 closed (2026-10-30).** Proven on a real deploy (#20, which changed the page code): the PC desktop window's focus check ran at 12:29:47.801 UTC, the page reloaded 40 ms later and the new code loaded, with zero requests from the old code in between and no sign-out of any scope since. Root cause fixed in #13; stale clients can no longer outlive a deploy in a tab (#16) or an always-visible desktop window (#18).

### Decisions recorded at Lock

- **Takeover timing stays at 5s heartbeat / 30s dead-after** (~40s end-to-end, about six missed heartbeats before a reap). Prefer slower recovery over false reaps from Postgres, network or event-loop hiccups. Make it configurable per workload only when a latency-sensitive workload exists.
- **First real workflow: Calendar Prep / Agent Ops.** V1 is low-risk: a scheduled evening run reads tomorrow's calendar, picks what's worth preparing for, writes a concise brief, optionally proposes ACTIONS, and anything needing Rone shows in the phone Attention Queue. Nothing sends or writes without approval. Later actions: draft follow-up, create reminder, create Agent Ops calendar item, prepare meeting context. It exercises the whole path: scheduled occurrence → real connection → reasoning → STATE → ACTIONS → approval → mobile Attention Queue → deterministic execution.
- **#1a is mobile-first at the action layer.** The phone is the primary check-and-act surface, an ops inbox rather than a dashboard: Attention Queue first; approve/reject; retry/run-now; pause/disable; auth/reauth prompts; quick health; drill into a failed run far enough to understand it. Deep debugging, logs, schema work and deploy ops stay desktop-first. This points toward a responsive custom frontend, not an admin tool as the permanent experience.

```
Needs You · 3

Calendar Prep        2 proposed actions
Gmail                Reauthorization needed
Morning Agent        Recovered after crash
```

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
- **F10. The Supabase session pooler's connection budget is a real constraint.** DBOS defaults (a 10-connection pool, a listener, and a 10-connection `DBOSClient`) plus our pool came to ~26 connections per worker, ~52 during an overlapping deploy, against a pooler that typically allows ~15 on a small instance. Pools are now env-tuned to ~7 per worker on Railway (`DBOS_POOL_SIZE=3`, `DBOS_CLIENT_POOL_SIZE=1`, `OPS_POOL_SIZE=2`); the deployed fake provider uses none.
- **F11. Never start the worker through `npm start` on Railway.** Railway sent SIGTERM; npm exited (`npm error signal SIGTERM`) and the node process never ran its drain handler. Start the process directly (`node --import tsx src/main.ts`) so it receives the signal.
- **F12. A variable change redeploys the branch head, not the pinned commit.** Railway built the latest commit on the branch when a variable changed, despite the service being pinned to an older SHA. Pin by keeping the branch where you want it, or re-pin after variable changes.
- **F13. A Supabase password reset takes a moment to reach the pooler.** The first boot after the reset still failed auth and the restart a second later succeeded.

## Production validation (2026-10-26, Railway us-east4 + Supabase link-hoarder session pooler + Claude Sonnet 5)

Runbook and Railway layout: [`railway-validation.md`](railway-validation.md). Evidence: the `[validate] {...}` lines in the Railway `validator` service logs, plus direct queries on the Supabase project.

| Check | Result | Evidence |
|---|---|---|
| Supabase session pooler | **PASS** | Worker booted on `aws-0-us-east-1.pooler.supabase.com:5432`; LISTEN/NOTIFY probe passed; DBOS migrations + `ops` schema applied; schedule registered. Pools sized to ~7 connections per worker (see F10). |
| Real model + MCP tool loop | **PASS** | Smoke: Claude Sonnet 5 called MCP `lookup_contact`, `read_state`, 3× `propose_action`, `write_state`; 14 checkpointed steps, 9s. Approve 2 / reject 1 → 2 executor effects, provider 2 attempts → 2 effects. Health `idle` → `healthy`. |
| Hard crash mid-loop, Railway restart | **PASS WITH ADAPTER** | `/admin/crash` after the first model call + 2 tool calls. Railway restarted in ~2s as a **new executor**; it reaped the old one and finished the run 41.5s after the crash (30s dead-after + sweep). Completed steps replayed with identical tool-call IDs; no repeated model call; 3 actions, 0 duplicates. |
| Overlapping redeploy, old code → patched code (t4d on Railway) | **PASS WITH ADAPTER** | 4-minute watch: 16 agent runs and 32 approved executors, all succeeded; provider 34 attempts → 34 effects. Mid-watch deploy of `SPIKE_CODE_VARIANT=2` with a 15s overlap: the old executor was reaped by the new one, which resumed its in-flight workflows. Executor workflows that had checkpointed `callProvider` under old code finished on the patched process with the **old step sequence** (no patch marker); one that hadn't reached the patch point took the new branch. Attention queue empty. |
| SIGTERM drain on Railway | **FAIL → fixed** | See F11: the start command was `npm start`, and npm died on SIGTERM without running the worker's drain handler. The heartbeat takeover covered everything, so no work was lost, but pattern B was not running. Start command is now `node --import tsx src/main.ts`; on the next redeploy the drain handler ran (`SIGTERM: draining` → `drained, exiting`) and the executor recorded `stopped_at` within ~1s of Railway's SIGTERM (idle; nothing in flight). With in-flight work the drain waits for it (t3b locally). |

**Drain sizing:** an idle worker shuts down in ~1s; a reasoning run takes ~9s and an executor ~2s. A drain of `DRAIN_TIMEOUT_MS=20000` with Railway `drainingSeconds=25` covers a full agent run with margin; anything longer is caught by heartbeat takeover (~40s).

Not covered on the real environment: a transient model failure (only the scripted model's 529/401 paths, t5); fencing of a reaped-but-alive executor.

## Housekeeping

- **Spike infrastructure torn down (2026-10-26).** Railway `validator` and `externals` are deleted; the worker's crash endpoint is off (`ENABLE_CHAOS=0`) and test hooks are reset. The `spike-agent` config row is kept but disabled and its DBOS schedule paused. Test rows are cleared from `ops.actions` / `ops.runs` / `ops.state` / `ops.executors`; DBOS's own workflow history from the validation runs remains in `dbos.*`.
- **The superseded `agent_base` schema is dropped** from link-hoarder, after a check showed no dependents, no references, and only its seed rows. Its SQL is archived in `supabase/legacy/`.
- **Still standing:** the Railway `worker` (production skeleton), the `dbos.*` and clean `ops.*` schemas in link-hoarder, the recovery machinery, and the local failure suite + validator as the regression harness.
- **Railway source:** the worker follows branch `claude/new-session-ehc1ld` (its commit pin was dropped by a variable redeploy, F12), so pushes to that branch redeploy it.
