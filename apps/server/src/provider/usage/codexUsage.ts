import type { ServerProviderUsage } from "@t3tools/contracts";

import { usageOk, usageUnavailable, usageWindow, unixSecondsToMs } from "./usageTypes.ts";

type CodexRateLimitWindow = {
  readonly usedPercent?: number;
  readonly windowDurationMins?: number | null;
  readonly resetsAt?: number | null;
};

type CodexRateLimitSnapshot = {
  readonly primary?: CodexRateLimitWindow | null;
  readonly secondary?: CodexRateLimitWindow | null;
  readonly planType?: string | null;
  readonly credits?: {
    readonly balance?: string | null;
    readonly hasCredits?: boolean;
    readonly unlimited?: boolean;
  } | null;
};

type CodexRateLimitsResponse = {
  readonly rateLimits?: CodexRateLimitSnapshot | null;
};

function planLabelFromType(planType: string | null | undefined): string | undefined {
  if (!planType) return undefined;
  switch (planType) {
    case "free":
      return "Free";
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro Lite";
    case "team":
      return "Team";
    case "business":
    case "self_serve_business_usage_based":
      return "Business";
    case "enterprise":
    case "enterprise_cbp_usage_based":
      return "Enterprise";
    case "edu":
      return "Edu";
    default:
      return planType;
  }
}

function mapWindow(id: string, label: string, window: CodexRateLimitWindow | null | undefined) {
  if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) {
    return null;
  }
  return usageWindow({
    id,
    label,
    usedPercent: window.usedPercent,
    windowMinutes: window.windowDurationMins ?? null,
    resetsAt: unixSecondsToMs(window.resetsAt),
  });
}

export function mapCodexRateLimitsToUsage(
  response: CodexRateLimitsResponse | null | undefined,
  updatedAt: string,
): ServerProviderUsage {
  const snapshot = response?.rateLimits;
  if (!snapshot) {
    return usageUnavailable({
      updatedAt,
      error: "Codex did not return rate-limit data",
      source: "rpc",
    });
  }

  const windows = [
    mapWindow("primary", "Primary", snapshot.primary),
    mapWindow("secondary", "Secondary", snapshot.secondary),
  ].filter((window): window is NonNullable<typeof window> => window !== null);

  if (windows.length === 0) {
    return usageUnavailable({
      updatedAt,
      error: "Codex rate-limit windows unavailable",
      source: "rpc",
    });
  }

  const planLabel = planLabelFromType(snapshot.planType);
  return usageOk({
    windows,
    updatedAt,
    ...(planLabel ? { planLabel } : {}),
    source: "rpc",
  });
}
