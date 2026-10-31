// Eval runner: node --import tsx src/eval/run.ts <suite|all> [--split dev|holdout|all]
// Deployed as its own Railway service (run once, then exit), so an eval never competes with the live worker.
// Exit code: 0 passed, 1 a critical invariant failed (BLOCK), 2 an eval could not run.
import fs from 'node:fs';
import { pool } from '../db.js';
import { runSuite, type Split, type Suite } from './harness.js';
import { inboxTriageSuite } from './inboxTriage.js';
import { calendarPrepSuite } from './calendarPrep.js';

const SUITES: Record<string, (db: typeof pool) => Suite> = {
  'inbox-triage': (db) => inboxTriageSuite(db),
  'calendar-prep': (db) => calendarPrepSuite(db),
};

const [name = 'all', ...rest] = process.argv.slice(2);
const splitArg = rest[rest.indexOf('--split') + 1] ?? 'all';
const splits: Split[] = rest.includes('--split') && splitArg !== 'all' ? [splitArg as Split] : ['dev', 'holdout'];

let code = 0;
try {
  const names = name === 'all' ? Object.keys(SUITES) : [name];
  for (const n of names) if (!SUITES[n]) throw new Error(`unknown suite ${n}; have: ${Object.keys(SUITES).join(', ')}`);
  await pool.query(fs.readFileSync(new URL('../../sql/012_evals.sql', import.meta.url), 'utf8'));
  for (const n of names) {
    try {
      const out = await runSuite(pool, SUITES[n](pool), splits);
      console.log(`${out.report}\n`);
      if (out.status !== 'passed') code = Math.max(code, 1);
    } catch (e) {
      console.error(`[eval] ${n} could not run:`, (e as Error).message);
      code = 2;
    }
  }
} catch (e) {
  console.error('[eval] could not run:', (e as Error).message);
  code = 2;
} finally {
  await pool.end();
}
process.exit(code);
