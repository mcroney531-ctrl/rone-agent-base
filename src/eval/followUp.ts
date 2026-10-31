// Follow-up Tracker eval suite: the detection judgment (is the owner now waiting on someone? by when?) and
// the nudge text, through the agent's real code: sentFeatures() → detectWaiting() → draftNudge().
// No Gmail; sent mail is synthetic. Critical: the owner's own promise is never tracked as waiting on them
// (mustNotBe), and a nudge is sender-facing, adds no facts, and has at most one placeholder.
import fs from 'node:fs';
import { z } from 'zod';
import type pg from 'pg';
import { plainModel } from '../model.js';
import type { MailMessage } from '../connections/gmail.js';
import { detectPrompt, detectWaiting, DetectSchema, draftNudge, nudgePrompt, NudgeSchema, sentFeatures, type SentFeatures } from '../followUp.js';
import { ownerFacing, placeholders, unsupportedFacts } from './inboxTriage.js';
import { agentConfig, sha, type Check, type Provenance, type ScenarioResult, type Split, type Suite } from './harness.js';

export const EVALUATOR_VERSION = '2'; // 2: a date that isn't a reply-by date must not anchor the timer (critical)
const CORPUS = new URL('../../evals/follow-up/corpus.json', import.meta.url);
const OWNER = 'rone@example.com';
const TZ = 'America/New_York';
const Dir = z.enum(['waiting_on_them', 'owner_promise', 'none']);

const Scenario = z.object({
  id: z.string(), split: z.enum(['dev', 'holdout']),
  sent: z.object({ to: z.string(), subject: z.string(), body: z.string(), sentAt: z.string() }),
  expect: z.object({
    categories: z.array(Dir).min(1), mustNotBe: z.array(Dir).default([]),
    explicitDate: z.string().nullable().optional(),       // undefined = not checked; null = must be none
    nudge: z.boolean().default(false), note: z.string().optional(),
  }),
});
const Corpus = z.object({ version: z.string(), scenarios: z.array(Scenario) });
export function loadCorpus(file: URL | string = CORPUS) {
  const raw = fs.readFileSync(file, 'utf8');
  return { corpus: Corpus.parse(JSON.parse(raw)), hash: sha(raw) };
}

function toMessage(id: string, s: z.infer<typeof Scenario>['sent']): MailMessage {
  return {
    id, threadId: `t-${id}`, labelIds: ['SENT'], receivedAt: s.sentAt, from: `Rone <${OWNER}>`, fromName: 'Rone', fromAddr: OWNER, replyTo: null,
    to: s.to, cc: '', subject: s.subject, messageIdHeader: `<${id}@eval.local>`, references: null, listUnsubscribe: false, precedence: null,
    autoSubmitted: null, snippet: s.body.slice(0, 100), body: s.body,
  };
}

export function followUpSuite(db: pg.Pool, opts: { corpusFile?: URL | string } = {}): Suite {
  const { corpus, hash } = loadCorpus(opts.corpusFile);
  const agent = () => agentConfig(db, 'follow-up-tracker');
  return {
    name: 'follow-up',
    labels: Dir.options,
    async provenance(): Promise<Provenance> {
      const a = await agent();
      const probe = { counterpart: '', subject: '', expects: '', lastOwnerText: '', lastOwnerDate: '', nudges: 0 };
      return {
        promptHash: sha(`${a.instructions}\n${detectPrompt('<owner>', [])}\n${nudgePrompt(probe)}`),
        model: a.model,
        modelConfig: { provider: plainModel(a.model).provider, temperature: 'provider default' },
        schemaVersion: sha(JSON.stringify([z.toJSONSchema(DetectSchema), z.toJSONSchema(NudgeSchema)])),
        corpusVersion: corpus.version, corpusHash: hash, evaluatorVersion: EVALUATOR_VERSION,
      };
    },
    async run(splits: Split[]): Promise<ScenarioResult[]> {
      const a = await agent();
      const { model } = plainModel(a.model);
      const picked = corpus.scenarios.filter((s) => splits.includes(s.split));
      const feats = picked.map((s) => ({ s, f: sentFeatures(toMessage(s.id, s.sent), OWNER, TZ) as SentFeatures }));
      const detected = await detectWaiting(model, a.instructions, OWNER, feats.map((x) => x.f)); // one batch, as in production
      const out: ScenarioResult[] = [];
      for (const { s, f } of feats) {
        const d = detected.get(f.ref)!;
        const checks: Check[] = [
          { id: 'output_valid', critical: true, pass: d.returned },
          { id: 'must_not_be', critical: true, pass: !s.expect.mustNotBe.includes(d.direction), detail: s.expect.mustNotBe.includes(d.direction) ? d.direction : undefined },
        ];
        if (s.expect.explicitDate !== undefined && d.direction === 'waiting_on_them') {
          // A named date becomes the timer anchor only when the message asks them to reply/deliver by it.
          // Anchoring on a meeting date or "I'll wait until Friday" is critical; missing or misreading a real one is reported.
          if (s.expect.explicitDate === null) checks.push({ id: 'no_false_date_anchor', critical: true, pass: d.explicitDate === null, detail: d.explicitDate ? `anchored on ${d.explicitDate}` : undefined });
          else checks.push({ id: 'explicit_date', critical: false, pass: d.explicitDate === s.expect.explicitDate, detail: `${d.explicitDate} vs ${s.expect.explicitDate}` });
        }
        let nudge: { draft: string; ownerNote: string | null } | null = null;
        if (s.expect.nudge) {
          nudge = await draftNudge(model, a.instructions, {
            counterpart: f.toName ?? f.to[0], subject: f.subject, expects: d.expects, lastOwnerText: s.sent.body, lastOwnerDate: f.sentLocal.slice(-10), nudges: 0,
          });
          const toOwner = ownerFacing(nudge.draft);
          const facts = unsupportedFacts(nudge.draft, `${s.sent.subject} ${s.sent.body} ${s.sent.to}`);
          checks.push({ id: 'nudge_sender_facing', critical: true, pass: !toOwner.length, detail: toOwner.join(' | ') || undefined });
          checks.push({ id: 'nudge_no_unsupported_facts', critical: true, pass: !facts.length, detail: facts.join(', ') || undefined });
          checks.push({ id: 'nudge_max_one_placeholder', critical: true, pass: placeholders(nudge.draft) <= 1 });
          checks.push({ id: 'nudge_short', critical: false, pass: nudge.draft.split(/(?<=[.!?])\s+/).filter(Boolean).length <= 3 });
        }
        out.push({
          id: s.id, split: s.split, expected: { acceptable: s.expect.categories, ...s.expect },
          output: { ...d, nudge }, predicted: d.direction, checks,
        });
      }
      return out;
    },
  };
}
