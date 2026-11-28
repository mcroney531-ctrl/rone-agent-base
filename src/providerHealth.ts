// Model-provider health (Anthropic): ONE signal per outage, from the provider's real answers.
// Anthropic offers no cheap balance endpoint for an ordinary API key, so we don't guess a balance. Instead every
// model call reports its outcome: a credit/billing refusal or a rejected key opens an outage (one row, one Needs
// You item, however many runs and agents hit it); the next successful call closes it. Nothing here buys credits.
//
// Runs as model middleware INSIDE the durable step (see agentModel), so it only sees real provider calls: a
// replayed checkpoint never reaches the provider and so never marks it healthy.
import { APICallError, type LanguageModelMiddleware } from 'ai';
import { pool } from './db.js';

export type ProviderProblem = 'credits_exhausted' | 'auth_failed';
const PROVIDER = 'anthropic';

/** Is this error the provider saying "no credits" or "bad key"? Anything else (overload, 5xx, timeouts) is not an outage of this kind. */
export function providerProblem(err: unknown): ProviderProblem | null {
  let e = err as { lastError?: unknown; errors?: unknown[]; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e && !APICallError.isInstance(e); i++) {
    e = (e.lastError ?? (Array.isArray(e.errors) ? e.errors.at(-1) : undefined) ?? e.cause) as typeof e;
  }
  if (!APICallError.isInstance(e)) return null;
  const msg = `${e.message} ${e.responseBody ?? ''}`;
  if (/credit balance|purchase credits|plans\s*&\s*billing|billing/i.test(msg) && (e.statusCode === 400 || e.statusCode === 402 || e.statusCode === 403)) return 'credits_exhausted';
  if (e.statusCode === 401 || /invalid x-api-key|authentication_error|invalid api key/i.test(msg)) return 'auth_failed';
  return null;
}

export async function recordProviderFailure(kind: ProviderProblem, message: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(
      `update ops.provider_status set state = $2, since = case when state = $2 then since else now() end,
              failures = case when state = $2 then failures + 1 else 1 end, last_failure_at = now(), last_error = $3, updated_at = now()
        where provider = $1`, [PROVIDER, kind, message.slice(0, 300)]);
    // One open outage per provider; a change of kind (credits → key) closes the old window and opens a new one.
    await c.query(`update ops.provider_outages set ended_at = now() where provider = $1 and ended_at is null and kind <> $2`, [PROVIDER, kind]);
    await c.query(
      `insert into ops.provider_outages (provider, kind, failures) values ($1, $2, 1)
       on conflict (provider) where ended_at is null do update set failures = ops.provider_outages.failures + 1`, [PROVIDER, kind]);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** A successful call proves service is back: close any outage (cheap no-op while healthy). */
export async function recordProviderOk(): Promise<void> {
  const { rowCount } = await pool.query(
    `update ops.provider_status set state = 'ok', since = null, failures = 0, last_ok_at = now(), updated_at = now()
      where provider = $1 and state <> 'ok'`, [PROVIDER]);
  if (rowCount) await pool.query(`update ops.provider_outages set ended_at = now() where provider = $1 and ended_at is null`, [PROVIDER]);
}

// Health bookkeeping must never break or slow a model call: errors are logged and swallowed.
const quietly = (p: Promise<unknown>) => p.catch((e) => console.warn(`[provider-health] ${(e as Error).message}`));

export const providerHealth: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    try {
      const out = await doGenerate();
      await quietly(recordProviderOk());
      return out;
    } catch (err) {
      const kind = providerProblem(err);
      if (kind) await quietly(recordProviderFailure(kind, (err as Error).message ?? String(err)));
      throw err;
    }
  },
};
