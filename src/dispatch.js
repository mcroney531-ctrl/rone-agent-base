import { supabase } from './lib/supabase.js';
import { isDue } from './lib/cron.js';
import { runAgentOnce } from './runOnce.js';

/**
 * Entry point for the Railway cron job (runs once per invocation, exits).
 * Queries which agents are due, runs each one, and reschedules its
 * next_run_at. Railway's own "skip overlapping invocation" setting is the
 * concurrency guard at the scheduler level; the idempotency key on ACTIONS
 * is the guard at the action level (see src/actions.js) — the two are not
 * redundant, they cover different failure modes.
 */
async function dispatch() {
  const now = new Date();
  const { data: agents, error } = await supabase.from('agents').select('*').eq('enabled', true);
  if (error) throw new Error(`failed to load agents: ${error.message}`);

  const due = (agents ?? []).filter((a) => isDue(a, now));
  if (!due.length) {
    console.log(`[dispatch] no agents due at ${now.toISOString()}`);
    return;
  }

  for (const agent of due) {
    console.log(`[dispatch] running agent "${agent.name}" (${agent.id})`);
    try {
      await runAgentOnce(agent, { triggerType: 'cron' });
    } catch (err) {
      console.error(`[dispatch] agent "${agent.name}" failed:`, err.message);
    }
  }
}

dispatch()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[dispatch] fatal:', err);
    process.exit(1);
  });
