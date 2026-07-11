import { describe, expect, it } from "vite-plus/test";

import { computeTokenUsageDelta, dayKeyFromIso } from "./tokenUsageDelta.ts";
import { estimateCostUsd, roundUsd } from "./modelPricing.ts";

describe("tokenUsageDelta", () => {
  it("diffs totalProcessedTokens against the cursor", () => {
    const result = computeTokenUsageDelta(
      {
        totalProcessedTokens: 5_000,
        lastInputTokens: 4_000,
        lastCachedInputTokens: 1_000,
        lastOutputTokens: 500,
        lastUsedTokens: 4_500,
      },
      { lastTotalProcessed: 1_000 },
    );
    expect(result?.delta.totalTokens).toBe(4_000);
    expect(result?.delta.inputTokens).toBe(3_000);
    expect(result?.delta.cachedInputTokens).toBe(1_000);
    expect(result?.delta.outputTokens).toBe(500);
    expect(result?.nextCursor.lastTotalProcessed).toBe(5_000);
  });

  it("skips fill-only updates without totalProcessedTokens", () => {
    expect(
      computeTokenUsageDelta(
        {
          lastUsedTokens: 12_000,
          inputTokens: 11_000,
          outputTokens: 1_000,
        },
        null,
      ),
    ).toBeNull();
  });

  it("moves the cursor on reset without writing a negative delta", () => {
    const result = computeTokenUsageDelta(
      { totalProcessedTokens: 100 },
      { lastTotalProcessed: 5_000 },
    );
    expect(result?.delta.totalTokens).toBe(0);
    expect(result?.nextCursor.lastTotalProcessed).toBe(100);
  });

  it("formats UTC day keys", () => {
    expect(dayKeyFromIso("2026-07-10T15:49:10.732Z")).toBe("2026-07-10");
  });
});

describe("modelPricing", () => {
  it("estimates opus spend from breakdown", () => {
    const cost = estimateCostUsd({
      model: "claude-opus-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    expect(roundUsd(cost)).toBe(22.5);
  });

  it("falls back to blended pricing for totals-only rows", () => {
    const cost = estimateCostUsd({
      model: "claude-sonnet-4-6",
      totalTokens: 1_000_000,
    });
    expect(cost).toBeGreaterThan(0);
  });
});
