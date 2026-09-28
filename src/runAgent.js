import { anthropic, estimateCostUsd } from './lib/anthropic.js';
import { supabase } from './lib/supabase.js';
import { loadToolDefs, TOOL_HANDLERS } from './tools/registry.js';
import { proposeAndMaybeExecute } from './actions.js';

const MAX_ITERATIONS = Number(process.env.MAX_TOOL_ITERATIONS ?? 6);

const DEFAULT_RISK_BY_PERMISSION = { write: 'low', send: 'high' };

function toAnthropicTools(toolDefs) {
  return toolDefs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Runs one agent's reasoning/execution cycle end to end: loads its config
 * and allowed tools, drives the Anthropic tool-use loop, and routes every
 * side-effecting tool call through the ACTIONS layer (propose -> approval
 * policy -> execute) instead of calling it directly. Read-only tools
 * execute inline and their result goes straight back to the model.
 *
 * Persists the full lifecycle to the `runs` row: running -> succeeded/failed.
 */
export async function runAgent({ agent, run }) {
  const toolDefs = await loadToolDefs(agent.allowed_tools);
  const toolDefsByName = Object.fromEntries(toolDefs.map((t) => [t.name, t]));
  const anthropicTools = toAnthropicTools(toolDefs);

  const messages = [
    { role: 'user', content: run.input?.prompt ?? 'Run your scheduled task.' },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalText = '';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: agent.model,
      max_tokens: 1024,
      system: agent.system_prompt,
      messages,
      tools: anthropicTools.length ? anthropicTools : undefined,
    });

    totalInputTokens += response.usage?.input_tokens ?? 0;
    totalOutputTokens += response.usage?.output_tokens ?? 0;

    const textBlocks = response.content.filter((b) => b.type === 'text');
    finalText = textBlocks.map((b) => b.text).join('\n') || finalText;

    if (response.stop_reason !== 'tool_use') {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      const toolDef = toolDefsByName[block.name];

      if (!toolDef || !agent.allowed_tools.includes(block.name)) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `tool "${block.name}" is not permitted for this agent`,
          is_error: true,
        });
        continue;
      }

      try {
        if (toolDef.permission_level === 'read') {
          const handler = TOOL_HANDLERS[block.name];
          if (!handler) throw new Error(`no handler registered for read tool "${block.name}"`);
          const result = await handler({ supabase, agentId: agent.id, runId: run.id }, block.input);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        } else {
          const target = block.input?.target ?? block.input?.key ?? 'default';
          const idempotencyKey = `${agent.id}:${block.name}:${target}:${run.id}`;
          const { summary } = await proposeAndMaybeExecute({
            runId: run.id,
            agent,
            actionType: block.name,
            target: String(target),
            payload: block.input,
            riskLevel: DEFAULT_RISK_BY_PERMISSION[toolDef.permission_level] ?? 'medium',
            idempotencyKey,
          });
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: summary });
        }
      } catch (err) {
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return {
    outputText: finalText,
    tokensInput: totalInputTokens,
    tokensOutput: totalOutputTokens,
    costUsd: estimateCostUsd(agent.model, totalInputTokens, totalOutputTokens),
  };
}
