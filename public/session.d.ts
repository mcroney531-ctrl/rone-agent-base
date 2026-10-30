// Types for public/session.js (plain browser JS, also imported by the Node test).
export class AuthError extends Error {}
export class OutdatedError extends Error {}
export function createSessionApi(o: {
  sb: unknown;
  fetchImpl?: (...a: any[]) => Promise<Response>;
  onSession?: (s: unknown) => void;
  reuseMs?: number;
  beforeRequest?: () => Promise<unknown>;
  clientCompat?: number;
  onOutdated?: () => Promise<unknown>;
}): {
  api: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
  signOutHere: () => Promise<void>;
};
