import { supabase } from './lib/supabase.js';
import { nextRunAfter } from './lib/cron.js';
import { runAgent } from './runAgent.js';

/**
 * Creates a trigger + run row for one agent, drives the tool-use loop, and
 * persists the outcome. Shared by the Railway cron dispatcher (trigger
 * type 'cron') and the dashboard's manual "run now" (trigger type
 * 'manual') so both paths behave identically.
 */
export async function runAgentOnce(agent, { triggerType = 'manual', payload = {} } = {}) {
  if (agent.handler) {
    throw new Error(`agent "${agent.name}" has a custom handler ("${agent.handler}") which is not implemented yet`);
  }

  const now = new Date();

  const { data: trigger, error: triggerError } = await supabase
    .from('triggers')
    .insert({ agent_id: agent.id, type: triggerType, payload })
    .select()
    .single();
  if (triggerError) throw new Error(`failed to create trigger: ${triggerError.message}`);

  const { data: run, error: runError } = await supabase
    .from('runs')
    .insert({ agent_id: agent.id, trigger_id: trigger.id, status: 'running', input: payload, started_at: now.toISOString() })
    .select()
    .single();
  if (runError) throw new Error(`failed to create run: ${runError.message}`);

  try {
    const result = await runAgent({ agent, run });

    const { data: updatedRun } = await supabase
      .from('runs')
      .update({
        status: 'succeeded',
        output: { text: result.outputText },
        tokens_input: result.tokensInput,
        tokens_output: result.tokensOutput,
        cost_usd: result.costUsd,
        finished_at: new Date().toISOString(),
      })
      .eq('id', run.id)
      .select()
      .single();

    if (triggerType === 'cron') {
      await supabase
        .from('agents')
        .update({ last_run_at: now.toISOString(), next_run_at: nextRunAfter(agent.schedule, now).toISOString() })
        .eq('id', agent.id);
    }

    return updatedRun;
  } catch (err) {
    const { data: updatedRun } = await supabase
      .from('runs')
      .update({ status: 'failed', error: err.message, finished_at: new Date().toISOString() })
      .eq('id', run.id)
      .select()
      .single();

    if (triggerType === 'cron') {
      await supabase
        .from('agents')
        .update({ last_run_at: now.toISOString(), next_run_at: nextRunAfter(agent.schedule, now).toISOString() })
        .eq('id', agent.id);
    }

    throw Object.assign(err, { run: updatedRun });
  }
}
