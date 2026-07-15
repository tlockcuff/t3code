export const MODEL_PRICING_VERSION = "2026-07-10";

export type ModelPricingRates = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
};

export type TokenCostInput = {
  readonly model?: string | null;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  /** When breakdown is unknown, price this as blended input. */
  readonly totalTokens?: number;
};

const DEFAULT_RATES: ModelPricingRates = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

/** API-equivalent list prices (USD / 1M tokens). Subscription bills differ. */
const MODEL_RATES: ReadonlyArray<{ readonly match: RegExp; readonly rates: ModelPricingRates }> = [
  {
    match: /claude-opus-4|claude-4-opus|opus-4/i,
    rates: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheWritePerMTok: 18.75,
    },
  },
  {
    match: /claude-sonnet-4|claude-4-sonnet|sonnet-4/i,
    rates: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    },
  },
  {
    match: /claude-haiku|haiku/i,
    rates: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    },
  },
  {
    match: /gpt-5\.2|gpt-5|o3|o4|codex/i,
    rates: {
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.125,
      cacheWritePerMTok: 1.25,
    },
  },
  {
    match: /grok/i,
    rates: {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.75,
      cacheWritePerMTok: 3,
    },
  },
  {
    match: /gemini|flash/i,
    rates: {
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.03,
      cacheWritePerMTok: 0.3,
    },
  },
];

export function resolveModelPricing(model: string | null | undefined): ModelPricingRates {
  if (!model) return DEFAULT_RATES;
  for (const entry of MODEL_RATES) {
    if (entry.match.test(model)) return entry.rates;
  }
  return DEFAULT_RATES;
}

function tokensToUsd(tokens: number, perMTok: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(perMTok)) return 0;
  return (tokens / 1_000_000) * perMTok;
}

export function estimateCostUsd(input: TokenCostInput): number {
  const rates = resolveModelPricing(input.model);
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const cachedInputTokens = Math.max(0, input.cachedInputTokens ?? 0);
  const cacheWriteTokens = Math.max(0, input.cacheWriteTokens ?? 0);
  const outputTokens = Math.max(0, (input.outputTokens ?? 0) + (input.reasoningOutputTokens ?? 0));
  const known = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;

  if (known > 0) {
    return (
      tokensToUsd(inputTokens, rates.inputPerMTok) +
      tokensToUsd(cachedInputTokens, rates.cacheReadPerMTok) +
      tokensToUsd(cacheWriteTokens, rates.cacheWritePerMTok) +
      tokensToUsd(outputTokens, rates.outputPerMTok)
    );
  }

  const total = Math.max(0, input.totalTokens ?? 0);
  return tokensToUsd(total, blendedRatePerMTok(rates));
}

/**
 * Rate for a token total with no breakdown (Claude `dailyModelTokens`).
 *
 * The old blend was `(input + output) / 2`, which prices every token as if the
 * mix were half fresh input and half output. Agentic totals are nothing like
 * that: cache reads dominate, and they bill at a tenth of input. Measured over
 * this repo's own transcripts the split is ~96% cache read, ~3% cache write,
 * ~0.05% fresh input, ~0.2% output — so the old blend overcharged Opus totals
 * by roughly 8x ($45/MTok against a true ~$5.6/MTok).
 *
 * These weights are a coarse approximation of that observed mix. They are only
 * ever used when the real breakdown is unavailable; whenever a transcript
 * supplies per-type counts, the exact tiered path above runs instead.
 */
const BLEND_WEIGHTS = {
  cacheRead: 0.9,
  cacheWrite: 0.05,
  input: 0.02,
  output: 0.03,
} as const;

function blendedRatePerMTok(rates: ModelPricingRates): number {
  return (
    rates.cacheReadPerMTok * BLEND_WEIGHTS.cacheRead +
    rates.cacheWritePerMTok * BLEND_WEIGHTS.cacheWrite +
    rates.inputPerMTok * BLEND_WEIGHTS.input +
    rates.outputPerMTok * BLEND_WEIGHTS.output
  );
}

export function roundUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value < 0.01) return Number(value.toFixed(4));
  return Number(value.toFixed(2));
}
