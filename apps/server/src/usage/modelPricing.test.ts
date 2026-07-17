import { describe, expect, it } from "vite-plus/test";

import { estimateCostUsd } from "./modelPricing.ts";

describe("estimateCostUsd", () => {
  it("prices each token type at its own tier when the breakdown is known", () => {
    // Opus 4.8: input 5, output 25, cacheRead 0.5, cacheWrite 6.25 per MTok.
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
  });

  it("prices cache reads at a tenth of input, not at input rate", () => {
    const cacheRead = estimateCostUsd({
      model: "claude-opus-4-8",
      cachedInputTokens: 1_000_000,
    });
    const freshInput = estimateCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
    });

    expect(cacheRead).toBeCloseTo(0.5, 6);
    expect(freshInput).toBeCloseTo(5, 6);
    expect(cacheRead * 10).toBeCloseTo(freshInput, 6);
  });

  it("blends a breakdown-less total toward cache reads rather than 50/50 input+output", () => {
    // Regression: the old fallback was (input + output) / 2 applied to totals
    // that are ~96% cache reads — overcharged massively.
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      totalTokens: 1_000_000,
    });

    const oldBlendedRate = (5 + 25) / 2;
    expect(cost).toBeLessThan(oldBlendedRate / 4);

    // Must still land above the pure cache-read floor — some of the mix is
    // genuine input/output.
    expect(cost).toBeGreaterThan(0.5);
  });

  it("prefers the exact breakdown over the blended fallback", () => {
    const withBreakdown = estimateCostUsd({
      model: "claude-opus-4-8",
      cachedInputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });

    // totalTokens is ignored entirely once any per-type count is present.
    expect(withBreakdown).toBeCloseTo(0.5, 6);
  });

  it("falls back to default rates for an unknown model", () => {
    const cost = estimateCostUsd({ model: "some-unreleased-model", inputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3, 6);
  });

  it("uses carried costUSD instead of re-estimating tokens", () => {
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      costUsd: 0.42,
    });
    expect(cost).toBeCloseTo(0.42, 6);
  });

  it("prices 1h cache writes at 2x input when no explicit 1h rate", () => {
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      cacheWrite1hTokens: 1_000_000,
    });
    // Opus 4.8 input 5 → 1h write 10
    expect(cost).toBeCloseTo(10, 6);
  });

  it("prices Claude Fable and older Opus generations correctly", () => {
    expect(estimateCostUsd({ model: "claude-fable-5", inputTokens: 1_000_000 })).toBeCloseTo(10, 6);
    expect(
      estimateCostUsd({ model: "claude-opus-4-1-20250805", inputTokens: 1_000_000 }),
    ).toBeCloseTo(15, 6);
  });
});
