export const MODEL_PRICING_VERSION = "2026-07-16";

export type ModelPricingRates = {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  /** 5-minute ephemeral cache write rate (Anthropic default). */
  readonly cacheWritePerMTok: number;
  /**
   * 1-hour ephemeral cache write rate. When omitted, 1h writes bill at
   * 2× the plain input rate (OpenUsage / ccusage rule).
   */
  readonly cacheWrite1hPerMTok?: number;
  readonly fastMultiplier?: number;
};

export type TokenCostInput = {
  readonly model?: string | null;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  /** 1-hour cache write tokens (priced separately when present). */
  readonly cacheWrite1hTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  /** Claude fast-mode requests (`usage.speed === "fast"`). */
  readonly isFast?: boolean;
  /**
   * When a log line already carries API cost (Claude `costUSD`), use it
   * instead of re-estimating from token buckets.
   */
  readonly costUsd?: number | null;
  /** When breakdown is unknown, price this as blended input. */
  readonly totalTokens?: number;
};

const DEFAULT_RATES: ModelPricingRates = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
};

/**
 * API-equivalent list prices (USD / 1M tokens). Subscription bills differ.
 *
 * Rates aligned with OpenUsage's LiteLLM / models.dev catalogs (2026-07).
 * Order matters: more specific model generations first.
 */
const MODEL_RATES: ReadonlyArray<{ readonly match: RegExp; readonly rates: ModelPricingRates }> = [
  {
    // Claude Fable — LiteLLM/models.dev: $10 / $50.
    match: /claude-fable|fable-5/i,
    rates: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 1,
      cacheWritePerMTok: 12.5,
    },
  },
  {
    // Opus 4.7 / 4.8 are $5 / $25 (not the older $15 / $75 Opus 4 list).
    match: /claude-opus-4-[78]|opus-4-[78]|claude-opus-4\.[78]/i,
    rates: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      fastMultiplier: 2,
    },
  },
  {
    // Older Opus 4 / 4.1 / 4.5 list prices.
    match: /claude-opus-4|claude-4-opus|opus-4/i,
    rates: {
      inputPerMTok: 15,
      outputPerMTok: 75,
      cacheReadPerMTok: 1.5,
      cacheWritePerMTok: 18.75,
    },
  },
  {
    match: /claude-sonnet-5|claude-sonnet-4|claude-4-sonnet|sonnet-5|sonnet-4/i,
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
  if (typeof input.costUsd === "number" && Number.isFinite(input.costUsd) && input.costUsd >= 0) {
    return input.costUsd;
  }

  const rates = resolveModelPricing(input.model);
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const cachedInputTokens = Math.max(0, input.cachedInputTokens ?? 0);
  const cacheWrite5m = Math.max(0, input.cacheWriteTokens ?? 0);
  const cacheWrite1h = Math.max(0, input.cacheWrite1hTokens ?? 0);
  const outputTokens = Math.max(0, (input.outputTokens ?? 0) + (input.reasoningOutputTokens ?? 0));
  const known = inputTokens + cachedInputTokens + cacheWrite5m + cacheWrite1h + outputTokens;

  const cacheWrite1hRate = rates.cacheWrite1hPerMTok ?? rates.inputPerMTok * 2;

  let cost: number;
  if (known > 0) {
    cost =
      tokensToUsd(inputTokens, rates.inputPerMTok) +
      tokensToUsd(cachedInputTokens, rates.cacheReadPerMTok) +
      tokensToUsd(cacheWrite5m, rates.cacheWritePerMTok) +
      tokensToUsd(cacheWrite1h, cacheWrite1hRate) +
      tokensToUsd(outputTokens, rates.outputPerMTok);
  } else {
    const total = Math.max(0, input.totalTokens ?? 0);
    cost = tokensToUsd(total, blendedRatePerMTok(rates));
  }

  const fastMultiplier = input.isFast === true ? (rates.fastMultiplier ?? 1) : 1;
  return cost * fastMultiplier;
}

/**
 * Rate for a token total with no breakdown (legacy Claude `dailyModelTokens`).
 *
 * Cache reads dominate agentic totals; old 50/50 input+output blends overcharged.
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
