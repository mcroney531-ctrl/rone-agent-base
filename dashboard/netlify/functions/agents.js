import { supabase } from '../../../src/lib/supabase.js';
import { json, requireAuth } from './_shared.js';

export default async (req) => {
  try {
    requireAuth(req);
  } catch (res) {
    return res;
  }

  const { data, error } = await supabase
    .from('agents')
    .select('id, name, description, enabled, schedule, last_run_at, next_run_at')
    .order('name');

  if (error) return json({ error: error.message }, 500);
  return json({ agents: data });
};

