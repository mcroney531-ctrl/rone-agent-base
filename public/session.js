// Session handling for the phone app. Hard rule: an API 401 NEVER signs the user out directly.
//
//   API 401 → refresh session (single-flight) → retry once → refresh ok: continue
//                                                          → session really gone: LOCAL sign-out
//
// Access tokens live an hour and phones freeze background pages, so a resumed app often holds an
// expired token, and the first screen fires several requests at once. They must share ONE refresh:
// parallel refreshes of the same session can rotate its refresh token out from under each other.
// Sign-out is always scope 'local'; supabase-js defaults to 'global', which revokes every session
// of the account on every device and in every app sharing the Supabase project.
export class AuthError extends Error {}

export function createSessionApi({ sb, fetchImpl = (...a) => fetch(...a), onSession = () => {}, reuseMs = 10_000 }) {
  let refreshing = null;               // the in-flight forced refresh, shared by every caller
  let lastRefresh = { at: 0, token: '' };
  let signingOut = null;

  async function currentToken() {
    if (!sb) return '';
    const { data } = await sb.auth.getSession(); // refreshes an expired session when necessary
    onSession(data.session);
    return data.session?.access_token ?? '';
  }

  function forcedToken() {
    // A burst of 401s that lands just after a refresh reuses its result instead of refreshing again.
    if (lastRefresh.token && Date.now() - lastRefresh.at < reuseMs) return Promise.resolve(lastRefresh.token);
    refreshing ??= (async () => {
      try {
        const { data, error } = await sb.auth.refreshSession();
        if (error || !data?.session) return '';
        onSession(data.session);
        lastRefresh = { at: Date.now(), token: data.session.access_token };
        return data.session.access_token;
      } catch {
        return '';
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function signOutHere() {
    signingOut ??= (async () => {
      try { await sb?.auth.signOut({ scope: 'local' }); } catch { /* already gone */ }
      onSession(null);
    })().finally(() => { signingOut = null; });
    return signingOut;
  }

  async function api(path, opts = {}) {
    const call = (token) => fetchImpl(path, {
      method: opts.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let res = await call(await currentToken());
    if (res.status === 401) {
      const fresh = sb ? await forcedToken() : '';
      if (fresh) res = await call(fresh);
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) { await signOutHere(); throw new AuthError('Your session ended. Sign in again.'); }
    if (res.status === 403) throw new AuthError(body.error ?? 'Not authorized'); // a real "no", never a sign-out
    return { status: res.status, body };
  }

  return { api, signOutHere };
}
