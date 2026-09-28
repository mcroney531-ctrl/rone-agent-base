import { supabase } from '../lib/supabase.js';

/**
 * Tool handlers, keyed by the same `name` used in agent_base.tools.
 *
 * Schemas and descriptions live in the DB (agent_base.tools) — that's the
 * source of truth handed to the Anthropic API. This map only supplies the
 * code that runs when a tool is invoked.
 *
 * permission_level 'read' tools execute immediately and their result goes
 * straight back to the model. permission_level 'write'/'send' tools are
 * side-effecting: the run loop routes them through the ACTIONS layer
 * (propose -> approval policy -> execute) instead of calling the handler
 * inline. See src/actions.js.
 *
 * To add a real integration tool: insert a row into agent_base.tools with
 * its JSON Schema, add a handler here, then add the tool name to an
 * agent's allowed_tools.
 */
export const TOOL_HANDLERS = {
  async 'state.write'(ctx, input) {
    const { agentId } = ctx;
    const { key, value } = input;
    const { error } = await supabase
      .from('state')
      .upsert({ agent_id: agentId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'agent_id,key' });
    if (error) throw new Error(`state.write failed: ${error.message}`);
    return { key, value };
  },
};

/**
 * Loads the enabled, allowed tool definitions for an agent from the DB and
 * shapes them into Anthropic's tool-use format.
 */
export async function loadToolDefs(allowedToolNames) {
  if (!allowedToolNames?.length) return [];
  const { data, error } = await supabase
    .from('tools')
    .select('name, description, input_schema, permission_level')
    .in('name', allowedToolNames)
    .eq('enabled', true);
  if (error) throw new Error(`failed to load tool defs: ${error.message}`);
  return data ?? [];
}
