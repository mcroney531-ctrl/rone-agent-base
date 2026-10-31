// Eval harness: generic machinery for scoring an agent's judgment layer against a scenario corpus.
// A suite (one per agent) runs its scenarios through the agent's REAL prompt/schema/model code and returns
// per-scenario results; this module scores them, compares with the last run, records everything in
// ops.eval_runs / ops.eval_results, and decides pass/fail.
//
// Policy (docs/evals.md):
//   BLOCK  any critical invariant fails, or the model's output is invalid. Pass/fail, never averaged away.
//   REPORT accuracy, per-category precision/recall, confusion matrix, draft quality, change vs baseline.
// Labels may allow more than one answer (`acceptable`), so the harness doesn't reward brittle behaviour.
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type pg from 'pg';

export type Split = 'dev' | 'holdout';
export type Check = { id: string; critical: boolean; pass: boolean; detail?: string };

export type ScenarioResult = {
  id: string;
  split: Split;
  group?: string;                                             // e.g. an A/B arm ('with' / 'without' retrieval)
  expected: { acceptable: string[]; [k: string]: unknown };  // acceptable[0] is the primary label (for recall/confusion)
  output: Record<string, unknown> | null;
  predicted: string | null;
  checks: Check[];                                            // invariants (critical) and quality checks (not)
};

export type Provenance = {
  promptHash: string; model: string; modelConfig: Record<string, unknown>; schemaVersion: string;
  corpusVersion: string; corpusHash: string; evaluatorVersion: string;
};

export interface Suite {
  name: string;
  labels: readonly string[];
  provenance(): Promise<Provenance>;
  run(splits: Split[]): Promise<ScenarioResult[]>;
}

export const sha = (s: string, n = 12) => createHash('sha256').update(s).digest('hex').slice(0, n);

export function gitCommit(): string | null {
  if (process.env.RAILWAY_GIT_COMMIT_SHA) return process.env.RAILWAY_GIT_COMMIT_SHA;
  try { return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

export type Metrics = {
  n: number;
  accuracy: number;
  bySplit: Record<string, { n: number; accuracy: number }>;
  byGroup: Record<string, { n: number; accuracy: number }>;
  byLabel: Record<string, { support: number; recall: number | null; predicted: number; precision: number | null }>;
  confusion: Record<string, Record<string, number>>;          // primary expected → predicted → count
  quality: { checks: number; passed: number; score: number | null; failures: Record<string, number> };
  critical: { scenario: string; check: string; detail?: string }[];
};

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);

export function score(results: ScenarioResult[], labels: readonly string[]): Metrics {
  const ok = (r: ScenarioResult) => r.predicted !== null && r.expected.acceptable.includes(r.predicted);
  const bySplit: Metrics['bySplit'] = {};
  for (const sp of new Set(results.map((r) => r.split))) {
    const rs = results.filter((r) => r.split === sp);
    bySplit[sp] = { n: rs.length, accuracy: ratio(rs.filter(ok).length, rs.length) ?? 0 };
  }
  const byGroup: Metrics['byGroup'] = {};
  for (const g of new Set(results.map((r) => r.group).filter((g): g is string => Boolean(g)))) {
    const rs = results.filter((r) => r.group === g);
    byGroup[g] = { n: rs.length, accuracy: ratio(rs.filter(ok).length, rs.length) ?? 0 };
  }
  const byLabel: Metrics['byLabel'] = {};
  const confusion: Metrics['confusion'] = {};
  for (const l of labels) {
    const primary = results.filter((r) => r.expected.acceptable[0] === l);
    const predicted = results.filter((r) => r.predicted === l);
    byLabel[l] = {
      support: primary.length, recall: ratio(primary.filter(ok).length, primary.length),
      // A prediction is right when it is acceptable for that scenario, primary label or not.
      predicted: predicted.length, precision: ratio(predicted.filter((r) => r.expected.acceptable.includes(l)).length, predicted.length),
    };
  }
  for (const r of results) {
    const row = (confusion[r.expected.acceptable[0]] ??= {});
    const p = r.predicted ?? '(none)';
    row[p] = (row[p] ?? 0) + 1;
  }
  const quality = results.flatMap((r) => r.checks.filter((c) => !c.critical));
  const failures: Record<string, number> = {};
  for (const c of quality.filter((q) => !q.pass)) failures[c.id] = (failures[c.id] ?? 0) + 1;
  return {
    n: results.length, accuracy: ratio(results.filter(ok).length, results.length) ?? 0, bySplit, byGroup, byLabel, confusion,
    quality: { checks: quality.length, passed: quality.filter((q) => q.pass).length, score: ratio(quality.filter((q) => q.pass).length, quality.length), failures },
    critical: results.flatMap((r) => r.checks.filter((c) => c.critical && !c.pass).map((c) => ({ scenario: r.id, check: c.id, detail: c.detail }))),
  };
}

export type RunOutcome = { runId: number; status: 'passed' | 'failed'; metrics: Metrics; baseline: { id: number; metrics: Metrics } | null; report: string };

/** Runs a suite end to end and records it. Never throws for a failed eval; throws only if it could not run. */
export async function runSuite(db: pg.Pool, suite: Suite, splits: Split[]): Promise<RunOutcome> {
  const p = await suite.provenance();
  const { rows: [run] } = await db.query(
    `insert into ops.eval_runs (suite, git_commit, prompt_hash, model, model_config, schema_version, corpus_version, corpus_hash, evaluator_version, splits)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [suite.name, gitCommit(), p.promptHash, p.model, p.modelConfig, p.schemaVersion, p.corpusVersion, p.corpusHash, p.evaluatorVersion, splits],
  );
  try {
    const results = await suite.run(splits);
    const metrics = score(results, suite.labels);
    for (const r of results) {
      await db.query(
        `insert into ops.eval_results (run_id, scenario_id, split, expected, output, correct, checks) values ($1, $2, $3, $4, $5, $6, $7)`,
        [run.id, r.id, r.split, r.expected, r.output, r.predicted !== null && r.expected.acceptable.includes(r.predicted), JSON.stringify(r.checks)],
      );
    }
    // Baseline: the previous finished run of this suite over the same corpus and splits.
    const { rows: [b] } = await db.query(
      `select id, metrics from ops.eval_runs where suite = $1 and id < $2 and status in ('passed', 'failed')
         and corpus_hash = $3 and splits = $4 order by id desc limit 1`, [suite.name, run.id, p.corpusHash, splits]);
    const status = metrics.critical.length ? 'failed' : 'passed';
    await db.query(
      `update ops.eval_runs set status = $2, finished_at = now(), metrics = $3, critical_failures = $4, baseline_run_id = $5 where id = $1`,
      [run.id, status, metrics, metrics.critical.length, b?.id ?? null],
    );
    const baseline = b ? { id: Number(b.id), metrics: b.metrics as Metrics } : null;
    return { runId: Number(run.id), status, metrics, baseline, report: report(suite.name, Number(run.id), p, metrics, baseline) };
  } catch (e) {
    await db.query(`update ops.eval_runs set status = 'error', finished_at = now(), error = $2 where id = $1`, [run.id, String((e as Error).message).slice(0, 2000)]);
    throw e;
  }
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? '  –  ' : `${(x * 100).toFixed(0).padStart(3)}%`);
const delta = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? '' : ` (${a - b >= 0 ? '+' : ''}${((a - b) * 100).toFixed(0)})`;

export function report(name: string, runId: number, p: Provenance, m: Metrics, baseline: { id: number; metrics: Metrics } | null): string {
  const b = baseline?.metrics;
  const lines = [
    `eval ${name} #${runId}  ${m.critical.length ? 'FAILED (critical invariants)' : 'passed'}`,
    `  model ${p.model} ${JSON.stringify(p.modelConfig)} · prompt ${p.promptHash} · schema ${p.schemaVersion} · corpus ${p.corpusVersion}/${p.corpusHash} · evaluator ${p.evaluatorVersion}`,
    `  baseline: ${baseline ? `#${baseline.id}` : 'none'}`,
    '',
    `BLOCK  critical invariant failures: ${m.critical.length}`,
    ...m.critical.map((c) => `  ✗ ${c.scenario}: ${c.check}${c.detail ? ` (${c.detail})` : ''}`),
    '',
    `REPORT accuracy ${pct(m.accuracy)}${delta(m.accuracy, b?.accuracy)}  ` + Object.entries(m.bySplit).map(([k, v]) => `${k} ${pct(v.accuracy)} of ${v.n}${delta(v.accuracy, b?.bySplit[k]?.accuracy)}`).join('  '),
    ...(Object.keys(m.byGroup ?? {}).length ? ['  by arm: ' + Object.entries(m.byGroup).map(([k, v]) => `${k} ${pct(v.accuracy)} of ${v.n}${delta(v.accuracy, b?.byGroup?.[k]?.accuracy)}`).join('  ')] : []),
    '  label             support  recall      precision',
    ...Object.entries(m.byLabel).map(([l, v]) => `  ${l.padEnd(17)} ${String(v.support).padStart(7)}  ${pct(v.recall)}${delta(v.recall, b?.byLabel[l]?.recall).padEnd(6)}  ${pct(v.precision)}${delta(v.precision, b?.byLabel[l]?.precision)}`),
    '  confusion (expected → predicted):',
    ...Object.entries(m.confusion).map(([e, row]) => `    ${e.padEnd(17)} ${Object.entries(row).map(([pp, n]) => `${pp}:${n}`).join(' ')}`),
    `  draft quality ${pct(m.quality.score)}${delta(m.quality.score, b?.quality.score)} (${m.quality.passed}/${m.quality.checks})` +
      (Object.keys(m.quality.failures).length ? `  misses: ${Object.entries(m.quality.failures).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''),
  ];
  return lines.join('\n');
}
