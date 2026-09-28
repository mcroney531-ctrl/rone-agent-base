export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Minimal shared-secret gate for the MVP dashboard — not real auth.
 * Set DASHBOARD_TOKEN in Netlify env and send it as the
 * `x-dashboard-token` header from the frontend. Replace with proper auth
 * (Netlify Identity, Supabase auth, etc.) before this is used by more
 * than one person.
 */
export function requireAuth(req) {
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) return; // no token configured: open (fine for solo local/dev use)
  const got = req.headers.get('x-dashboard-token');
  if (got !== expected) {
    throw json({ error: 'unauthorized' }, 401);
  }
}
