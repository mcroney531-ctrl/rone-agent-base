import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

// Service-role client, server-side only. db.schema scopes every query to
// agent_base so callers never have to repeat the schema name.
export const supabase = createClient(url, serviceRoleKey, {
  db: { schema: 'agent_base' },
  auth: { persistSession: false },
});
