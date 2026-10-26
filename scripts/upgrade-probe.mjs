// Version-agnostic DBOS probe for the upgrade test. Copied next to an older @dbos-inc/dbos-sdk
// install so `import` resolves to that version.
//   node upgrade-probe.mjs seed <dbUrl> <id>     one finished run + one run <id> killed mid-flight (PENDING)
//   node upgrade-probe.mjs recover <dbUrl> <id>  launch (runs DBOS migrations), finish the PENDING run <id>
import { DBOS } from '@dbos-inc/dbos-sdk';

const [mode, url, pendingId = 'probe-pending'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Named like a real workflow so ops.dbos_workflows() includes it.
const probe = DBOS.registerWorkflow(
  async (label) => {
    await DBOS.runStep(async () => `step1-${label}`, { name: 'step1' });
    await DBOS.runStep(async () => {
      if (mode === 'seed' && label === 'pending') {
        console.log('[probe] killing mid-flight');
        process.kill(process.pid, 'SIGKILL');
        await sleep(60_000);
      }
      return `step2-${label}`;
    }, { name: 'step2' });
    return `done-${label}`;
  },
  { name: 'agentRun' },
);

DBOS.setConfig({ name: 'rone-agent-base', systemDatabaseUrl: url, systemDatabaseSchemaName: 'dbos', executorID: 'upgrade-probe', enablePatching: true });
await DBOS.launch();
console.log(`[probe] DBOS launched, mode=${mode}`);

if (mode === 'seed') {
  console.log(await probe('done'));
  await DBOS.startWorkflow(probe, { workflowID: pendingId })('pending');
  await sleep(30_000);
} else {
  const h = DBOS.retrieveWorkflow(pendingId);
  console.log('[probe] recovered result:', await h.getResult());
  await DBOS.shutdown();
  process.exit(0);
}
