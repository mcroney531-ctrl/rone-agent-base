// Model usage / spend log, V1: one row per real provider call (ops.model_calls), costed from ops.model_prices.
// Observation only: nothing here caps, alerts or refuses a call.
//
// Runs as model middleware INSIDE the durable step (see agentModel), like providerHealth: a replayed checkpoint never
// reaches the provider, so it is never logged; every answered attempt (including a retry) was paid for, so it is.
import type { LanguageModelMiddleware } from 'ai';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pool } from './db.js';

export type CallUsage = {
  provider: string; model: string; runId: string | null; stepId: number | null;
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null;
};

const n = (v: number | undefined) => (Number.isFinite(v) ? Math.max(0, Math.round(v as number)) : 0);

/** The provider's usage report → our row. "anthropic.messages" → "anthropic". Uncached input = total − cache reads − cache writes when noCache is missing. */
export function toCallUsage(
  u: { inputTokens: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number }; outputTokens: { total?: number; reasoning?: number } } | undefined,
  provider: string, model: string, runId: string | null, stepId: number | null,
): CallUsage {
  const cacheRead = n(u?.inputTokens.cacheRead);
  const cacheWrite = n(u?.inputTokens.cacheWrite);
  const input = u?.inputTokens.noCache !== undefined ? n(u.inputTokens.noCache) : Math.max(0, n(u?.inputTokens.total) - cacheRead - cacheWrite);
  return {
    provider: provider.split('.')[0], model, runId, stepId,
    input, output: n(u?.outputTokens.total), cacheRead, cacheWrite,
    reasoning: u?.outputTokens.reasoning === undefined ? null : n(u.outputTokens.reasoning),
  };
}

export async function recordModelCall(c: CallUsage): Promise<void> {
  // Price = the newest row in effect for this model; agent = the run's agent (null outside a run).
  await pool.query(
    `insert into ops.model_calls (provider, model, agent_id, run_id, step_id, input_tokens, output_tokens, cache_read_tokens,
                                  cache_write_tokens, reasoning_tokens, price_id, estimated_cost_usd)
     select $1, $2, (select agent_id from ops.runs where workflow_id = $3::text), $3::text, $4::int, $5::int, $6::int, $7::int, $8::int, $9::int, p.id,
            case when p.id is null then null else
              ($5::int * p.input_per_mtok + $6::int * p.output_per_mtok
               + $7::int * p.cache_read_per_mtok + $8::int * p.cache_write_per_mtok) / 1000000 end
       from (select 1) one
       left join lateral (select id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok
                            from ops.model_prices where provider = $1 and model = $2 and effective_from <= now()
                           order by effective_from desc limit 1) p on true`,
    [c.provider, c.model, c.runId, c.stepId, c.input, c.output, c.cacheRead, c.cacheWrite, c.reasoning],
  );
}

export const usageLog: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate, model }) => {
    const out = await doGenerate();
    // Logging must never break or slow a model call: errors are logged and swallowed.
    await recordModelCall(toCallUsage(out.usage, model.provider, out.response?.modelId ?? model.modelId, DBOS.workflowID ?? null, DBOS.stepID ?? null))
      .catch((e) => console.warn(`[usage-log] ${(e as Error).message}`));
    return out;
  },
};
