// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalDate:off
import type { ServerProviderUsage } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { parseIsoToMs, usageError, usageOk, usageUnavailable, usageWindow } from "./usageTypes.ts";
import { withUsageCache } from "./usageCache.ts";

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.0";
const API_TIMEOUT_MS = 10_000;
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10_080;

type ClaudeOauthCredentials = {
  readonly accessToken: string;
  readonly subscriptionType?: string;
};

type ClaudeUsageBucket = {
  readonly utilization?: number | null;
  readonly resets_at?: string | null;
};

type ClaudeUsageLimitEntry = {
  readonly kind?: string;
  readonly group?: string;
  readonly percent?: number;
  readonly resets_at?: string | null;
  readonly scope?: {
    readonly model?: {
      readonly id?: string | null;
      readonly display_name?: string | null;
    } | null;
  } | null;
};

type ClaudeOauthUsageResponse = {
  readonly five_hour?: ClaudeUsageBucket | null;
  readonly seven_day?: ClaudeUsageBucket | null;
  readonly seven_day_opus?: ClaudeUsageBucket | null;
  readonly seven_day_sonnet?: ClaudeUsageBucket | null;
  readonly limits?: ReadonlyArray<ClaudeUsageLimitEntry> | null;
  readonly extra_usage?: {
    readonly is_enabled?: boolean;
    readonly utilization?: number | null;
  } | null;
};

function subscriptionLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const normalized = subscriptionType.toLowerCase();
  if (normalized.includes("max")) return "Max";
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("team")) return "Team";
  if (normalized.includes("enterprise")) return "Enterprise";
  return subscriptionType;
}

async function readClaudeOauthFromKeychain(): Promise<ClaudeOauthCredentials | null> {
  const platform = Effect.runSync(Effect.service(HostProcessPlatform));
  if (platform !== "darwin") return null;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  for (const service of ["Claude Code-credentials", "Claude Code"]) {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        {
          timeout: 3_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const parsed = JSON.parse(stdout) as {
        claudeAiOauth?: { accessToken?: string; subscriptionType?: string };
      };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token.length > 0) {
        return {
          accessToken: token,
          ...(typeof parsed.claudeAiOauth?.subscriptionType === "string"
            ? { subscriptionType: parsed.claudeAiOauth.subscriptionType }
            : {}),
        };
      }
    } catch {
      // try next service
    }
  }
  return null;
}

async function readClaudeOauthFromFile(): Promise<ClaudeOauthCredentials | null> {
  const NodeOS = await import("node:os");
  const NodePath = await import("node:path");
  const NodeFS = await import("node:fs/promises");
  const candidates = [
    NodePath.join(NodeOS.homedir(), ".claude", ".credentials.json"),
    NodePath.join(NodeOS.homedir(), ".config", "claude", ".credentials.json"),
  ];
  for (const path of candidates) {
    try {
      const raw = await NodeFS.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as {
        claudeAiOauth?: { accessToken?: string; subscriptionType?: string };
      };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token.length > 0) {
        return {
          accessToken: token,
          ...(typeof parsed.claudeAiOauth?.subscriptionType === "string"
            ? { subscriptionType: parsed.claudeAiOauth.subscriptionType }
            : {}),
        };
      }
    } catch {
      // try next path
    }
  }
  return null;
}

export async function readClaudeOauthCredentials(): Promise<ClaudeOauthCredentials | null> {
  return (await readClaudeOauthFromKeychain()) ?? (await readClaudeOauthFromFile());
}

function mapBucket(
  id: string,
  label: string,
  bucket: ClaudeUsageBucket | null | undefined,
  windowMinutes: number,
) {
  if (!bucket || typeof bucket.utilization !== "number" || !Number.isFinite(bucket.utilization)) {
    return null;
  }
  return usageWindow({
    id,
    label,
    usedPercent: bucket.utilization,
    windowMinutes,
    resetsAt: parseIsoToMs(bucket.resets_at),
  });
}

function mapScopedLimitWindows(
  limits: ReadonlyArray<ClaudeUsageLimitEntry> | null | undefined,
): Array<ReturnType<typeof usageWindow>> {
  if (!limits) return [];
  const windows: Array<ReturnType<typeof usageWindow>> = [];
  for (const [index, entry] of limits.entries()) {
    if (entry.kind !== "weekly_scoped") continue;
    if (typeof entry.percent !== "number" || !Number.isFinite(entry.percent)) continue;
    const modelName = entry.scope?.model?.display_name?.trim();
    if (!modelName) continue;
    windows.push(
      usageWindow({
        id: `weekly_scoped:${modelName.toLowerCase()}:${index}`,
        label: modelName,
        usedPercent: entry.percent,
        windowMinutes: SEVEN_DAY_MINUTES,
        resetsAt: parseIsoToMs(entry.resets_at),
      }),
    );
  }
  return windows;
}

function mapClaudeUsageResponse(
  data: ClaudeOauthUsageResponse,
  updatedAt: string,
  planLabel: string | undefined,
): ServerProviderUsage {
  const windows = [
    mapBucket("five_hour", "5-hour", data.five_hour, FIVE_HOUR_MINUTES),
    mapBucket("seven_day", "Weekly", data.seven_day, SEVEN_DAY_MINUTES),
    mapBucket("seven_day_opus", "Weekly Opus", data.seven_day_opus, SEVEN_DAY_MINUTES),
    mapBucket("seven_day_sonnet", "Weekly Sonnet", data.seven_day_sonnet, SEVEN_DAY_MINUTES),
    ...mapScopedLimitWindows(data.limits),
  ].filter((window): window is NonNullable<typeof window> => window !== null);

  if (data.extra_usage?.is_enabled && typeof data.extra_usage.utilization === "number") {
    windows.push(
      usageWindow({
        id: "extra_usage",
        label: "Extra usage",
        usedPercent: data.extra_usage.utilization,
        windowMinutes: null,
        resetsAt: null,
      }),
    );
  }

  if (windows.length === 0) {
    return usageUnavailable({
      updatedAt,
      error: "Claude usage response did not include rate-limit windows",
      source: "oauth",
    });
  }

  return usageOk({
    windows,
    updatedAt,
    ...(planLabel ? { planLabel } : {}),
    source: "oauth",
  });
}

export async function fetchClaudeUsage(input?: {
  readonly updatedAt?: string;
  readonly planLabel?: string;
}): Promise<ServerProviderUsage> {
  return withUsageCache("claude:v2", () => fetchClaudeUsageUncached(input));
}

async function fetchClaudeUsageUncached(input?: {
  readonly updatedAt?: string;
  readonly planLabel?: string;
}): Promise<ServerProviderUsage> {
  const updatedAt = input?.updatedAt ?? new Date().toISOString();
  try {
    const credentials = await readClaudeOauthCredentials();
    if (!credentials) {
      return usageUnavailable({
        updatedAt,
        error: "Not signed in to Claude subscription — run `claude auth login`",
        source: "oauth",
      });
    }

    const planLabel = input?.planLabel ?? subscriptionLabel(credentials.subscriptionType);
    const response = await fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return usageError({
        updatedAt,
        error: `Claude usage unauthorized (HTTP ${response.status})`,
        source: "oauth",
      });
    }
    if (response.status === 429) {
      return usageError({
        updatedAt,
        error: "Claude usage API rate-limited — try again shortly",
        source: "oauth",
      });
    }
    if (!response.ok) {
      return usageError({
        updatedAt,
        error: `Claude usage request failed (HTTP ${response.status})`,
        source: "oauth",
      });
    }
    const data = (await response.json()) as ClaudeOauthUsageResponse;
    return mapClaudeUsageResponse(data, updatedAt, planLabel);
  } catch (cause) {
    return usageError({
      updatedAt,
      error: cause instanceof Error ? cause.message : "Claude usage request failed",
      source: "oauth",
    });
  }
}
