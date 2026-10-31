// Durable workflows. Read docs/durable-workflows.md first if this is new: the short version is that
// a workflow function is REPLAYED after a crash, so everything that touches the outside world
// (DB, network, clock, randomness) must be inside a step, and the code between steps must make the
// same decisions every time it runs.
import fs from 'node:fs';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { durableMCPTools, durableTools } from '@dbos-inc/vercel-ai';
import { z } from 'zod';
import { pool } from './db.js';
import { agentModel } from './model.js';
import { classify, dbosControlError, OpsError } from './errors.js';
import { FAKE_PROVIDER_URL } from './config.js';
import { calendarPrepRun, createAgentOpsHold } from './calendarPrep.js';
import { inboxTriageRun } from './inboxTriage.js';
import { followUpRun } from './followUp.js';
import { addAgentOpsLabel, createDraftReplyOnce } from './connections/gmail.js';

export const EXECUTOR_QUEUE = 'executor';
export const AGENT_QUEUE = 'agent_runs';

// forDate (YYYY-MM-DD): Run Now for a specific local day; only date-scoped handlers read it.
export type Trigger = { type: 'schedule' | 'manual' | 'webhook' | 'calendar'; sourceEvent: string; forDate?: string };

export type AgentRow = {
  id: string;
  model: string;
  timezone: string;
  instructions: string;
  mcp_server_url: string | null;
  approval_policy: { mode: 'auto' | 'pending_approval' | 'risk_threshold'; auto_at_or_below?: 'low' | 'medium' | 'high' };
  handler: string | null;
  settings: { prepHolds?: Partial<import('./slots.js').SlotSettings> } | null;
  blocked_connections: string[];
};

// ---------- strict ACTION schemas: malformed model output is rejected here, never reaches a provider ----------

const email = z.string().email();
export const ProposalSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('crm.note'), target: email, note: z.string().min(1).max(2000) }).strict(),
  z.object({
    action: z.literal('email.draft'), target: email, subject: z.string().min(1).max(200), body: z.string().min(1).max(10_000),
  }).strict(),
  z.object({
    action: z.literal('calendar.hold'), target: email, title: z.string().min(1).max(200),
    start: z.string().datetime(), durationMinutes: z.number().int().min(5).max(480),
  }).strict(),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;

// ---------- steps (each one is checkpointed in dbos.* after it returns) ----------

async function loadAgent(agentId: string): Promise<AgentRow> {
  const { rows } = await pool.query(
    `select a.id, a.model, a.timezone, a.instructions, a.mcp_server_url, a.approval_policy, a.handler, a.settings,
            coalesce(array_agg(c.id) filter (where ac.required and (c.status <> 'active' or not (ac.scopes <@ c.scopes))), '{}') as blocked_connections
       from ops.agents a
       left join ops.agent_connections ac on ac.agent_id = a.id
       left join ops.connections c on c.id = ac.connection_id
      where a.id = $1 and a.enabled
      group by a.id`,
    [agentId],
  );
  if (!rows[0]) throw new OpsError('validation', `agent ${agentId} not found or disabled`);
  return rows[0];
}

export async function recordRunStart(r: { workflowId: string; kind: 'agent_run' | 'executor'; agentId: string; trigger: string; sourceEvent?: string; actionId?: string }) {
  await pool.query(
    `insert into ops.runs (workflow_id, kind, agent_id, trigger_type, source_event, action_id)
     values ($1, $2, $3, $4, $5, $6) on conflict (workflow_id) do nothing`,
    [r.workflowId, r.kind, r.agentId, r.trigger, r.sourceEvent ?? null, r.actionId ?? null],
  );
}

export async function recordRunEnd(workflowId: string, outcome: 'succeeded' | 'failed', extra: { errorClass?: string; errorMessage?: string; actionsProposed?: number }) {
  await pool.query(
    `update ops.runs set finished_at = now(), outcome = $2, error_class = $3, error_message = $4, actions_proposed = $5
      where workflow_id = $1`,
    [workflowId, outcome, extra.errorClass ?? null, extra.errorMessage ?? null, extra.actionsProposed ?? null],
  );
}

// ---------- reasoning workflow: think, propose ACTIONS, end. Never waits for a human (hard rule 1). ----------

async function agentRunBody(agentId: string, trigger: Trigger): Promise<{ text: string; proposed: number }> {
  const workflowId = DBOS.workflowID!;
  await DBOS.runStep(() => recordRunStart({ workflowId, kind: 'agent_run', agentId, trigger: trigger.type, sourceEvent: trigger.sourceEvent }), { name: 'recordRunStart' });

  try {
    const agent = await DBOS.runStep(() => loadAgent(agentId), { name: 'loadAgent' });
    // Branching on a step's checkpointed output is deterministic: on replay, `agent` is the same value.
    if (agent.blocked_connections.length) {
      throw new OpsError('connection_unavailable', `required connection(s) not active or missing access: ${agent.blocked_connections.join(', ')}`);
    }
    // Custom handlers branch on the checkpointed agent row, so a replay takes the same path.
    if (agent.handler === 'calendar_prep') {
      const out = await calendarPrepRun(agent, trigger, workflowId);
      await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', { actionsProposed: out.proposed }), { name: 'recordRunEnd' });
      return out;
    }
    if (agent.handler === 'inbox_triage') {
      const out = await inboxTriageRun(agent, trigger, workflowId);
      await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', { actionsProposed: out.proposed }), { name: 'recordRunEnd' });
      return out;
    }
    if (agent.handler === 'follow_up') {
      const out = await followUpRun(agent, trigger, workflowId);
      await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', { actionsProposed: out.proposed }), { name: 'recordRunEnd' });
      return out;
    }
    if (agent.handler) throw new OpsError('validation', `unknown handler "${agent.handler}"`);

    const ourTools = durableTools({
      read_state: tool({
        description: 'Read one durable STATE fact for this agent',
        inputSchema: z.object({ key: z.string().min(1).max(100) }).strict(),
        execute: async ({ key }) => {
          const { rows } = await pool.query(`select value, updated_at from ops.state where agent_id = $1 and key = $2`, [agentId, key]);
          return rows[0] ?? { value: null };
        },
      }),
      write_state: tool({
        description: 'Write one durable STATE fact for this agent',
        inputSchema: z.object({ key: z.string().min(1).max(100), value: z.record(z.string(), z.unknown()) }).strict(),
        execute: async ({ key, value }) => {
          await pool.query(
            `insert into ops.state (agent_id, key, value, source_workflow_id) values ($1, $2, $3, $4)
             on conflict (agent_id, key) do update set value = excluded.value, source_workflow_id = excluded.source_workflow_id, updated_at = now()`,
            [agentId, key, value, workflowId],
          );
          return { ok: true };
        },
      }),
      propose_action: tool({
        description: 'Propose ONE external action. It is not executed now; it is queued for approval.',
        inputSchema: z.object({ proposal: ProposalSchema }).strict(),
        execute: async ({ proposal }) => proposeAction(agent, workflowId, proposal),
      }),
    });

    const mcpClient = agent.mcp_server_url ? await createMCPClient({ transport: { type: 'http', url: agent.mcp_server_url } }) : undefined;
    try {
      const mcpTools = mcpClient ? await durableMCPTools(mcpClient) : {};
      const runner = new ToolLoopAgent({
        model: agentModel(agent.model),
        instructions: agent.instructions,
        tools: { ...mcpTools, ...ourTools },
        stopWhen: stepCountIs(10),
      });
      const result = await runner.generate({ prompt: `Trigger: ${trigger.type} (${trigger.sourceEvent}). Do your task.` });

      const proposed = await DBOS.runStep(
        async () => (await pool.query(`select count(*)::int n from ops.actions where source_workflow_id = $1`, [workflowId])).rows[0].n as number,
        { name: 'countProposed' },
      );
      await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', { actionsProposed: proposed }), { name: 'recordRunEnd' });
      return { text: result.text, proposed };
    } finally {
      await mcpClient?.close();
    }
  } catch (err) {
    const control = dbosControlError(err);
    if (control) throw control;
    const { errorClass, message } = classify(err);
    await DBOS.runStep(() => recordRunEnd(workflowId, 'failed', { errorClass, errorMessage: message }), { name: 'recordRunFailed' });
    throw err;
  }
}

// Runs inside a durable tool step: at-least-once. The unique idempotency_key makes a replay a no-op.
async function proposeAction(agent: AgentRow, sourceWorkflowId: string, proposal: Proposal) {
  const { action, target, ...payload } = proposal;
  return insertAction(agent, sourceWorkflowId, { action, target, payload, idempotencyKey: `${agent.id}:${action}:${target}:${sourceWorkflowId}` });
}

// Shared by every proposer: insert-once by idempotency key, then apply the agent's approval policy.
export async function insertAction(
  agent: Pick<AgentRow, 'id' | 'approval_policy'>, sourceWorkflowId: string,
  // refreshPending: a re-proposal may update the payload while the action is still undecided; once the
  // owner (or policy) decided, the row is never touched again.
  a: { action: string; target: string; payload: Record<string, unknown>; idempotencyKey: string; refreshPending?: boolean },
) {
  const { action, target, payload, idempotencyKey } = a;
  const { rows } = await pool.query(
    `insert into ops.actions (agent_id, source_workflow_id, logical_action, target, payload, risk_level, idempotency_key)
     select $1, $2, $3, $4, $5, t.default_risk, $6 from ops.tools t where t.name = $3
     on conflict (idempotency_key) do update set
       payload = case when $7 and ops.actions.status = 'pending_approval' then excluded.payload else ops.actions.payload end,
       updated_at = case when $7 and ops.actions.status = 'pending_approval' then now() else ops.actions.updated_at end
     returning id, status, risk_level`,
    [agent.id, sourceWorkflowId, action, target, payload, idempotencyKey, Boolean(a.refreshPending)],
  );
  const row = rows[0];
  const p = agent.approval_policy;
  const auto = p.mode === 'auto' || (p.mode === 'risk_threshold' && RISK_RANK[row.risk_level as 'low'] <= RISK_RANK[p.auto_at_or_below ?? 'low']);
  if (auto && row.status === 'pending_approval') {
    await approveAndEnqueue(row.id, 'policy:auto');
    return { actionId: row.id, status: 'approved_by_policy' };
  }
  return { actionId: row.id, status: row.status };
}

export const agentRun = DBOS.registerWorkflow(agentRunBody, { name: 'agentRun' });

// Skips a scheduled occurrence when the agent is paused, or blocked on a connection (not active, or missing a
// scope it needs). A blocked agent already shows in Needs You as one "Reconnect" item; failing every tick
// (every 20 minutes for Inbox Triage) would only bury it under identical "Run failed" items. Manual runs
// still fail loudly. The step keeps its original name: only its body changed, so no patch is needed.
async function skipIfPaused(agentId: string, scheduledAt: Date): Promise<boolean> {
  const { rows } = await pool.query(
    `update ops.agents a set last_skipped_at = greatest(coalesce(a.last_skipped_at, $2), $2),
            last_skip_reason = case when a.paused_at is not null then 'paused' else 'blocked' end
      where a.id = $1 and (a.paused_at is not null or exists (
        select 1 from ops.agent_connections ac join ops.connections c on c.id = ac.connection_id
         where ac.agent_id = a.id and ac.required and (c.status <> 'active' or not (ac.scopes <@ c.scopes))))
      returning last_skip_reason`,
    [agentId, scheduledAt],
  );
  if (rows[0]) console.log(`[schedule] ${agentId} is ${rows[0].last_skip_reason}; skipped ${scheduledAt.toISOString()}`);
  return rows.length === 1;
}

// Scheduled entry point. DBOS derives the workflow ID from schedule name + scheduled time
// (sched-<name>-<ISO>), so each occurrence runs once no matter how many containers are alive.
export const scheduledAgentRun = DBOS.registerWorkflow(
  async (scheduledAt: Date, context: { agentId: string }) => {
    // A paused agent skips the occurrence (checkpointed, so a replay skips it too). Patched: an occurrence
    // already in flight across the deploy replays without this step.
    if (await DBOS.patch('agent-pause')) {
      const skipped = await DBOS.runStep(() => skipIfPaused(context.agentId, scheduledAt), { name: 'skipIfPaused' });
      if (skipped) return;
    }
    await agentRunBody(context.agentId, { type: 'schedule', sourceEvent: scheduledAt.toISOString() });
  },
  { name: 'scheduledAgentRun' },
);

// ---------- approval → executor ----------

// Set by main.ts once DBOSClient exists. Approval flips the row and enqueues the executor in ONE
// Postgres transaction, so there is no "approved but executor never started" crash window.
let enqueueExecutor: ((c: import('pg').ClientBase, actionId: string, idempotencyKey: string) => Promise<void>) | undefined;
export function setExecutorEnqueuer(fn: typeof enqueueExecutor) {
  enqueueExecutor = fn;
}

export async function approveAndEnqueue(actionId: string, decidedBy: string): Promise<{ ok: boolean; status: string }> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows } = await c.query(
      `update ops.actions set status = 'approved', decided_by = $2, decided_at = now(), updated_at = now()
        where id = $1 and status = 'pending_approval' returning idempotency_key`,
      [actionId, decidedBy],
    );
    if (!rows[0]) {
      await c.query('rollback');
      const cur = await pool.query(`select status from ops.actions where id = $1`, [actionId]);
      return { ok: false, status: cur.rows[0]?.status ?? 'not_found' };
    }
    await enqueueExecutor!(c, actionId, rows[0].idempotency_key);
    await c.query('commit');
    return { ok: true, status: 'approved' };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export async function reject(actionId: string, decidedBy: string) {
  const { rows } = await pool.query(
    `update ops.actions set status = 'rejected', decided_by = $2, decided_at = now(), updated_at = now()
      where id = $1 and status = 'pending_approval' returning id`,
    [actionId, decidedBy],
  );
  return { ok: rows.length === 1 };
}

// Deterministic executor: no LLM. Workflow ID = the action's idempotency key (hard rule 2).
// DBOS guarantees one logical execution per ID; the provider-side Idempotency-Key (hard rule 3)
// covers the crash window between "provider accepted" and "our checkpoint was written".
async function executeActionBody(actionId: string) {
  const workflowId = DBOS.workflowID!;
  const action = await DBOS.runStep(
    async () => (await pool.query(`select * from ops.actions where id = $1`, [actionId])).rows[0],
    { name: 'loadAction' },
  );
  if (!action || action.status !== 'approved') return { skipped: action?.status ?? 'missing' };
  await DBOS.runStep(() => recordRunStart({ workflowId, kind: 'executor', agentId: action.agent_id, trigger: 'approval', actionId }), { name: 'recordRunStart' });

  // Failure-suite stand-in for "a later deploy inserted a step". Variant 2 is the correct way
  // (DBOS.patch: executions that already passed this point keep the old step sequence);
  // variant 2-unpatched is the mistake hard rule 4 exists to prevent.
  const variant = process.env.SPIKE_CODE_VARIANT ?? '1';
  if ((variant === '2' && (await DBOS.patch('audit-before-call'))) || variant === '2-unpatched') {
    await DBOS.runStep(async () => ({ audited: true }), { name: 'auditBeforeCall' });
  }

  try {
    const result = await DBOS.runStep(() => callProvider(action), {
      name: 'callProvider', retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2,
    });
    await DBOS.runStep(async () => {
      const hang = Number(process.env.HANG_IN_MARK_EXECUTED_MS ?? 0);
      if (hang) await new Promise((r) => setTimeout(r, hang));
      // A hold whose slot was taken at execution time is not "executed": it moved (a replacement awaits
      // approval) or it failed with a reason the owner sees in Needs You.
      const o = (result as { outcome?: string; message?: string }).outcome;
      const [status, error] = o === 'moved' ? ['superseded', 'slot no longer free; a new slot was proposed']
        : o === 'no_slot' ? ['failed', (result as { message: string }).message] : ['executed', null];
      await pool.query(`update ops.actions set status = $3, result = $2, error = $4, updated_at = now() where id = $1 and status = 'approved'`,
        [actionId, result, status, error]);
    }, { name: 'markExecuted' });
    await DBOS.runStep(() => recordRunEnd(workflowId, 'succeeded', {}), { name: 'recordRunEnd' });
    return result;
  } catch (err) {
    const control = dbosControlError(err);
    if (control) throw control;
    const { errorClass, message } = classify(err);
    await DBOS.runStep(async () => {
      await pool.query(`update ops.actions set status = 'failed', error = $2, updated_at = now() where id = $1 and status = 'approved'`, [actionId, `${errorClass}: ${message}`]);
      await recordRunEnd(workflowId, 'failed', { errorClass, errorMessage: message });
    }, { name: 'markFailed' });
    throw err;
  }
}

// Failure-suite hook: die after the provider committed, before DBOS checkpoints this step.
// CRASH_AFTER_PROVIDER_CALL_ACTION narrows it to one logical action (e.g. gmail.draft).
async function crashHook(action: { idempotency_key: string; logical_action: string }) {
  const marker = process.env.CRASH_AFTER_PROVIDER_CALL;
  const only = process.env.CRASH_AFTER_PROVIDER_CALL_ACTION;
  if (marker && !fs.existsSync(marker) && (!only || only === action.logical_action)) {
    fs.writeFileSync(marker, `${action.idempotency_key}\n`);
    console.log(`[crash-hook] SIGKILL after provider accepted ${action.idempotency_key}`);
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => undefined);
  }
}

async function callProvider(action: { agent_id: string; idempotency_key: string; logical_action: string; target: string; payload: Record<string, unknown> }) {
  // Real providers dispatch by logical action inside the same step, so the step sequence is unchanged.
  if (action.logical_action === 'agentops.hold') return createAgentOpsHold(action);
  // Gmail: only these two capabilities exist (src/connections/gmail.ts). Anything else gmail.* is refused.
  const p = action.payload as Record<string, string | null>;
  if (action.logical_action === 'gmail.label') {
    const r = await addAgentOpsLabel(p.connectionId!, p.messageId!, p.label!);
    await crashHook(action);
    return r;
  }
  if (action.logical_action === 'gmail.draft') {
    const r = await createDraftReplyOnce(p.connectionId!, {
      threadId: p.threadId!, to: p.to!, subject: p.subject!, body: p.draft!, inReplyTo: p.inReplyTo, references: p.references,
      idempotencyKey: action.idempotency_key,
    });
    await crashHook(action);
    return r;
  }
  if (action.logical_action.startsWith('gmail.')) throw new OpsError('validation', `no Gmail capability for ${action.logical_action}`);
  const res = await fetch(`${FAKE_PROVIDER_URL}/effects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': action.idempotency_key },
    body: JSON.stringify({ action: action.logical_action, target: action.target, payload: action.payload }),
  });
  const body = await res.json();
  if (!res.ok) throw new OpsError(res.status === 401 || res.status === 403 ? 'provider_auth' : 'provider_unavailable', `provider ${res.status}: ${body.error}`);
  await crashHook(action);
  return body;
}

export const executeAction = DBOS.registerWorkflow(executeActionBody, { name: 'executeAction' });
