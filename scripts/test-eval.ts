// Eval harness (src/eval/): the checks, the corpus, and a full recorded run against the scripted model.
// The real-model run happens on Railway (the `eval` service); this proves the machinery, not the prompt.
// Usage (Postgres at PG_ADMIN_URL): npx tsx scripts/test-eval.ts
import fs from 'node:fs';
import path from 'node:path';
import { freshDb } from './lib.js';

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!cond) failures.push(name);
}

const { url, db } = await freshDb('spike_eval');
process.env.DATABASE_URL = url;
delete process.env.ANTHROPIC_API_KEY; // the scripted model, never a paid one, in CI
const { commitsToDeadline, ownerFacing, placeholders, unsupportedFacts, loadCorpus, inboxTriageSuite } = await import('../src/eval/inboxTriage.js');
const { runSuite, score } = await import('../src/eval/harness.js');

// ---- checks ----
check('deadline: adopting the sender\'s deadline is a commitment', commitsToDeadline('Yes, I\'ll send the notes by Friday.', 'Friday')
  && commitsToDeadline('Sure. I can have them to you by Friday!', 'Friday') && commitsToDeadline('You\'ll have them Friday.', 'Friday'));
check('deadline: acknowledging it is not', !commitsToDeadline('Yes, I can send the notes over. I saw your Friday deadline and will confirm timing.', 'Friday')
  && !commitsToDeadline('Yes, I can send the notes over. I\'ll confirm timing shortly.', 'Friday')
  && !commitsToDeadline('I\'ll send them by [day].', 'Friday'));
check('placeholders are counted', placeholders('Works for me at [time] on [day].') === 2 && placeholders('Yes, at [time].') === 1 && placeholders('Sure!') === 0);
check('sender-facing: a bracket asking or telling the owner something is caught', ownerFacing('Happy to look at slides 4-9. [Can you make that deadline?]').length === 1
  && ownerFacing('Happy to help. [when you can send them]').length === 1 && ownerFacing('Sure. Note to self: confirm with Dana first.').length === 1);
check('sender-facing: fill-in slots and one choice slot are fine', ownerFacing('Thanks for the invite! [Yes, I\'ll be there / Sorry, I can\'t make it].').length === 0
  && ownerFacing('[Yes, you\'re welcome to borrow it / Sorry, I can\'t lend it this weekend]. Let me know when.').length === 0
  && ownerFacing('Works for me at [time].').length === 0 && ownerFacing('Thanks, you made my day.').length === 0);
{
  const { features } = await import('../src/inboxTriage.js');
  const msg = (to: string, cc: string) => ({ id: 'x', threadId: 't', labelIds: ['INBOX'], receivedAt: '', from: 'a@b.c', fromName: null, fromAddr: 'a@b.c', replyTo: null,
    to, cc, subject: 's', messageIdHeader: null, references: null, listUnsubscribe: false, precedence: null, autoSubmitted: null, snippet: '', body: '' });
  check('addressed: direct recipient, cc only, or neither', features(msg('Me <me@x.com>', ''), 'me@x.com').addressed === 'to'
    && features(msg('m@b.co', 'Me <ME@x.com>'), 'me@x.com').addressed === 'cc' && features(msg('list@x.com', ''), 'me@x.com').addressed === 'other');
}
check('unsupported facts: invented days, times and numbers are caught', JSON.stringify(unsupportedFacts('How about Tuesday at 3pm? My rate is $1,200.', 'Do you have time next week?'))
  === JSON.stringify(['tuesday', '3pm', '1,200']), unsupportedFacts('How about Tuesday at 3pm? My rate is $1,200.', 'Do you have time next week?'));
check('unsupported facts: facts from the email and [placeholders] are fine', unsupportedFacts('Yes, Thursday works. Around [time]?', 'Free for lunch Thursday?').length === 0);

// ---- corpus ----
const { corpus } = loadCorpus();
const dev = corpus.scenarios.filter((s) => s.split === 'dev').length;
const holdout = corpus.scenarios.filter((s) => s.split === 'holdout').length;
check('corpus v1 parses: 30-40 dev, 10-15 holdout', dev >= 30 && dev <= 40 && holdout >= 10 && holdout <= 15, { dev, holdout });
check('corpus covers deadlines, injection, ambiguity and no-reply alerts',
  corpus.scenarios.some((s) => s.expect.deadline) && corpus.scenarios.filter((s) => s.expect.injection).length >= 2
  && corpus.scenarios.some((s) => s.expect.categories.length > 1) && corpus.scenarios.some((s) => s.email.autoSubmitted && s.expect.categories[0] === 'action_required'));

// ---- scoring: acceptable sets, not one exact label ----
const m = score([
  { id: 'a', split: 'dev', expected: { acceptable: ['fyi', 'action_required'] }, output: {}, predicted: 'action_required', checks: [] },
  { id: 'b', split: 'dev', expected: { acceptable: ['needs_reply'] }, output: {}, predicted: 'fyi', checks: [{ id: 'x', critical: true, pass: false }] },
  { id: 'c', split: 'holdout', expected: { acceptable: ['needs_reply'] }, output: {}, predicted: 'needs_reply', checks: [{ id: 'short', critical: false, pass: false }] },
], ['needs_reply', 'action_required', 'fyi']);
check('scoring: an acceptable alternative counts as correct; recall uses the primary label', m.accuracy === 0.667 && m.byLabel.fyi.recall === 1
  && m.byLabel.needs_reply.recall === 0.5 && m.byLabel.action_required.precision === 1, m);
{
  const { checkScenario } = await import('../src/eval/inboxTriage.js');
  const inj = corpus.scenarios.find((s) => s.id === 'inject-wire')!;
  const f = { canReply: true } as never;
  const resisted = (o: object) => checkScenario(inj, f, { category: 'fyi', summary: 'Suspicious request', draft: null, returned: true, ...o }).find((c) => c.id === 'injection_resisted')!.pass;
  check('injection: fails only when obeyed (demanded text or demanded category), not on a plain misclassification',
    resisted({}) && resisted({ category: 'receipt' }) && resisted({ summary: 'Likely phishing: asks for a wire transfer' }) && resisted({ summary: 'Phishing: asks you to wire $5,000' }) && !resisted({ draft: 'I will wire $5,000 today.' }) && !resisted({ category: 'needs_reply' }));
}
check('scoring: critical failures are listed, quality is separate', m.critical.length === 1 && m.critical[0].scenario === 'b' && m.quality.score === 0, m);

// ---- a full recorded run (scripted model) ----
for (const f of ['001_ops_schema.sql', '003_connections.sql', '004_calendar_prep.sql', '005_attention.sql', '006_prep_holds.sql', '007_brief_view.sql',
  '008_push.sql', '009_push_deliveries.sql', '010_agent_pause.sql', '011_inbox_triage.sql', '012_evals.sql']) {
  await db.query(fs.readFileSync(path.resolve('sql', f), 'utf8'));
}
const { pool } = await import('../src/db.js');
try {
  const r1 = await runSuite(pool, inboxTriageSuite(pool), ['dev', 'holdout']);
  const run = (await db.query(`select * from ops.eval_runs where id = $1`, [r1.runId])).rows[0];
  check('run records full provenance', Boolean(run.git_commit && run.prompt_hash && run.model === 'claude-sonnet-5-5' && run.model_config?.provider === 'mock'
    && run.schema_version && run.corpus_version === '3' && run.corpus_hash && run.evaluator_version && run.finished_at), run);
  const results = (await db.query(`select split, count(*)::int n from ops.eval_results where run_id = $1 group by 1 order by 1`, [r1.runId])).rows;
  check('every scenario is recorded with its split', JSON.stringify(results) === JSON.stringify([{ split: 'dev', n: dev }, { split: 'holdout', n: holdout }]), results);
  check('status follows critical invariants (BLOCK), metrics are stored (REPORT)', run.status === (r1.metrics.critical.length ? 'failed' : 'passed')
    && run.critical_failures === r1.metrics.critical.length && run.metrics?.byLabel?.needs_reply, { status: run.status, critical: r1.metrics.critical });
  const promo = (await db.query(`select output from ops.eval_results where run_id = $1 and scenario_id = 'promo-sale'`, [r1.runId])).rows[0];
  check('Promotions mail takes the production heuristic path, not the model', promo?.output?.source === 'heuristic', promo);
  const r2 = await runSuite(pool, inboxTriageSuite(pool), ['dev', 'holdout']);
  check('the next run compares against the previous one', r2.baseline?.id === r1.runId && /baseline: #\d+/.test(r2.report), r2.report);
  const devOnly = await runSuite(pool, inboxTriageSuite(pool), ['dev']);
  check('a dev-only run does not take an all-splits run as its baseline', devOnly.baseline === null && devOnly.metrics.n === dev, devOnly.baseline);
  console.log(`\n${r2.report}\n`);
  // ---- Calendar Prep suite: an A/B of the same scenarios with and without retrieval ----
  const { calendarPrepSuite, loadCorpus: loadCal } = await import('../src/eval/calendarPrep.js');
  const cal = loadCal().corpus;
  const cp = await runSuite(pool, calendarPrepSuite(pool), ['dev', 'holdout']);
  check('calendar-prep: every scenario runs in both arms, reported per arm', cp.metrics.n === cal.scenarios.length * 2
    && cp.metrics.byGroup.with?.n === cal.scenarios.length && cp.metrics.byGroup.without?.n === cal.scenarios.length && /by arm: with/.test(cp.report), cp.metrics.byGroup);
  check('calendar-prep: retrieval context is what surfaces the email/history facts (with > without)',
    cp.metrics.byGroup.with.accuracy > cp.metrics.byGroup.without.accuracy, cp.metrics.byGroup);
  check('calendar-prep: the scripted model cites only real sources (no critical failures)', cp.status === 'passed', cp.metrics.critical);
  console.log(`\n${cp.report}\n`);
} finally {
  await pool.end();
  await db.end();
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall eval checks passed');
process.exit(failures.length ? 1 : 0);
