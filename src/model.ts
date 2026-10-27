import fs from 'node:fs';
import { wrapLanguageModel, APICallError } from 'ai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { anthropic } from '@ai-sdk/anthropic';
import { durableCalls } from '@dbos-inc/vercel-ai';
import { DBOS } from '@dbos-inc/dbos-sdk';

// Every model call becomes a DBOS step: its output is checkpointed, so after a crash the
// recovered workflow replays completed calls from Postgres instead of paying for them again.
export function agentModel(modelId: string): LanguageModel {
  const base = process.env.ANTHROPIC_API_KEY ? anthropic(modelId) : scriptedMock();
  return wrapLanguageModel({
    model: base,
    middleware: durableCalls({ retriesAllowed: true, maxAttempts: 3, intervalSeconds: 1, timeoutMS: 60_000 }),
  });
}

// Deterministic stand-in for the model when no API key is present. It calls the real tools
// (MCP + ours) in the order the spike agent's instructions ask for. Each invocation is appended
// to MOCK_CALL_LOG so the failure suite can count how many model calls were actually paid for.
function scriptedMock() {
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  };
  let seq = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'scripted-spike',
    doGenerate: async (options) => {
      const turn = options.prompt.filter((m) => m.role === 'assistant').length;
      const runTag = `${process.pid}:${++seq}`;
      if (process.env.MOCK_CALL_LOG) fs.appendFileSync(process.env.MOCK_CALL_LOG, `${Date.now()} wf=${DBOS.workflowID} turn=${turn} ${runTag}\n`);
      const delay = Number(process.env.MOCK_DELAY_MS ?? 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (process.env.MOCK_FAIL === 'auth') {
        throw new APICallError({ message: 'invalid x-api-key', url: 'mock://', requestBodyValues: {}, statusCode: 401, isRetryable: false });
      }
      if (process.env.MOCK_FAIL === 'overloaded') {
        throw new APICallError({ message: 'overloaded', url: 'mock://', requestBodyValues: {}, statusCode: 529, isRetryable: true });
      }

      // Calendar Prep paths: structured ranking (JSON response format) and the deeper-prep text pass.
      const promptText = options.prompt
        .map((m) => (Array.isArray(m.content) ? (m.content as unknown[]) : [m.content]))
        .flat()
        .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
        .join('\n');
      const stop = (text: string) => ({
        content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'end_turn' }, usage, warnings: [],
      });
      if (options.responseFormat?.type === 'json') return stop(JSON.stringify(mockRanking(promptText)));
      if (promptText.includes('<deeper>')) {
        // Echo the context lines so tests can see what deeper prep was given.
        const vc = /Video call: (.*)\.\n/.exec(promptText)?.[1];
        const hold = /Prep hold: (.*)\.\n/.exec(promptText)?.[1];
        return stop(`## Context\nMock deeper prep.\nVideo: ${vc}\nHold: ${hold}\n## Questions to ask\n- What does success look like?`);
      }

      const call = (id: string, toolName: string, input: unknown) => ({
        type: 'tool-call' as const,
        toolCallId: `t${turn}-${id}`,
        toolName,
        input: JSON.stringify(input),
      });
      const toolCalls = (content: ReturnType<typeof call>[]) => ({
        content,
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
        usage,
        warnings: [],
      });

      switch (turn) {
        case 0:
          return toolCalls([call('a', 'lookup_contact', { handle: 'ada' })]);
        case 1:
          return toolCalls([call('a', 'read_state', { key: 'last_seen_contact' })]);
        case 2:
          return toolCalls([
            call('a', 'propose_action', { proposal: { action: 'crm.note', target: 'ada@example.com', note: 'Spike follow-up' } }),
            call('b', 'propose_action', {
              proposal: { action: 'email.draft', target: 'ada@example.com', subject: 'Checking in', body: 'Hi Ada — following up.' },
            }),
            call('c', 'propose_action', {
              proposal: {
                action: 'calendar.hold', target: 'ada@example.com', title: 'Ada / Rone sync',
                start: '2026-11-02T17:00:00Z', durationMinutes: 30,
              },
            }),
          ]);
        case 3:
          return toolCalls([call('a', 'write_state', { key: 'last_seen_contact', value: { handle: 'ada', email: 'ada@example.com' } })]);
        default:
          return {
            content: [{ type: 'text' as const, text: 'Looked up Ada, proposed 3 actions, recorded last_seen_contact.' }],
            finishReason: { unified: 'stop' as const, raw: 'end_turn' },
            usage,
            warnings: [],
          };
      }
    },
  });
}

// Picks events with outside attendees or linked docs (what a sensible ranker would), holds for doc-heavy ones.
function mockRanking(prompt: string) {
  const m = /<events>([\s\S]*)<\/events>/.exec(prompt);
  const events = (m ? JSON.parse(m[1]) : []) as { ref: string; title: string; externalAttendees: number; docLinks: string[] }[];
  const items = events
    .filter((e) => e.externalAttendees > 0 || e.docLinks.length > 0)
    .map((e) => ({
      ref: e.ref,
      why: `${e.title}: ${e.externalAttendees ? 'outside attendees' : 'linked material'} worth a look first.`,
      prep: ['Skim the linked material', 'Decide the one outcome you want'],
      hold: e.docLinks.length ? { idealMinutes: 45, minimumMinutes: 20, preferredLeadMinutes: 30 } : null,
    }));
  return { headline: `${items.length} worth preparing for`, items };
}
