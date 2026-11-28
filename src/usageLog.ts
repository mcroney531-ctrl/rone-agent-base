// Model usage / spend log: one row per provider call attempt (ops.model_calls), costed from ops.model_prices,
// with latency and outcome. An operational ledger, observation only: nothing here caps, alerts or refuses a call.
//
// Runs as model middleware INSIDE the durable step (see agentModel), like providerHealth: a replayed checkpoint never
// reaches the provider, so it is never logged. Every attempt that reached the provider is logged, failed ones included;
// a failed call has tokens and cost only if the provider reported usage, otherwise NULL (unknown), never a fake zero.
import { APICallError, type LanguageModelMiddleware } from 'ai';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pool } from './db.js';

export type CallOutcome = 'success' | 'provider_error' | 'timeout' | 'cancelled';
export type CallUsage = {
  provider: string; model: string; runId: string | null; stepId: number | null;
  input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null;
  startedAt?: Date; durationMs?: number; outcome?: CallOutcome; attempt?: number | null; requestId?: string | null;
};
type Usage = { inputTokens: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }; outputTokens: { total?: number; reasoning?: number } };

const n = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, Math.round(v as number)) : 0);

/** The provider's usage report → our row. "anthropic.messages" → "anthropic". Uncached input = total − cache reads − cache writes when noCache is missing. No report → token counts NULL. */
export function toCallUsage(u: Usage | undefined, provider: string, model: string, runId: string | null, stepId: number | null): CallUsage {
  const base = { provider: provider.split('.')[0], model, runId, stepId };
  if (!u) return { ...base, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null };
  const cacheRead = n(u.inputTokens.cacheRead);
  const cacheWrite = n(u.inputTokens.cacheWrite);
  const input = u.inputTokens.noCache !== undefined ? n(u.inputTokens.noCache) : Math.max(0, n(u.inputTokens.total) - cacheRead - cacheWrite);
  return {
    ...base, input, output: n(u.outputTokens.total), cacheRead, cacheWrite,
    reasoning: u.outputTokens.reasoning === undefined ? null : n(u.outputTokens.reasoning),
  };
}

/** Why an attempt failed: the durable step's own timeout or a workflow cancel, else the provider (incl. network) failed it. */
export function failureOutcome(err: unknown, status?: { timeoutSignal?: AbortSignal; cancelSignal?: AbortSignal }): CallOutcome {
  if (status?.timeoutSignal?.aborted) return 'timeout';
  if (status?.cancelSignal?.aborted) return 'cancelled';
  const name = (err as { name?: string } | undefined)?.name;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'cancelled';
  return 'provider_error';
}

const requestIdOf = (headers: Record<string, string | undefined> | undefined) => headers?.['request-id'] ?? headers?.['x-request-id'] ?? null;

export async function recordModelCall(c: CallUsage): Promise<void> {
  // Price = the newest row in effect for this model; agent = the run's agent (null outside a run). NULL tokens → NULL cost.
  await pool.query(
    `insert into ops.model_calls (provider, model, agent_id, run_id, step_id, input_tokens, output_tokens, cache_read_tokens,
                                  cache_write_tokens, reasoning_tokens, price_id, estimated_cost_usd,
                                  started_at, duration_ms, outcome, attempt_number, provider_request_id)
     select $1::text, $2::text, (select agent_id from ops.runs where workflow_id = $3::text), $3::text, $4::int, $5::int, $6::int, $7::int, $8::int, $9::int,
            case when $5::int is null then null else p.id end,
            case when p.id is null then null else
              ($5::int * p.input_per_mtok + $6::int * p.output_per_mtok
               + $7::int * p.cache_read_per_mtok + $8::int * p.cache_write_per_mtok) / 1000000 end,
            $10::timestamptz, $11::int, $12::text, $13::int, $14::text
       from (select 1) one
       left join lateral (select id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok
                            from ops.model_prices where provider = $1 and model = $2 and effective_from <= now()
                           order by effective_from desc limit 1) p on true`,
    [c.provider, c.model, c.runId, c.stepId, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning,
      c.startedAt ?? null, c.durationMs ?? null, c.outcome ?? 'success', c.attempt ?? null, c.requestId ?? null],
  );
}

// Logging must never break or slow a model call: errors are logged and swallowed.
const quietly = (p: Promise<unknown>) => p.catch((e) => console.warn(`[usage-log] ${(e as Error).message}`));

export const usageLog: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate, model }) => {
    const startedAt = new Date();
    const t0 = performance.now();
    const status = DBOS.stepStatus as { currentAttempt?: number; timeoutSignal?: AbortSignal; cancelSignal?: AbortSignal } | undefined;
    const ctx = { runId: DBOS.workflowID ?? null, stepId: DBOS.stepID ?? null, attempt: status?.currentAttempt ?? null };
    try {
      const out = await doGenerate();
      await quietly(recordModelCall({
        ...toCallUsage(out.usage, model.provider, out.response?.modelId ?? model.modelId, ctx.runId, ctx.stepId),
        startedAt, durationMs: Math.round(performance.now() - t0), outcome: 'success', attempt: ctx.attempt,
        requestId: requestIdOf(out.response?.headers),
      }));
      return out;
    } catch (err) {
      await quietly(recordModelCall({
        ...toCallUsage(undefined, model.provider, model.modelId, ctx.runId, ctx.stepId),
        startedAt, durationMs: Math.round(performance.now() - t0), outcome: failureOutcome(err, status), attempt: ctx.attempt,
        requestId: APICallError.isInstance(err) ? requestIdOf(err.responseHeaders) : null,
      }));
      throw err;
    }
  },
};
