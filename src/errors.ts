import { APICallError, RetryError } from 'ai';
import { DBOSWorkflowConflictError } from '@dbos-inc/dbos-sdk';

export type ErrorClass = 'provider_auth' | 'provider_unavailable' | 'connection_unavailable' | 'validation' | 'internal';

export class OpsError extends Error {
  constructor(public readonly errorClass: ErrorClass, message: string) {
    super(message);
    this.name = 'OpsError';
  }
}

function unwrap(err: unknown): unknown {
  let e = err as { lastError?: unknown; errors?: unknown[]; cause?: unknown } | undefined;
  for (let i = 0; i < 5 && e; i++) {
    if (RetryError.isInstance(e)) e = e.lastError as typeof e;
    else if (Array.isArray(e.errors) && e.errors.length) e = e.errors[e.errors.length - 1] as typeof e;
    else break;
  }
  return e;
}

// DBOS control flow, not failures: this execution no longer owns its workflow (a peer took it over after
// a reap) or the workflow was cancelled. Rethrow it untouched, before recording anything, so DBOS adopts
// the owner's outcome. Recording it as a failed run would be a lie (found by failure-suite t9 / H1).
// Returns the DBOS error itself, unwrapped from AI SDK retry/tool wrappers.
export function dbosControlError(err: unknown): Error | undefined {
  let e = err as { cause?: unknown; lastError?: unknown; errors?: unknown[] } | undefined;
  for (let i = 0; i < 6 && e; i++) {
    if (e instanceof DBOSWorkflowConflictError || (e as Error).constructor?.name === 'DBOSWorkflowCancelledError') return e as Error;
    e = (e.cause ?? e.lastError ?? (Array.isArray(e.errors) ? e.errors.at(-1) : undefined)) as typeof e;
  }
  return undefined;
}

// Health states come from our classification, never from parsing DBOS's error serialization.
export function classify(err: unknown): { errorClass: ErrorClass; message: string } {
  const e = unwrap(err);
  const message = (e as Error)?.message ?? String(e);
  if (e instanceof OpsError) return { errorClass: e.errorClass, message };
  if (APICallError.isInstance(e)) {
    const s = e.statusCode ?? 0;
    if (s === 401 || s === 403) return { errorClass: 'provider_auth', message };
    if (s === 429 || s >= 500 || e.isRetryable) return { errorClass: 'provider_unavailable', message };
    return { errorClass: 'validation', message };
  }
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return { errorClass: 'provider_unavailable', message };
  }
  if (/fetch failed|socket hang up|timed out/i.test(message)) return { errorClass: 'provider_unavailable', message };
  return { errorClass: 'internal', message };
}
