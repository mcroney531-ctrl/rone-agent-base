# Production validation runbook (Railway + Supabase + real model)

Railway project **rone-agent-base**, environment `production`, three services, all deployed from this repo:

| service | start | role |
|---|---|---|
| `worker` | `npm start` | the spike. Healthcheck `/livez`, restart on failure, `drainingSeconds` 25, `overlapSeconds` 15 |
| `externals` | `npm run externals` | fake idempotent provider + test MCP server, private network only |
| `validator` | `node --import tsx scripts/railway-validate.ts` | runs one phase on the private network, logs `[validate] {...}`, then idles. Never restarts |

## Secrets (set by Rone in the Railway dashboard, never through Claude)

| where | variable | value |
|---|---|---|
| shared | `DATABASE_URL` | Supabase **Session pooler** URI from link-hoarder → Connect (not direct, not transaction) |
| shared | `API_TOKEN` | any long random string |
| `worker` | `ANTHROPIC_API_KEY` | an Anthropic API key |

Everything else is already set: services reference `${{shared.DATABASE_URL}}` and `${{shared.API_TOKEN}}`.

## Phases

The validator's result is the single `[validate] {...}` line in its deploy log.

1. **smoke** (`VALIDATE_PHASE=smoke`). Checks:
   - Supabase boot: the LISTEN/NOTIFY probe passes, and DBOS migrations plus the ops schema apply
   - a manual run with the real model and the MCP tool loop
   - proposals, approve all but one, executor effects
   - provider stats

   The 10-minute schedule (`SPIKE_SCHEDULE`) also fires on its own; check the worker log for a `sched-agent-spike-agent-…` run.
2. **crash** (`VALIDATE_PHASE=crash`). Triggers a run and waits for its first checkpointed model call. Then it calls `POST /admin/crash`, which SIGKILLs the worker; Railway restarts it as a **new process with a new executor ID**. Pass means the new process reaps the old executor and finishes the run, with no duplicate actions. The `executors` field shows the Railway deployment/replica metadata of both processes.
3. **watch + overlapping redeploy, the t4d case on real Railway**:
   1. Set worker `HANG_IN_MARK_EXECUTED_MS=40000` and `DRAIN_TIMEOUT_MS=5000`, so executor work outlives the drain.
   2. Deploy the validator with `VALIDATE_PHASE=watch` and `WATCH_SECONDS=300`.
   3. About 60s in, set worker `SPIKE_CODE_VARIANT=2` (the patched code). This creates a new deployment; for 15s old and new overlap, then old gets SIGTERM.
   4. Pass: every watched run and approved action ends terminal and succeeded, the old deployment's PENDING work is reaped by the new process, and old-code executor workflows show no `DBOS.patch-audit-before-call` step while new ones do.
4. **Measure shutdowns.** From the worker logs, take `SIGTERM: draining` → `drained, exiting` times across these deploys and set `drainingSeconds` / `DRAIN_TIMEOUT_MS` from them.

## After

- Set `ENABLE_CHAOS=0`, remove `HANG_IN_MARK_EXECUTED_MS`, and remove or stop the `validator` and `externals` services.
- Record the results in `docs/closeout.md` → board status.
