import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY must be set');
}

export const anthropic = new Anthropic({ apiKey });

// USD per million tokens. Approximate — update as pricing changes.
// Used only for the runs.cost_usd estimate shown on the dashboard, not for billing.
const PRICING_PER_MTOK = {
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export function estimateCostUsd(model, inputTokens, outputTokens) {
  const rate = PRICING_PER_MTOK[model];
  if (!rate) return null;
  return (inputTokens / 1e6) * rate.input + (outputTokens / 1e6) * rate.output;
}
