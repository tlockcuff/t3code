import type {
  OrchestrationContextUsageThread,
  ServerProvider,
  ServerProviderUsage,
} from "@t3tools/contracts";

import { formatContextWindowTokens } from "../../lib/contextWindow";
import { resolveUsagePlanLabel } from "@t3tools/client-runtime/state/provider-usage";

export type ContextUsageProjectGroup = {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly threads: ReadonlyArray<OrchestrationContextUsageThread>;
  readonly threadCount: number;
  readonly totalUsedTokens: number;
  readonly totalProcessedTokens: number;
  readonly maxFillPercent: number | null;
  /** Most recent thread activity in this project, used to order the groups. */
  readonly lastUpdatedAt: string;
};

export type ProviderUsageDetailEntry = {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly planLabel: string | undefined;
  readonly usage: ServerProviderUsage | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
};

export function usedFillPercent(usedTokens: number, maxTokens: number | null): number | null {
  if (maxTokens === null || maxTokens <= 0 || !Number.isFinite(usedTokens) || usedTokens < 0) {
    return null;
  }
  return Math.min(100, (usedTokens / maxTokens) * 100);
}

export function formatFillPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 99.5) return "100%";
  if (value < 10) return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(value)}%`;
}

export function formatContextUsageTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return formatContextWindowTokens(value);
}

export function groupContextUsageByProject(
  threads: ReadonlyArray<OrchestrationContextUsageThread>,
): ReadonlyArray<ContextUsageProjectGroup> {
  const groups = new Map<string, ContextUsageProjectGroup>();
  for (const thread of threads) {
    const existing = groups.get(thread.projectId);
    const fill = usedFillPercent(thread.usedTokens, thread.maxTokens);
    if (!existing) {
      groups.set(thread.projectId, {
        projectId: thread.projectId,
        projectTitle: thread.projectTitle,
        threads: [thread],
        threadCount: 1,
        totalUsedTokens: thread.usedTokens,
        totalProcessedTokens: thread.totalProcessedTokens ?? 0,
        maxFillPercent: fill,
        lastUpdatedAt: thread.updatedAt,
      });
      continue;
    }
    groups.set(thread.projectId, {
      ...existing,
      threads: [...existing.threads, thread],
      threadCount: existing.threadCount + 1,
      totalUsedTokens: existing.totalUsedTokens + thread.usedTokens,
      totalProcessedTokens: existing.totalProcessedTokens + (thread.totalProcessedTokens ?? 0),
      maxFillPercent:
        fill === null
          ? existing.maxFillPercent
          : existing.maxFillPercent === null
            ? fill
            : Math.max(existing.maxFillPercent, fill),
      lastUpdatedAt:
        Date.parse(thread.updatedAt) > Date.parse(existing.lastUpdatedAt)
          ? thread.updatedAt
          : existing.lastUpdatedAt,
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      threads: [...group.threads].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    }))
    .sort((a, b) => {
      const activityDelta = Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt);
      if (activityDelta !== 0) return activityDelta;
      return a.projectTitle.localeCompare(b.projectTitle);
    });
}

export function getProviderUsageDetailEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderUsageDetailEntry> {
  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName?.trim() || provider.driver,
      planLabel: resolveUsagePlanLabel(provider),
      usage: provider.usage,
      enabled: provider.enabled,
      installed: provider.installed,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function formatEstimatedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return "$0.00";
  }
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  if (value < 1_000) return `$${Math.round(value)}`;
  return `$${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
}

export function sharePercent(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0 || part <= 0) return 0;
  return Math.min(100, (part / total) * 100);
}

/** Short label for source paths / URLs shown under provider history. */
export function shortenUsageSourceLabel(source: string | undefined): string | undefined {
  const trimmed = source?.trim();
  if (!trimmed) return undefined;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      const host = url.hostname.replace(/^www\./, "");
      const segments = url.pathname.split("/").filter(Boolean);
      const leaf = segments.length > 0 ? segments[segments.length - 1] : undefined;
      return leaf ? `${host}/${leaf}` : host;
    }
  } catch {
    // Fall through to path shortening.
  }
  const normalized = trimmed.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return trimmed;
  return `…/${parts.slice(-2).join("/")}`;
}

export function machineProviderDriver(provider: string): string | null {
  switch (provider) {
    case "claude":
    case "claudeAgent":
      return "claudeAgent";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

export type HistoryWindowKey = "today" | "yesterday" | "last7Days" | "last30Days";

export const HISTORY_WINDOW_META: ReadonlyArray<{
  readonly key: HistoryWindowKey;
  readonly label: string;
  readonly shortLabel: string;
}> = [
  { key: "today", label: "Today", shortLabel: "Today" },
  { key: "yesterday", label: "Yesterday", shortLabel: "Yday" },
  { key: "last7Days", label: "Last 7 days", shortLabel: "7d" },
  { key: "last30Days", label: "Last 30 days", shortLabel: "30d" },
];

export type HistoryWindowTotals = {
  readonly today: { readonly tokens: number; readonly estimatedCostUsd: number };
  readonly yesterday: { readonly tokens: number; readonly estimatedCostUsd: number };
  readonly last7Days: { readonly tokens: number; readonly estimatedCostUsd: number };
  readonly last30Days: { readonly tokens: number; readonly estimatedCostUsd: number };
};

function dayOffsetUtc(daysAgo: number, nowMs = Date.now()): string {
  const date = new Date(nowMs);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

export function summarizeHistoryWindows(
  rows: ReadonlyArray<{
    readonly day: string;
    readonly totalTokens: number;
    readonly estimatedCostUsd: number;
  }>,
  nowMs = Date.now(),
): HistoryWindowTotals {
  const today = dayOffsetUtc(0, nowMs);
  const yesterday = dayOffsetUtc(1, nowMs);
  const from7 = dayOffsetUtc(6, nowMs);
  const from30 = dayOffsetUtc(29, nowMs);

  const empty = { tokens: 0, estimatedCostUsd: 0 };
  const result = {
    today: { ...empty },
    yesterday: { ...empty },
    last7Days: { ...empty },
    last30Days: { ...empty },
  };

  for (const row of rows) {
    if (row.day === today) {
      result.today.tokens += row.totalTokens;
      result.today.estimatedCostUsd += row.estimatedCostUsd;
    } else if (row.day === yesterday) {
      result.yesterday.tokens += row.totalTokens;
      result.yesterday.estimatedCostUsd += row.estimatedCostUsd;
    }
    if (row.day >= from7 && row.day <= today) {
      result.last7Days.tokens += row.totalTokens;
      result.last7Days.estimatedCostUsd += row.estimatedCostUsd;
    }
    if (row.day >= from30 && row.day <= today) {
      result.last30Days.tokens += row.totalTokens;
      result.last30Days.estimatedCostUsd += row.estimatedCostUsd;
    }
  }

  return result;
}

export type ProviderHistorySummary = {
  readonly key: string;
  readonly label: string;
  readonly windows: HistoryWindowTotals;
  readonly status?: "ok" | "missing" | "error";
  readonly detail?: string;
  readonly sourcePath?: string;
};

export function machineProviderLabel(provider: string): string {
  switch (provider) {
    case "claude":
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    case "unknown":
    case "Unknown":
      return "Unknown";
    default:
      return provider;
  }
}

export function summarizeMachineUsageByProvider(
  sources: ReadonlyArray<{
    readonly provider: string;
    readonly status: "ok" | "missing" | "error";
    readonly error?: string | undefined;
    readonly sourcePath?: string | undefined;
    readonly daily: ReadonlyArray<{
      readonly day: string;
      readonly totalTokens: number;
      readonly estimatedCostUsd: number;
    }>;
  }>,
  nowMs = Date.now(),
): ReadonlyArray<ProviderHistorySummary> {
  return sources
    .map((source) => {
      const windows = summarizeHistoryWindows(source.status === "ok" ? source.daily : [], nowMs);
      const detail =
        source.status === "ok"
          ? `${source.daily.length} day/model row${source.daily.length === 1 ? "" : "s"}`
          : source.status === "missing"
            ? "Local historical spend data not found"
            : (source.error ?? "Error reading local data");
      return {
        key: source.provider,
        label: machineProviderLabel(source.provider),
        windows,
        status: source.status,
        detail,
        ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
      };
    })
    .sort((a, b) => {
      const spendDelta =
        b.windows.last30Days.estimatedCostUsd - a.windows.last30Days.estimatedCostUsd;
      if (spendDelta !== 0) return spendDelta;
      return a.label.localeCompare(b.label);
    });
}

export function summarizeLedgerByProvider(
  rows: ReadonlyArray<{
    readonly day: string;
    readonly totalTokens: number;
    readonly estimatedCostUsd: number;
    readonly providerName: string | null;
  }>,
  nowMs = Date.now(),
): ReadonlyArray<ProviderHistorySummary> {
  const byProvider = new Map<
    string,
    Array<{ day: string; totalTokens: number; estimatedCostUsd: number }>
  >();
  for (const row of rows) {
    const key = row.providerName?.trim() || "unknown";
    const list = byProvider.get(key) ?? [];
    list.push({
      day: row.day,
      totalTokens: row.totalTokens,
      estimatedCostUsd: row.estimatedCostUsd,
    });
    byProvider.set(key, list);
  }

  return [...byProvider.entries()]
    .map(([key, providerRows]) => ({
      key,
      label: machineProviderLabel(key),
      windows: summarizeHistoryWindows(providerRows, nowMs),
      status: "ok" as const,
    }))
    .sort((a, b) => b.windows.last30Days.tokens - a.windows.last30Days.tokens);
}
