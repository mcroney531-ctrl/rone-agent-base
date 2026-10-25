# Durable workflows, in this codebase

A guide to the one idea everything here rests on, using the spike's own code and test results as examples. Read it before changing anything in `src/workflows.ts`.

## Where DBOS's storage shape may be known

Only `sql/002_views.sql` (`ops.dbos_workflows()` → `ops.v_runs`) reads `dbos.*` tables. Application code uses DBOS's public API (`DBOS.*`, `DBOSClient`); health and dashboards read `ops.v_runs`. Don't add a second place that queries `dbos.*`.

## The model: replay, not resume

A DBOS **workflow** is an ordinary async function. A **step** is a call wrapped in `DBOS.runStep(...)`, or a model or tool call wrapped by `durableCalls` / `durableTools` / `durableMCPTools`.

When a step returns, DBOS writes its output to Postgres (`dbos.operation_outputs`) under the workflow ID and the step's **position**: 0, 1, 2, and so on.

When a process dies and the workflow is recovered, DBOS doesn't magically continue from the middle of a function. It **runs the workflow function again from the top**. At each step position:

- **The step's output is already recorded:** DBOS returns the saved output and does *not* run the step.
- **The step's output isn't recorded yet:** it actually runs, which is the first new work.

That's the whole trick. Here are the 16 positions recorded for one real scheduled agent run in this spike:

| pos | step | what it is |
|---|---|---|
| 0 | `recordRunStart` | our run ledger row |
| 1 | `loadAgent` | config row + connection status |
| 2 | `mcp.listTools` | MCP tool listing (durableMCPTools) |
| 3 | `mock…generate` | model call, turn 0 (durableCalls) |
| 4 | `mcp.tool.lookup_contact.t0-a` | MCP tool call |
| 5 | `…generate` | model call, turn 1 |
| 6 | `read_state.t1-a` | our tool |
| 7 | `…generate` | model call, turn 2 |
| 8–10 | `propose_action.t2-a/b/c` | three parallel tool calls |
| 11 | `…generate` | model call, turn 3 |
| 12 | `write_state.t3-a` | our tool |
| 13 | `…generate` | model call, turn 4 (final text) |
| 14 | `countProposed` | |
| 15 | `recordRunEnd` | |

In test **t1** the process was SIGKILLed while position 7 (the turn-2 model call) was in flight. On restart, positions 0–6 replayed from Postgres: the turn-0 and turn-1 model calls were *not* paid for again. Position 7 ran again because it was never checkpointed, and the run finished normally with exactly three actions.

## Rule 1: anything that touches the outside world goes in a step

"The outside world" means the database, HTTP, the clock, randomness, environment, and files. If it's not in a step, it re-executes on every replay *and can give a different answer each time*.

```ts
// WRONG: runs again on replay, and may differ
const agent = (await pool.query('select … from ops.agents …')).rows[0];

// RIGHT: recorded once, replayed thereafter
const agent = await DBOS.runStep(() => loadAgent(agentId), { name: 'loadAgent' });
```

Inside a workflow body, use `DBOS.now()` and `DBOS.randomUUID()` instead of `Date.now()` and `crypto.randomUUID()`.

## Rule 2: code *between* steps must make the same decisions every time

Branching is fine as long as it branches on things that are themselves replayed: step outputs and workflow inputs.

```ts
const agent = await DBOS.runStep(() => loadAgent(agentId), { name: 'loadAgent' });
if (agent.blocked_connections.length) throw …   // fine: `agent` is a recorded value
```

The bad version branches on something live: a fresh DB read, the time of day, a feature flag read from env. On replay it can take a different path, and then the step at position N is not the step that was recorded at position N.

## Rule 3: steps are at-least-once, so make them idempotent

There's a gap between "the step did its thing" and "DBOS wrote the checkpoint". A crash in that gap means the step runs again on recovery. No framework can close this gap. **t2** measured it directly: the executor was killed right after the fake provider accepted the request. On recovery the provider saw the same request again:

> 4 request attempts → 2 committed effects (2 deduplicated by provider)

Two things made that safe, and every step with a side effect needs one of them:

- **Our own writes:** a unique key with `ON CONFLICT` (`ops.actions.idempotency_key`, `ops.runs.workflow_id`, upserts on `ops.state`).
- **External calls:** the provider's own idempotency key (`Idempotency-Key` header = the action's idempotency key). When a provider doesn't support one, record "about to call" first, and check the provider before re-calling on replay.

## Rule 4: step position is identity, so changing step order needs `DBOS.patch()`

Because replay matches steps by position, inserting, removing, or reordering a step changes what "position 2" means for workflows that are already mid-flight.

**t4b** shows the failure. A deploy inserted `auditBeforeCall` before `callProvider`. A workflow that had already recorded `callProvider` at position 2 was replayed on the new code, and DBOS stopped it:

> DBOS error 26: expected `auditBeforeCall` at step 2, found `callProvider`

That's a loud failure, not a silent wrong action, and it shows up in the attention queue as `action_stuck` plus `run_failed: unclassified_workflow_error`. **t4a** shows the fix:

```ts
if (await DBOS.patch('audit-before-call')) {
  await DBOS.runStep(async () => …, { name: 'auditBeforeCall' });
}
```

`DBOS.patch()` returns `false` for executions that already passed this point under old code, so they keep their old sequence, and `true` for everything else. Once no old executions remain, change `patch` → `deprecatePatch`, and later remove it.

**This rule is absolute: any change to a workflow's step structure (insert, remove, reorder, rename a step, or change how many times a loop calls steps) ships behind a `DBOS.patch()` marker.** The default versioning mode keeps one constant DBOS version so new processes can recover old work (t4d: old code drained, new patched code took over and resumed the old branch). That only works because of this rule.

What does *not* need a patch: changing what happens *inside* a step, or changing prompts or instructions. When unsure, patch.

## Rule 5: never hold a workflow open across a human

Approvals take minutes to days. A workflow waiting that long is exposed to every deploy and code change in between. So the reasoning workflow writes `ops.actions` rows and **ends**. Approval is a separate HTTP request that starts a new, short executor workflow. In this codebase both workflows live seconds.

## Workflow IDs are how duplicates die

Starting a workflow with an ID that already exists returns the existing one; it doesn't start a second. Every entry point picks a deterministic ID:

| entry point | workflow ID |
|---|---|
| schedule | `sched-agent-<id>-<scheduled time ISO>` (DBOS derives it) |
| manual "run now" | `manual-<agent>-<requestId>` |
| webhook | `webhook-<agent>-<eventId>` |
| action executor | the action's idempotency key: `<agent>:<action>:<target>:<source workflow>` |

**t3** ran two containers' schedulers at once for several seconds: 9 occurrences, 9 runs, none doubled. In **t2**, a second enqueue under an executor's ID returned the existing workflow.

## The agent half

`@dbos-inc/vercel-ai` applies all of the above to the AI SDK for you:

- `durableCalls` makes each model call a step.
- `durableTools` makes each tool call a step.
- `durableMCPTools` makes the MCP listing and each MCP call steps.

Three consequences:

- Tool `execute` functions are steps, so they're **at-least-once**. `propose_action` is safe to repeat because of the idempotency key.
- Parallel tool calls must be dispatched in a stable order. Don't `await` I/O in `onToolExecutionStart` or similar pre-execution callbacks.
- Changing the agent's tool set or loop shape changes step positions for in-flight runs. Agent runs are short, so drain (SIGTERM) usually covers this, but the patch rule still applies.

## Checklist before merging a change to `src/workflows.ts`

- [ ] No DB, HTTP, clock, random, or env reads in workflow bodies outside steps
- [ ] Every new step with a side effect is idempotent (unique key or provider key)
- [ ] Step order/set changed? Guarded with `DBOS.patch('<name>')`
- [ ] No workflow waits on a human
- [ ] New entry point? Deterministic workflow ID
