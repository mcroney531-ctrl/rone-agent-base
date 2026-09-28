import { supabase } from '../../../src/lib/supabase.js';
import { json, requireAuth } from './_shared.js';

export default async (req) => {
  try {
    requireAuth(req);
  } catch (res) {
    return res;
  }

  const { data, error } = await supabase
    .from('runs')
    .select('id, agent_id, status, output, tokens_input, tokens_output, cost_usd, error, started_at, finished_at, created_at, agents(name)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return json({ error: error.message }, 500);
  return json({ runs: data });
};

