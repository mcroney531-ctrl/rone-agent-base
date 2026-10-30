// Eval runner: node --import tsx src/eval/run.ts <suite> [--split dev|holdout|all]
// Deployed as its own Railway service (run once, then exit), so an eval never competes with the live worker.
// Exit code: 0 passed, 1 a critical invariant failed (BLOCK), 2 the eval could not run.
import fs from 'node:fs';
import { pool } from '../db.js';
import { runSuite, type Split, type Suite } from './harness.js';
import { inboxTriageSuite } from './inboxTriage.js';

const SUITES: Record<string, (db: typeof pool) => Suite> = {
  'inbox-triage': (db) => inboxTriageSuite(db),
};

const [name = 'inbox-triage', ...rest] = process.argv.slice(2);
const splitArg = rest[rest.indexOf('--split') + 1] ?? 'all';
const splits: Split[] = rest.includes('--split') && splitArg !== 'all' ? [splitArg as Split] : ['dev', 'holdout'];

let code = 2;
try {
  if (!SUITES[name]) throw new Error(`unknown suite ${name}; have: ${Object.keys(SUITES).join(', ')}`);
  await pool.query(fs.readFileSync(new URL('../../sql/012_evals.sql', import.meta.url), 'utf8'));
  const out = await runSuite(pool, SUITES[name](pool), splits);
  console.log(out.report);
  code = out.status === 'passed' ? 0 : 1;
} catch (e) {
  console.error('[eval] could not run:', (e as Error).message);
} finally {
  await pool.end();
}
process.exit(code);
