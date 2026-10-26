// Production-validation driver. Runs as its own Railway service on the private network (the build
// sandbox cannot reach *.up.railway.app). Each phase logs one `[validate] {...}` JSON result line,
// then the process idles so Railway doesn't restart it. Pick a phase with VALIDATE_PHASE:
//   smoke   real Supabase + real model: run, 3 proposals, approve 2 / reject 1, executor effects
//   crash   hard-kill the worker mid-agent-loop; Railway restarts it; new process takes over
//   watch   keep in-flight work going for WATCH_SECONDS while the operator redeploys the worker
//           (e.g. SPIKE_CODE_VARIANT 1 → 2 with a short drain); then audit every run and action
const WORKER = process.env.WORKER_URL ?? 'http://127.0.0.1:7800';
const TOKEN = process.env.API_TOKEN ?? '';
const PHASE = process.env.VALIDATE_PHASE ?? 'smoke';
const AGENT = 'spike-agent';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  try {
    const r = await fetch(`${WORKER}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const t = await r.text();
    return { status: r.status, body: t ? JSON.parse(t) : null };
  } catch (e) {
    return { status: -1, body: (e as Error).message };
  }
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMS: number): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMS) {
    const v = await fn().catch(() => undefined);
    if (v) return { ms: Date.now() - t0, value: v as T };
    await sleep(1000);
  }
  throw new Error(`timed out after ${timeoutMS}ms: ${what}`);
}
const report = (result: Record<string, unknown>) => console.log(`[validate] ${JSON.stringify({ phase: PHASE, at: new Date().toISOString(), ...result })}`);

async function run(requestId: string) {
  const r = await api('POST', `/agents/${AGENT}/run`, { requestId });
  if (r.status !== 202) throw new Error(`trigger failed ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.workflowID as string;
}
async function runRow(wf: string) {
  const r = await api('GET', '/runs?limit=1000');
  return Array.isArray(r.body) ? r.body.find((x: any) => x.workflow_id === wf) : undefined;
}
const terminal = (s?: string) => s === 'succeeded' || s === 'failed' || s === 'cancelled';
async function actionsOf(wf: string) {
  const r = await api('GET', '/actions');
  return (r.body as any[]).filter((a) => a.idempotency_key.endsWith(`:${wf}`));
}

async function smoke() {
  const health0 = await api('GET', '/health');
  const wf = await run(`smoke-${Date.now()}`);
  const done = await until('reasoning run terminal', async () => { const r = await runRow(wf); return terminal(r?.run_state) && r; }, 240_000);
  const steps = (await api('GET', `/admin/steps/${encodeURIComponent(wf)}`)).body;
  const acts = await actionsOf(wf);
  const decided: Record<string, number> = {};
  for (const [i, a] of acts.entries()) {
    const op = i === acts.length - 1 && acts.length > 1 ? 'reject' : 'approve';
    decided[`${a.logical_action}:${op}`] = (await api('POST', `/actions/${a.id}/${op}`, { by: 'validator' })).status;
  }
  const settled = await until('executors settled', async () => {
    const now = await actionsOf(wf);
    return now.every((a) => ['executed', 'rejected', 'failed'].includes(a.status)) && now;
  }, 120_000).catch((e) => ({ ms: -1, value: String(e.message) }));
  report({
    ok: done.value.run_state === 'succeeded' && acts.length > 0 && Array.isArray(settled.value) && settled.value.every((a: any) => a.status !== 'failed'),
    workflow: wf, runMs: done.ms, run: done.value, stepNames: Array.isArray(steps) ? steps.map((s: any) => s.name) : steps,
    proposed: acts.map((a) => a.logical_action), decided, settled: settled.value, settleMs: settled.ms,
    provider: (await api('GET', '/admin/provider/stats')).body, healthBefore: health0.body?.agents, healthAfter: (await api('GET', '/health')).body,
  });
}

async function crash() {
  const before = (await api('GET', '/livez')).body?.executor;
  const wf = await run(`crash-${Date.now()}`);
  const inflight = await until('run has checkpointed its first model call', async () => {
    const s = (await api('GET', `/admin/steps/${encodeURIComponent(wf)}`)).body;
    return Array.isArray(s) && s.some((x: any) => /generate|stream/.test(x.name)) && s;
  }, 120_000);
  const stepsAtCrash = inflight.value.map((s: any) => s.name);
  const t0 = Date.now();
  await api('POST', '/admin/crash');
  const back = await until('a NEW worker process is serving', async () => {
    const id = (await api('GET', '/livez')).body?.executor; return id && id !== before && id;
  }, 180_000);
  const settled = await until('crashed run terminal', async () => { const r = await runRow(wf); return terminal(r?.run_state) && r; }, 240_000);
  const executors = (await api('GET', '/admin/executors')).body;
  const steps = (await api('GET', `/admin/steps/${encodeURIComponent(wf)}`)).body;
  const acts = await actionsOf(wf);
  report({
    ok: settled.value.run_state === 'succeeded' && settled.value.executor_id === back.value,
    workflow: wf, executorBefore: before, executorAfter: back.value, restartMs: back.ms, takeoverMsFromCrash: Date.now() - t0,
    stepsAtCrash, stepsFinal: Array.isArray(steps) ? steps.map((s: any) => s.name) : steps, run: settled.value,
    proposed: acts.map((a) => a.logical_action), duplicateKeys: acts.length - new Set(acts.map((a) => a.idempotency_key)).size,
    executors: (executors as any[]).map((e) => ({ id: e.executor_id, deployment: e.railway_deployment_id, replica: e.railway_replica_id, git: e.git_sha?.slice(0, 7), started: e.started_at, stopped: e.stopped_at, reapedBy: e.reaped_by, reapedCount: e.reaped_count })),
  });
}

async function watch() {
  const seconds = Number(process.env.WATCH_SECONDS ?? 300);
  const t0 = Date.now();
  const wfs: string[] = [];
  const approvals: string[] = [];
  const seenExecutors = new Set<string>();
  while (Date.now() - t0 < seconds * 1000) {
    const live = (await api('GET', '/livez')).body?.executor;
    if (live) seenExecutors.add(live);
    try { wfs.push(await run(`watch-${Date.now()}`)); } catch (e) { console.log(`[validate] trigger error during watch: ${(e as Error).message}`); }
    const pending = ((await api('GET', '/actions?status=pending_approval')).body ?? []) as any[];
    for (const a of pending.slice(0, 2)) if ((await api('POST', `/actions/${a.id}/approve`, { by: 'validator' })).status === 200) approvals.push(a.idempotency_key);
    await sleep(15_000);
  }
  const settle = await until('all watched runs and approved actions terminal', async () => {
    const runs = (await api('GET', '/runs?limit=1000')).body as any[];
    const acts = (await api('GET', '/actions')).body as any[];
    const open = wfs.filter((w) => !terminal(runs.find((r) => r.workflow_id === w)?.run_state));
    const openActs = acts.filter((a) => approvals.includes(a.idempotency_key) && a.status === 'approved');
    return open.length === 0 && openActs.length === 0 && { runs, acts };
  }, 300_000).catch((e) => ({ ms: -1, value: { error: String(e.message) } as any }));
  const runs = (settle.value.runs ?? []) as any[];
  const acts = (settle.value.acts ?? []) as any[];
  const watched = runs.filter((r) => wfs.includes(r.workflow_id));
  const execRuns = runs.filter((r) => approvals.includes(r.workflow_id));
  const patchedStepsSample = await Promise.all(execRuns.slice(-2).concat(execRuns.slice(0, 2)).map(async (r) => ({
    wf: r.workflow_id, executor: r.executor_id, steps: ((await api('GET', `/admin/steps/${encodeURIComponent(r.workflow_id)}`)).body as any[]).map((s) => s.name),
  })));
  report({
    ok: settle.ms >= 0 && watched.every((r) => r.run_state === 'succeeded') && execRuns.every((r) => r.run_state === 'succeeded'),
    watchedRuns: wfs.length, byState: watched.reduce((m: any, r) => ((m[r.run_state] = (m[r.run_state] ?? 0) + 1), m), {}),
    approvedActions: approvals.length, executorRunsByState: execRuns.reduce((m: any, r) => ((m[r.run_state] = (m[r.run_state] ?? 0) + 1), m), {}),
    actionStatuses: acts.filter((a) => approvals.includes(a.idempotency_key)).reduce((m: any, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {}),
    servingExecutorsSeen: [...seenExecutors], runsByExecutor: watched.concat(execRuns).reduce((m: any, r) => ((m[r.executor_id] = (m[r.executor_id] ?? 0) + 1), m), {}),
    executorSteps: patchedStepsSample, provider: (await api('GET', '/admin/provider/stats')).body,
    executors: (await api('GET', '/admin/executors')).body, attention: (await api('GET', '/health')).body?.attention?.filter((a: any) => a.kind !== 'approval_needed'),
  });
}

try {
  await until('worker reachable', async () => (await api('GET', '/livez')).status === 200, 300_000);
  await ({ smoke, crash, watch } as Record<string, () => Promise<void>>)[PHASE]();
} catch (e) {
  report({ ok: false, error: (e as Error).message });
}
console.log('[validate] phase complete; idling');
// A live timer keeps the event loop busy; a bare never-resolving promise lets Node exit with code 13.
setInterval(() => undefined, 1 << 30);
