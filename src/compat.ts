// Client/API compatibility contract (H4). The phone app is served by this worker, but a tab or installed
// window keeps running the code it loaded until it reloads. The stale-tab guard (`build` in /app/config)
// reloads it at the next check; this contract covers the gap before that check, when an old client's
// request reaches a server whose API it no longer matches.
//
//   - The app bakes CLIENT_COMPAT into its code and sends it on every call as `x-client-compat`.
//   - The server refuses calls from a client below MIN_CLIENT_COMPAT with 426 {error: 'client_outdated'};
//     the app reloads (once) instead of acting on a shape it no longer understands.
//   - Calls without the header (API token, scripts) are not phone-app calls and are not checked.
//
// Bump CLIENT_COMPAT in public/app.html AND MIN_CLIENT_COMPAT here, in the same PR, only for a breaking
// change: a field the app reads is removed or renamed or changes meaning, or an action/route changes
// semantics. Additive changes (new item types, new actions, new optional fields) need no bump: the app
// must tolerate what it doesn't know (see the tolerant-reader notes in public/app.html).
import { z } from 'zod';
import type { ActResult, AttentionItem } from './attention.js';

export const MIN_CLIENT_COMPAT = 1;
export const CLIENT_COMPAT_HEADER = 'x-client-compat';

/** 426 body for a phone-app call from a client too old for this server, else null. */
export function outdatedClient(header: string | string[] | undefined): { error: 'client_outdated'; minCompat: number; message: string } | null {
  if (header === undefined) return null;
  const n = Number(Array.isArray(header) ? header[0] : header);
  if (Number.isInteger(n) && n >= MIN_CLIENT_COMPAT) return null;
  return { error: 'client_outdated', minCompat: MIN_CLIENT_COMPAT, message: 'This app is out of date. Reloading.' };
}

/** The compat level baked into the served app. Boot refuses a server that would reject its own fresh page. */
export function assertServedClientCompatible(appHtml: string): number {
  const m = /const CLIENT_COMPAT = (\d+);/.exec(appHtml);
  if (!m) throw new Error('public/app.html must declare `const CLIENT_COMPAT = <n>;`');
  const n = Number(m[1]);
  if (n < MIN_CLIENT_COMPAT) throw new Error(`public/app.html CLIENT_COMPAT ${n} < MIN_CLIENT_COMPAT ${MIN_CLIENT_COMPAT}: a fresh page would reload forever`);
  return n;
}

// ---------- the shapes the app depends on ----------
// Objects are deliberately not strict: adding fields is compatible, removing or renaming one is not.
// Tests parse every /attention response through these, for every producer.
const ItemAction = z.object({
  id: z.string(), label: z.string(), style: z.enum(['primary', 'danger']).optional(),
  choices: z.array(z.object({ id: z.string(), label: z.string(), input: z.enum(['date']).optional() })).optional(), // additive
});

export const AttentionItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  ref: z.string(),
  source: z.string(),
  agent: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  severity: z.enum(['decision', 'problem', 'info']),
  createdAt: z.string(),
  actions: z.array(ItemAction),
});

export const AttentionDetailSchema = z.object({
  item: AttentionItemSchema,
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});

export const ActResultSchema = z.object({ ok: z.boolean(), status: z.number(), message: z.string(), redirect: z.string().optional() });

// Compile-time: what the server produces must satisfy what the app is promised.
type Satisfies<T, S extends z.ZodType> = T extends z.infer<S> ? true : never;
export const _contract: [Satisfies<AttentionItem, typeof AttentionItemSchema>, Satisfies<ActResult, typeof ActResultSchema>] = [true, true];
