export type TokenUsageDeltaInput = {
  readonly totalProcessedTokens?: number | null;
  readonly lastInputTokens?: number | null;
  readonly lastCachedInputTokens?: number | null;
  readonly lastOutputTokens?: number | null;
  readonly lastReasoningOutputTokens?: number | null;
  readonly lastUsedTokens?: number | null;
  /** Codex often mirrors last-turn breakdown into these fields. */
  readonly inputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly reasoningOutputTokens?: number | null;
};

export type TokenUsageDelta = {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
};

export type TokenUsageCursor = {
  readonly lastTotalProcessed: number;
};

function asNonNegativeInt(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function breakdownLooksLikeDelta(
  totalDelta: number,
  lastUsedTokens: number | null,
  partsSum: number,
): boolean {
  if (totalDelta <= 0) return false;
  if (lastUsedTokens !== null) {
    const skew = Math.abs(lastUsedTokens - totalDelta);
    if (skew <= Math.max(2_000, totalDelta * 0.15)) return true;
  }
  if (partsSum <= 0) return false;
  const skew = Math.abs(partsSum - totalDelta);
  return skew <= Math.max(2_000, totalDelta * 0.15);
}

/**
 * Compute a processed-token delta for the T3 usage ledger.
 *
 * Prefers cumulative `totalProcessedTokens` against a per-thread cursor.
 * Turn breakdowns are only trusted when `last*` (or Codex-mirrored) fields
 * roughly match that delta — otherwise store total-only with zeroed parts.
 */
export function computeTokenUsageDelta(
  payload: TokenUsageDeltaInput,
  cursor: TokenUsageCursor | null,
): { readonly delta: TokenUsageDelta; readonly nextCursor: TokenUsageCursor } | null {
  const total = asNonNegativeInt(payload.totalProcessedTokens);
  if (total === null) {
    return null;
  }

  const previous = cursor?.lastTotalProcessed ?? 0;
  if (total < previous) {
    // Session reset / provider quirk — move cursor forward without writing.
    return {
      delta: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      nextCursor: { lastTotalProcessed: total },
    };
  }

  const totalDelta = total - previous;
  if (totalDelta === 0) {
    return null;
  }

  const lastInput =
    asNonNegativeInt(payload.lastInputTokens) ?? asNonNegativeInt(payload.inputTokens);
  const lastCached =
    asNonNegativeInt(payload.lastCachedInputTokens) ??
    asNonNegativeInt(payload.cachedInputTokens) ??
    0;
  const lastOutput =
    asNonNegativeInt(payload.lastOutputTokens) ?? asNonNegativeInt(payload.outputTokens);
  const lastReasoning =
    asNonNegativeInt(payload.lastReasoningOutputTokens) ??
    asNonNegativeInt(payload.reasoningOutputTokens) ??
    0;
  const lastUsed = asNonNegativeInt(payload.lastUsedTokens);

  const rawInput = lastInput ?? 0;
  const nonCachedInput = Math.max(0, rawInput - lastCached);
  const partsSum = nonCachedInput + lastCached + (lastOutput ?? 0) + lastReasoning;

  const trustBreakdown =
    lastInput !== null &&
    lastOutput !== null &&
    breakdownLooksLikeDelta(totalDelta, lastUsed, partsSum);

  return {
    delta: {
      inputTokens: trustBreakdown ? nonCachedInput : 0,
      cachedInputTokens: trustBreakdown ? lastCached : 0,
      outputTokens: trustBreakdown ? (lastOutput ?? 0) : 0,
      reasoningOutputTokens: trustBreakdown ? lastReasoning : 0,
      totalTokens: totalDelta,
    },
    nextCursor: { lastTotalProcessed: total },
  };
}

export function dayKeyFromIso(iso: string): string {
  // IsoDateTime values are UTC; take the calendar day from the wire form.
  return iso.slice(0, 10);
}
