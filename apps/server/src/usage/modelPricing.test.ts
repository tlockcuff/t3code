import { describe, expect, it } from "vite-plus/test";

import { estimateCostUsd } from "./modelPricing.ts";

describe("estimateCostUsd", () => {
  it("prices each token type at its own tier when the breakdown is known", () => {
    // Opus: input 15, output 75, cacheRead 1.5, cacheWrite 18.75 per MTok.
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
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

    expect(cacheRead).toBeCloseTo(1.5, 6);
    expect(freshInput).toBeCloseTo(15, 6);
    expect(cacheRead * 10).toBeCloseTo(freshInput, 6);
  });

  it("blends a breakdown-less total toward cache reads rather than 50/50 input+output", () => {
    // Regression: the old fallback was (input + output) / 2 = $45/MTok on Opus,
    // applied to totals that are ~96% cache reads. That overcharged by ~8x.
    const cost = estimateCostUsd({
      model: "claude-opus-4-8",
      totalTokens: 1_000_000,
    });

    const oldBlendedRate = (15 + 75) / 2;
    expect(cost).toBeLessThan(oldBlendedRate / 4);

    // Must still land above the pure cache-read floor — some of the mix is
    // genuine input/output.
    expect(cost).toBeGreaterThan(1.5);
  });

  it("prefers the exact breakdown over the blended fallback", () => {
    const withBreakdown = estimateCostUsd({
      model: "claude-opus-4-8",
      cachedInputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });

    // totalTokens is ignored entirely once any per-type count is present.
    expect(withBreakdown).toBeCloseTo(1.5, 6);
  });

  it("falls back to default rates for an unknown model", () => {
    const cost = estimateCostUsd({ model: "some-unreleased-model", inputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(3, 6);
  });
});
