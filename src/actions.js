import { supabase } from './lib/supabase.js';
import { TOOL_HANDLERS } from './tools/registry.js';

/**
 * Insert a proposed action. Idempotent by design: a unique-constraint
 * violation on idempotency_key means this exact action was already
 * proposed (retry, duplicate trigger, etc.) — return the existing row
 * instead of creating a duplicate.
 */
export async function proposeAction({ runId, agentId, actionType, target, payload, riskLevel, idempotencyKey }) {
  const { data, error } = await supabase
    .from('actions')
    .insert({
      run_id: runId,
      agent_id: agentId,
      action_type: actionType,
      target,
      payload,
      risk_level: riskLevel ?? 'medium',
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();

  if (!error) return data;

  // 23505 = unique_violation (Postgres)
  if (error.code === '23505') {
    const { data: existing, error: fetchError } = await supabase
      .from('actions')
      .select()
      .eq('idempotency_key', idempotencyKey)
      .single();
    if (fetchError) throw new Error(`idempotency conflict but failed to fetch existing action: ${fetchError.message}`);
    return existing;
  }

  throw new Error(`failed to propose action: ${error.message}`);
}

/**
 * Decide whether an action should auto-execute under an agent's approval
 * policy. Policy shapes:
 *   {"mode": "auto"}
 *   {"mode": "pending_approval"}
 *   {"mode": "risk_threshold", "auto_below": "low" | "medium" | "high"}
 */
const RISK_RANK = { low: 0, medium: 1, high: 2 };

export function shouldAutoExecute(approvalPolicy, action) {
  const mode = approvalPolicy?.mode ?? 'pending_approval';
  if (mode === 'auto') return true;
  if (mode === 'pending_approval') return false;
  if (mode === 'risk_threshold') {
    const ceiling = RISK_RANK[approvalPolicy.auto_below] ?? -1;
    return RISK_RANK[action.risk_level] <= ceiling;
  }
  return false;
}

/**
 * Execute an approved/auto action via the tool registry and record the
 * result. Only ever called on actions that are already approved or
 * auto-approved — never on pending_approval ones.
 */
export async function executeAction(action, ctx) {
  const handler = TOOL_HANDLERS[action.action_type];
  if (!handler) {
    const { data } = await supabase
      .from('actions')
      .update({ status: 'failed', execution_result: { error: `no handler for ${action.action_type}` } })
      .eq('id', action.id)
      .select()
      .single();
    return data;
  }

  try {
    const result = await handler(ctx, action.payload);
    const { data, error } = await supabase
      .from('actions')
      .update({
        status: 'executed',
        execution_result: result ?? {},
        executed_at: new Date().toISOString(),
      })
      .eq('id', action.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  } catch (err) {
    const { data } = await supabase
      .from('actions')
      .update({ status: 'failed', execution_result: { error: err.message } })
      .eq('id', action.id)
      .select()
      .single();
    return data;
  }
}

/**
 * Propose an action, apply the agent's approval policy, and execute it
 * immediately if the policy allows. Returns the final action row plus a
 * short status summary for the tool_result sent back to the model.
 */
export async function proposeAndMaybeExecute({ runId, agent, actionType, target, payload, riskLevel, idempotencyKey }) {
  const action = await proposeAction({
    runId,
    agentId: agent.id,
    actionType,
    target,
    payload,
    riskLevel,
    idempotencyKey,
  });

  // Already resolved from a prior attempt (idempotent replay) — don't re-run.
  if (action.status !== 'pending_approval') {
    return { action, summary: `action already ${action.status} (idempotency_key=${idempotencyKey})` };
  }

  if (!shouldAutoExecute(agent.approval_policy, action)) {
    return { action, summary: `action ${action.id} proposed, awaiting approval (risk=${action.risk_level})` };
  }

  const { error } = await supabase
    .from('actions')
    .update({ status: 'approved', approved_by: 'approval_policy:auto', approved_at: new Date().toISOString() })
    .eq('id', action.id);
  if (error) throw new Error(`failed to auto-approve action: ${error.message}`);

  const executed = await executeAction(action, { supabase, agentId: agent.id, runId });
  return { action: executed, summary: `action ${executed.id} auto-executed: ${executed.status}` };
}
