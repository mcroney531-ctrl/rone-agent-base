// The phone inbox ("Needs You"). ops.attention_queue (sql/002_views.sql) decides WHAT needs the owner;
// this module decides how any such row is presented and what can be done about it. Producers stay
// generic: a new workflow adds a `kind` to the view and an entry to KINDS, and it shows up in the
// same inbox with the same actions framework. Nothing here is Calendar-Prep-specific beyond its entries.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pool } from './db.js';
import { approveAndEnqueue, reject, agentRun, AGENT_QUEUE } from './workflows.js';
import { startGoogleAuth } from './connections/google.js';

export type ActionId = 'approve' | 'reject' | 'dismiss' | 'run_now' | 'reauth' | 'open';
export type ItemAction = { id: ActionId; label: string; style?: 'primary' | 'danger' };
export type Severity = 'decision' | 'problem' | 'info';

export type AttentionItem = {
  id: string;                // `${type}:${ref}`, stable while the item lives
  type: string;              // attention_queue.kind
  ref: string;
  source: string;            // who raised it: agent name, or the integration ("Google")
  agent: string | null;
  title: string;
  summary: string;
  severity: Severity;
  createdAt: string;
  actions: ItemAction[];
};

type Row = { kind: string; ref: string; agent_id: string | null; since: Date | null; detail: string | null; extra: Record<string, any> | null };

const A = {
  approve: { id: 'approve', label: 'Approve', style: 'primary' },
  reject: { id: 'reject', label: 'Reject', style: 'danger' },
  dismiss: { id: 'dismiss', label: 'Got it' },
  runNow: { id: 'run_now', label: 'Run now' },
  reauth: { id: 'reauth', label: 'Reconnect', style: 'primary' },
  open: { id: 'open', label: 'View', style: 'primary' },
} satisfies Record<string, ItemAction>;

const humanize = (id: string) => id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_:.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const ACTION_NAMES: Record<string, string> = { 'agentops.hold': 'Add prep hold', 'email.draft': 'Draft email', 'crm.note': 'CRM note', 'calendar.hold': 'Calendar hold' };

// One entry per attention kind. `title`/`summary` get the row; actions are what the owner can do from the phone.
const KINDS: Record<string, { severity: Severity; title: (r: Row) => string; summary?: (r: Row) => string; actions: (r: Row) => ItemAction[] }> = {
  approval_needed: {
    severity: 'decision',
    title: (r) => `${ACTION_NAMES[r.extra?.logical_action] ?? r.extra?.logical_action ?? 'Action'} — approve?`,
    summary: (r) => {
      const p = r.extra?.payload ?? {};
      if (r.extra?.logical_action === 'agentops.hold' && p.start) return `${p.title ?? 'Hold'} · ${fmtRange(p.start, p.end)}`;
      return r.detail ?? '';
    },
    actions: () => [A.approve, A.reject],
  },
  brief_ready: { severity: 'info', title: () => 'Brief is ready', actions: () => [A.open, A.dismiss] },
  connection_problem: {
    severity: 'problem',
    title: () => 'Connection needs attention',
    actions: (r) => (r.ref.startsWith('google:') ? [A.reauth] : []),
  },
  run_failed: { severity: 'problem', title: () => 'Run failed', actions: (r) => (r.agent_id ? [A.runNow, A.dismiss] : [A.dismiss]) },
  action_failed: { severity: 'problem', title: () => 'Action failed', actions: () => [A.dismiss] },
  brief_mirror_failed: { severity: 'problem', title: () => 'Calendar mirror not written', actions: (r) => (r.agent_id ? [A.runNow, A.dismiss] : [A.dismiss]) },
  action_stuck: { severity: 'problem', title: () => 'Approved action is stuck', actions: () => [A.dismiss] },
  run_stuck: { severity: 'problem', title: () => 'Run is stuck', actions: () => [A.dismiss] },
  queued_too_long: { severity: 'problem', title: () => 'Run waiting too long', actions: () => [A.dismiss] },
  no_executor_for_version: { severity: 'problem', title: () => 'No worker for this version', actions: () => [A.dismiss] },
  executor_unreaped: { severity: 'problem', title: () => 'Worker stopped responding', actions: () => [A.dismiss] },
};
const DECISION_KINDS = new Set(['approval_needed', 'connection_problem']); // only resolving them clears them
const FALLBACK = { severity: 'problem' as Severity, title: (r: Row) => humanize(r.kind), actions: () => [A.dismiss] };

function fmtRange(start: string, end?: string): string {
  const tz = process.env.OWNER_TIMEZONE ?? 'America/New_York';
  const d = new Date(start);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const t = (x: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(x);
  return `${day}, ${t(d)}${end ? `–${t(new Date(end))}` : ''}`;
}

function toItem(r: Row): AttentionItem {
  const k = KINDS[r.kind] ?? FALLBACK;
  const source = r.kind === 'connection_problem' ? humanize(r.ref.split(':')[0]) : r.agent_id ? humanize(r.agent_id) : 'System';
  return {
    id: `${r.kind}:${r.ref}`, type: r.kind, ref: r.ref, agent: r.agent_id, source,
    title: k.title(r), summary: (k as typeof KINDS[string]).summary?.(r) ?? r.detail ?? '',
    severity: k.severity, createdAt: (r.since ?? new Date()).toISOString(), actions: k.actions(r),
  };
}

const ORDER: Record<Severity, number> = { decision: 0, problem: 1, info: 2 };

async function rows(filter?: { kind: string; ref: string }): Promise<Row[]> {
  const { rows } = await pool.query(
    `select q.kind, q.ref, q.agent_id, q.since, q.detail,
            case when q.kind in ('approval_needed', 'action_failed') then
              (select jsonb_build_object('logical_action', a.logical_action, 'payload', a.payload, 'target', a.target)
                 from ops.actions a where a.id::text = q.ref) end as extra
       from ops.attention_queue q
       left join ops.attention_acks k on k.kind = q.kind and k.ref = q.ref
      where (k.acked_at is null or q.since > k.acked_at)
        and ($1::text is null or (q.kind = $1 and q.ref = $2))`,
    [filter?.kind ?? null, filter?.ref ?? null],
  );
  return rows;
}

export async function listAttention(): Promise<AttentionItem[]> {
  return (await rows()).map(toItem).sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || b.createdAt.localeCompare(a.createdAt));
}

// Drill-in: the item plus plain label/value facts, so the phone renders any kind without knowing it.
export async function attentionDetail(kind: string, ref: string) {
  const [row] = await rows({ kind, ref });
  if (!row) return null;
  const facts: { label: string; value: string }[] = [];
  const add = (label: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    const value = typeof v === 'string' ? v
      : v instanceof Date ? v.toISOString()
      : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.map((x) => `• ${x}`).join('\n')
      : JSON.stringify(v, null, 2);
    facts.push({ label, value });
  };
  if (kind === 'approval_needed' || kind === 'action_failed' || kind === 'action_stuck') {
    const { rows: [a] } = await pool.query(`select * from ops.actions where id::text = $1`, [ref]);
    if (a) {
      add('Action', ACTION_NAMES[a.logical_action] ?? a.logical_action); add('Risk', a.risk_level); add('Status', humanize(a.status));
      const p = a.payload ?? {};
      if (p.start) add('When', fmtRange(p.start, p.end));
      for (const [k2, v] of Object.entries(p)) if (!['start', 'end', 'connectionId', 'briefDate'].includes(k2)) add(humanize(k2), v);
      add('Error', a.error); add('Proposed by run', a.source_workflow_id);
    }
  } else if (kind === 'connection_problem') {
    const { rows: [c] } = await pool.query(`select provider, status, account_label, last_error, last_checked_at from ops.connections where id = $1`, [ref]);
    if (c) { add('Account', c.account_label); add('Status', humanize(c.status)); add('Error', c.last_error); add('Last checked', c.last_checked_at); }
  } else if (kind === 'brief_ready' || kind === 'brief_mirror_failed') {
    const { rows: [b] } = await pool.query(`select brief_date::text, headline, items, considered, mirror_status, mirror_error from ops.briefs where id::text = $1`, [ref]);
    if (b) {
      add('Day', b.brief_date); add('Headline', b.headline);
      add('Worth preparing for', (b.items as { localStart: string | null; title: string }[]).map((i) => `${i.localStart ?? 'All day'}  ${i.title}`).join('\n'));
      add('Events considered', String(b.considered)); add('Calendar mirror', b.mirror_status); add('Mirror error', b.mirror_error);
    }
  } else {
    const { rows: [run] } = await pool.query(`select * from ops.v_runs where workflow_id = $1`, [ref]);
    if (run) {
      add('Agent', run.agent_id); add('Trigger', run.trigger_type); add('State', run.run_state);
      add('Error', [run.error_class, run.error_message].filter(Boolean).join(': ')); add('Started', run.created_at);
      const steps = (await DBOS.listWorkflowSteps(ref)) ?? [];
      add('Steps', steps.map((s) => `${s.error ? '✗' : '✓'} ${s.name}`).join('\n'));
    }
  }
  if (!facts.length) add('Details', row.detail); // generic fallback for kinds without a drill-in above
  return { item: toItem(row), facts };
}

export type ActResult = { ok: boolean; status: number; message: string; redirect?: string; workflowId?: string };

// Every action re-checks that the item still needs the owner and still offers that action.
export async function actOnAttention(kind: string, ref: string, action: string, by: string, requestId?: string): Promise<ActResult> {
  const [row] = await rows({ kind, ref });
  if (!row) return { ok: false, status: 409, message: 'This no longer needs you.' };
  const item = toItem(row);
  if (!item.actions.some((a) => a.id === action)) return { ok: false, status: 400, message: `Can't ${action} this item.` };

  switch (action as ActionId) {
    case 'approve': {
      const r = await approveAndEnqueue(ref, by);
      return { ok: r.ok, status: r.ok ? 200 : 409, message: r.ok ? 'Approved — running now.' : `Already ${r.status}.` };
    }
    case 'reject': {
      const r = await reject(ref, by);
      return { ok: r.ok, status: r.ok ? 200 : 409, message: r.ok ? 'Rejected.' : 'Already decided.' };
    }
    case 'dismiss': {
      if (DECISION_KINDS.has(kind)) return { ok: false, status: 400, message: 'This needs a decision, not a dismissal.' };
      if (kind === 'brief_ready') await pool.query(`update ops.briefs set seen_at = coalesce(seen_at, now()) where id::text = $1`, [ref]);
      else await pool.query(
        `insert into ops.attention_acks (kind, ref, acked_by) values ($1, $2, $3)
         on conflict (kind, ref) do update set acked_at = now(), acked_by = excluded.acked_by`, [kind, ref, by]);
      return { ok: true, status: 200, message: 'Cleared.' };
    }
    case 'run_now': {
      if (!row.agent_id) return { ok: false, status: 400, message: 'No agent to run.' };
      const r = await runAgentNow(row.agent_id, requestId);
      return { ok: true, status: 202, message: 'Started.', workflowId: r.workflowId };
    }
    case 'reauth':
      return { ok: true, status: 200, message: 'Opening Google…', redirect: await startGoogleAuth(ref) };
    case 'open':
      return { ok: true, status: 200, message: '' };
  }
  return { ok: false, status: 400, message: 'Unknown action.' };
}

// Same deterministic-ID rule as POST /agents/:id/run: one tap (one requestId) = one run, however often it's retried.
export async function runAgentNow(agentId: string, requestId?: string): Promise<{ workflowId: string }> {
  const rid = requestId && /^[\w.:-]{1,128}$/.test(requestId) ? requestId : crypto.randomUUID();
  const workflowId = `manual-${agentId}-${rid}`;
  await DBOS.startWorkflow(agentRun, { workflowID: workflowId, queueName: AGENT_QUEUE })(agentId, { type: 'manual', sourceEvent: rid });
  return { workflowId };
}

export async function listAgents() {
  const { rows } = await pool.query(
    `select a.id, a.enabled, a.schedule, a.timezone, a.handler, h.health_state, h.last_outcome, h.last_finished_at,
            h.last_error_class, h.pending_approvals, h.blocked_connections
       from ops.agents a left join ops.agent_health h on h.agent_id = a.id
      order by a.enabled desc, a.id`,
  );
  return rows.map((r) => ({ ...r, name: humanize(r.id) }));
}
