import parser from 'cron-parser';

/**
 * Next fire time strictly after `fromDate` for a cron expression.
 */
export function nextRunAfter(schedule, fromDate = new Date()) {
  const interval = parser.parseExpression(schedule, { currentDate: fromDate });
  return interval.next().toDate();
}

/**
 * An agent is due when it has no next_run_at yet (never scheduled) or
 * next_run_at has already passed as of `now`.
 */
export function isDue(agent, now = new Date()) {
  if (!agent.next_run_at) return true;
  return new Date(agent.next_run_at).getTime() <= now.getTime();
}
