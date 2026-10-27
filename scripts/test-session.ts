// Phone-app session handling (public/session.js): the auth rule "an API 401 never signs out directly".
// Pure Node, no browser: a fake Supabase client + fake API server.
// Usage: npx tsx scripts/test-session.ts
import { AuthError, createSessionApi } from '../public/session.js';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

// Fake Supabase client: holds an access token; refresh takes a moment, then succeeds or fails.
function fakeSupabase(opts: { token: string; refreshOk: boolean }) {
  const s = { token: opts.token, refreshes: 0, signOuts: [] as string[] };
  return {
    state: s,
    auth: {
      getSession: async () => ({ data: { session: s.token ? { access_token: s.token } : null } }),
      refreshSession: async () => {
        s.refreshes++;
        await new Promise((r) => setTimeout(r, 30));
        if (!opts.refreshOk) return { data: { session: null }, error: { message: 'Invalid Refresh Token' } };
        s.token = `fresh-${s.refreshes}`;
        return { data: { session: { access_token: s.token } }, error: null };
      },
      signOut: async (o?: { scope?: string }) => { s.signOuts.push(o?.scope ?? 'global(default!)'); s.token = ''; },
    },
  };
}
// Fake API: only fresh tokens are accepted; '/forbidden' is a real 403.
const fakeFetch = async (path: string, init: { headers: Record<string, string> }) => {
  if (path === '/forbidden') return new Response(JSON.stringify({ error: 'this account is not authorized' }), { status: 403 });
  const ok = /^Bearer fresh-/.test(init.headers.authorization);
  return new Response(JSON.stringify(ok ? { ok: true } : { error: 'session invalid or expired' }), { status: ok ? 200 : 401 });
};

// 1. Resume with an expired token: refresh, retry, carry on.
{
  const sb = fakeSupabase({ token: 'expired', refreshOk: true });
  const { api } = createSessionApi({ sb, fetchImpl: fakeFetch as never });
  const r = await api('/attention');
  check('expired token on resume → one refresh, request succeeds, no sign-out', r.status === 200 && sb.state.refreshes === 1 && sb.state.signOuts.length === 0, sb.state);
}

// 2. Resume after a long freeze: the first screen fires a burst of requests at once.
{
  const sb = fakeSupabase({ token: 'expired', refreshOk: true });
  const { api } = createSessionApi({ sb, fetchImpl: fakeFetch as never });
  const rs = await Promise.all(['/attention', '/agents', '/briefs', '/push/devices', '/attention', '/health'].map((p) => api(p)));
  check('burst of 6 requests with an expired token → exactly ONE refresh, all succeed, no sign-out',
    rs.every((r) => r.status === 200) && sb.state.refreshes === 1 && sb.state.signOuts.length === 0, sb.state);
  const later = await api('/attention');
  check('…and later calls use the refreshed session without refreshing again', later.status === 200 && sb.state.refreshes === 1, sb.state);
}

// 3. Session genuinely gone (refresh token revoked): one LOCAL sign-out, never global, no cascade.
{
  const sb = fakeSupabase({ token: 'expired', refreshOk: false });
  const { api } = createSessionApi({ sb, fetchImpl: fakeFetch as never });
  const outcomes = await Promise.allSettled([api('/attention'), api('/agents'), api('/briefs'), api('/health')]);
  check('dead session → every call ends in AuthError (sign in again)', outcomes.every((o) => o.status === 'rejected' && o.reason instanceof AuthError), outcomes);
  check('…after ONE refresh attempt and ONE sign-out', sb.state.refreshes === 1 && sb.state.signOuts.length === 1, sb.state);
  check('…and that sign-out is local (this device only), never global', JSON.stringify(sb.state.signOuts) === '["local"]', sb.state.signOuts);
}

// 4. A 403 is a real "no" (wrong account): no refresh, no sign-out.
{
  const sb = fakeSupabase({ token: 'fresh-0', refreshOk: true });
  const { api } = createSessionApi({ sb, fetchImpl: fakeFetch as never });
  const r = await api('/forbidden').then(() => null, (e) => e);
  check('403 → AuthError with the reason; no refresh, no sign-out', r instanceof AuthError && /not authorized/.test(r.message)
    && sb.state.refreshes === 0 && sb.state.signOuts.length === 0, { r: String(r), state: sb.state });
}

// 5. The user's own Sign out is local too.
{
  const sb = fakeSupabase({ token: 'fresh-0', refreshOk: true });
  const { signOutHere } = createSessionApi({ sb, fetchImpl: fakeFetch as never });
  await Promise.all([signOutHere(), signOutHere()]);
  check('Sign out (even double-tapped) → one local sign-out', JSON.stringify(sb.state.signOuts) === '["local"]', sb.state.signOuts);
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall session checks passed');
process.exit(failures.length ? 1 : 0);
