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
