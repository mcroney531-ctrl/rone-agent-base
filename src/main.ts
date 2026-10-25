import fs from 'node:fs';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import {
  APP_NAME, BUILD_VERSION, DATABASE_URL, DRAIN_TIMEOUT_MS, EXECUTOR_ID, HTTP_PORT, VERSIONING,
  assertListenNotifyWorks, assertNotTransactionPooler,
} from './config.js';
import { pool } from './db.js';
import {
  AGENT_QUEUE, EXECUTOR_QUEUE, agentRun, approveAndEnqueue, reject, scheduledAgentRun, setExecutorEnqueuer,
} from './workflows.js';
import { markStopped, registerExecutor, startLivenessLoops, sweepDeadExecutors } from './recovery.js';

if (process.env.UNSAFE_SKIP_CONNECTION_GUARD === '1') {
  console.warn('[main] UNSAFE_SKIP_CONNECTION_GUARD=1 — connection-mode guard disabled (failure-suite only)');
} else {
  assertNotTransactionPooler(DATABASE_URL);
  await assertListenNotifyWorks(DATABASE_URL);
}

// Multi-statement query = one implicit transaction; the xact lock serializes replicas booting together.
const applySql = (file: string) =>
  pool.query(`select pg_advisory_xact_lock(727274); ${fs.readFileSync(new URL(`../sql/${file}`, import.meta.url), 'utf8')}`);

const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN && process.env.RAILWAY_ENVIRONMENT) throw new Error('API_TOKEN must be set when deployed: the API can approve external actions');
function authorized(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) return true;
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${API_TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

await applySql('001_ops_schema.sql');

DBOS.setConfig({
  name: APP_NAME,
  systemDatabaseUrl: DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
  executorID: EXECUTOR_ID,
  ...(VERSIONING === 'patching' ? { enablePatching: true } : BUILD_VERSION ? { applicationVersion: BUILD_VERSION } : {}),
});
await DBOS.launch();
await applySql('002_views.sql');

await DBOS.registerQueue(AGENT_QUEUE, { concurrency: 4 });
await DBOS.registerQueue(EXECUTOR_QUEUE, { concurrency: 8 });

const client = await DBOSClient.create({ systemDatabaseUrl: DATABASE_URL, systemDatabaseSchemaName: 'dbos', applicationName: APP_NAME });
setExecutorEnqueuer(async (c, actionId, idempotencyKey) => {
  await client.enqueueInTransaction(c, { queueName: EXECUTOR_QUEUE, workflowName: 'executeAction', workflowID: idempotencyKey }, actionId);
});

// Schedules come from config rows: adding an agent = inserting a row, not deploying code.
const { rows: scheduled } = await pool.query(`select id, schedule from ops.agents where enabled and schedule is not null`);
if (process.env.DISABLE_SCHEDULES !== '1') {
  await DBOS.applySchedules(
    scheduled.map((a) => ({
      scheduleName: `agent-${a.id}`,
      workflowFn: scheduledAgentRun,
      schedule: a.schedule,
      context: { agentId: a.id },
      queueName: AGENT_QUEUE,
    })),
  );
}

await registerExecutor();
await sweepDeadExecutors();
const stopLiveness = startLivenessLoops();
console.log(`[main] executor=${EXECUTOR_ID} version=${DBOS.applicationVersion} schedules=${scheduled.length}`);

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
const send = (res: http.ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body, null, 2));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/health') {
      const [health, attention] = await Promise.all([
        pool.query(`select * from ops.agent_health order by agent_id`),
        pool.query(`select * from ops.attention_queue order by since`),
      ]);
      return send(res, 200, { executor: EXECUTOR_ID, version: DBOS.applicationVersion, agents: health.rows, attention: attention.rows });
    }
    if (req.method === 'GET' && url.pathname === '/actions') {
      const status = url.searchParams.get('status');
      const { rows } = await pool.query(
        `select id, agent_id, logical_action, target, payload, risk_level, status, idempotency_key, result, error, created_at
           from ops.actions where ($1::text is null or status = $1) order by created_at`,
        [status],
      );
      return send(res, 200, rows);
    }
    if (req.method === 'GET' && url.pathname === '/runs') {
      const { rows } = await pool.query(`select * from ops.v_runs order by created_at desc limit 50`);
      return send(res, 200, rows);
    }
    // POST /actions/:id/approve | /actions/:id/reject
    if (req.method === 'POST' && parts[0] === 'actions' && parts[1] && ['approve', 'reject'].includes(parts[2] ?? '')) {
      const by = String((await readJson(req)).by ?? 'dashboard');
      const out = parts[2] === 'approve' ? await approveAndEnqueue(parts[1], by) : await reject(parts[1], by);
      return send(res, out.ok ? 200 : 409, out);
    }
    // Manual and webhook triggers: thin handlers that start a workflow with a deterministic ID,
    // so a retried request (same requestId/eventId) maps onto the same run instead of a new one.
    if (req.method === 'POST' && parts[0] === 'agents' && parts[1] && parts[2] === 'run') {
      const requestId = String((await readJson(req)).requestId ?? '');
      if (!requestId) return send(res, 400, { error: 'requestId required' });
      const workflowID = `manual-${parts[1]}-${requestId}`;
      await DBOS.startWorkflow(agentRun, { workflowID, queueName: AGENT_QUEUE })(parts[1], { type: 'manual', sourceEvent: requestId });
      return send(res, 202, { workflowID });
    }
    if (req.method === 'POST' && parts[0] === 'webhooks' && parts[1]) {
      const eventId = String((await readJson(req)).eventId ?? '');
      if (!eventId) return send(res, 400, { error: 'eventId required' });
      const workflowID = `webhook-${parts[1]}-${eventId}`;
      await DBOS.startWorkflow(agentRun, { workflowID, queueName: AGENT_QUEUE })(parts[1], { type: 'webhook', sourceEvent: eventId });
      return send(res, 202, { workflowID });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[http]', err);
    send(res, 500, { error: (err as Error).message });
  }
});
server.listen(HTTP_PORT, () => console.log(`[main] http on :${HTTP_PORT}`));

// Railway sends SIGTERM to the old container during a deploy (pattern B: drain).
// Keep heartbeating while draining so no peer reaps us; anything that outlives the drain window is
// still PENDING under our executor ID and gets resumed by a peer once our heartbeat goes stale.
let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[main] SIGTERM: draining up to ${DRAIN_TIMEOUT_MS}ms`);
  server.close();
  await DBOS.shutdown({ workflowCompletionTimeoutMS: DRAIN_TIMEOUT_MS });
  stopLiveness();
  await markStopped().catch(() => undefined);
  await client.destroy().catch(() => undefined);
  await pool.end().catch(() => undefined);
  console.log('[main] drained, exiting');
  process.exit(0);
});
