import { supabase } from '../../../src/lib/supabase.js';
import { executeAction } from '../../../src/actions.js';
import { json, requireAuth } from './_shared.js';

export default async (req) => {
  try {
    requireAuth(req);
  } catch (res) {
    return res;
  }

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('actions')
      .select('id, run_id, agent_id, action_type, target, payload, risk_level, status, execution_result, created_at, agents(name)')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return json({ error: error.message }, 500);
    return json({ actions: data });
  }

  if (req.method === 'POST') {
    const body = await req.json();
    const { actionId, decision } = body;
    if (!actionId || !['approve', 'reject'].includes(decision)) {
      return json({ error: 'body must be { actionId, decision: "approve" | "reject" }' }, 400);
    }

    const { data: action, error: fetchError } = await supabase.from('actions').select().eq('id', actionId).single();
    if (fetchError) return json({ error: fetchError.message }, 404);
    if (action.status !== 'pending_approval') {
      return json({ error: `action is already ${action.status}, not pending_approval` }, 409);
    }

    if (decision === 'reject') {
      const { data, error } = await supabase
        .from('actions')
        .update({ status: 'rejected', approved_by: 'dashboard', approved_at: new Date().toISOString() })
        .eq('id', actionId)
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ action: data });
    }

    // approve -> approved -> execute immediately, same path as approval_policy "auto"
    const { error: approveError } = await supabase
      .from('actions')
      .update({ status: 'approved', approved_by: 'dashboard', approved_at: new Date().toISOString() })
      .eq('id', actionId);
    if (approveError) return json({ error: approveError.message }, 500);

    const executed = await executeAction(action, { supabase, agentId: action.agent_id, runId: action.run_id });
    return json({ action: executed });
  }

  return json({ error: 'method not allowed' }, 405);
};

