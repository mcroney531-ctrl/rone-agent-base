import { supabase } from '../../../src/lib/supabase.js';
import { runAgentOnce } from '../../../src/runOnce.js';
import { json, requireAuth } from './_shared.js';

export default async (req) => {
  try {
    requireAuth(req);
  } catch (res) {
    return res;
  }

  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const { agentId } = await req.json();
  if (!agentId) return json({ error: 'body must be { agentId }' }, 400);

  const { data: agent, error } = await supabase.from('agents').select('*').eq('id', agentId).single();
  if (error) return json({ error: error.message }, 404);

  try {
    const run = await runAgentOnce(agent, { triggerType: 'manual' });
    return json({ run });
  } catch (err) {
    return json({ error: err.message, run: err.run ?? null }, 500);
  }
};

