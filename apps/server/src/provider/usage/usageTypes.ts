import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";

export type UsageFetchResult = ServerProviderUsage;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function remainingPercent(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

export function usageWindow(input: {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly windowMinutes?: number | null;
  readonly resetsAt?: number | null;
}): ServerProviderUsageWindow {
  return {
    id: input.id,
    label: input.label,
    usedPercent: clampPercent(input.usedPercent),
    ...(input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {}),
    ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
  };
}

export function usageOk(input: {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
  readonly updatedAt: string;
  readonly planLabel?: string;
  readonly source?: string;
}): ServerProviderUsage {
  return {
    status: "ok",
    windows: [...input.windows],
    updatedAt: input.updatedAt,
    ...(input.planLabel ? { planLabel: input.planLabel } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
}

export function usageUnavailable(input: {
  readonly updatedAt: string;
  readonly error?: string;
  readonly source?: string;
}): ServerProviderUsage {
  return {
    status: "unavailable",
    windows: [],
    updatedAt: input.updatedAt,
    ...(input.error ? { error: input.error } : {}),
    ...(input.source ? { source: input.source } : {}),
  };
}

export function usageError(input: {
  readonly updatedAt: string;
  readonly error: string;
  readonly source?: string;
}): ServerProviderUsage {
  return {
    status: "error",
    windows: [],
    updatedAt: input.updatedAt,
    error: input.error,
    ...(input.source ? { source: input.source } : {}),
  };
}

export function parseIsoToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function unixSecondsToMs(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Codex resetsAt is unix seconds; treat values that look like ms as-is.
  return value > 1_000_000_000_000 ? value : value * 1000;
}
