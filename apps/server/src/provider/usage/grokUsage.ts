// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderUsage } from "@t3tools/contracts";

import { usageError, usageOk, usageUnavailable, usageWindow } from "./usageTypes.ts";
import { withUsageCache } from "./usageCache.ts";

const WEEKLY_WINDOW_MINUTES = 10_080;
const API_TIMEOUT_MS = 10_000;
const GROK_CLI_AUTH_HEADER = "xai-grok-cli";
const TOKEN_SKEW_MS = 5 * 60 * 1000;

const GROK_CLI_PROXY_BASE =
  process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim().replace(/\/$/, "") ||
  "https://cli-chat-proxy.grok.com/v1";
const BILLING_CREDITS_URL = `${GROK_CLI_PROXY_BASE}/billing?format=credits`;

type GrokAuthSession = {
  readonly accessToken: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly expiresAtMs: number | null;
};

type GrokAuthReadResult =
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly error: string }
  | { readonly status: "ok"; readonly session: GrokAuthSession };

type GrokUsagePeriod = {
  readonly type?: string;
  readonly start?: string;
  readonly end?: string;
};

type GrokBillingConfig = {
  readonly creditUsagePercent?: number;
  readonly currentPeriod?: GrokUsagePeriod;
  readonly billingPeriodStart?: string;
  readonly billingPeriodEnd?: string;
  readonly subscriptionTier?: string;
};

type GrokBillingResponse = GrokBillingConfig & {
  readonly config?: GrokBillingConfig;
};

export function getGrokHome(): string {
  return process.env.GROK_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".grok");
}

export function readGrokAuthSession(): GrokAuthReadResult {
  const path = NodePath.join(getGrokHome(), "auth.json");
  if (!NodeFS.existsSync(path)) {
    return { status: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return { status: "error", error: "Grok auth file is invalid" };
    }
    for (const entry of Object.values(parsed)) {
      if (typeof entry !== "object" || entry === null) continue;
      const authEntry = entry as {
        key?: string;
        user_id?: string;
        email?: string;
        expires_at?: string;
      };
      if (typeof authEntry.key !== "string" || authEntry.key.length === 0) continue;
      const expiresAtMs =
        typeof authEntry.expires_at === "string" ? Date.parse(authEntry.expires_at) : Number.NaN;
      return {
        status: "ok",
        session: {
          accessToken: authEntry.key,
          userId: typeof authEntry.user_id === "string" ? authEntry.user_id : null,
          email: typeof authEntry.email === "string" ? authEntry.email : null,
          expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
        },
      };
    }
    return { status: "missing" };
  } catch (err) {
    return {
      status: "error",
      error:
        err instanceof SyntaxError ? "Grok auth file is invalid" : "Unable to read Grok auth file",
    };
  }
}

function isGrokAccessTokenFresh(session: GrokAuthSession, nowMs: number): boolean {
  if (session.expiresAtMs === null) return true;
  return session.expiresAtMs - nowMs > TOKEN_SKEW_MS;
}

function resolveBillingConfig(data: GrokBillingResponse): GrokBillingConfig | null {
  if (data.config) return data.config;
  if (typeof data.creditUsagePercent === "number") return data;
  return null;
}

function mapBillingResponse(data: GrokBillingResponse, updatedAt: string): ServerProviderUsage {
  const config = resolveBillingConfig(data);
  if (!config) {
    return usageUnavailable({
      updatedAt,
      error: "Grok billing response did not include config",
      source: "oauth",
    });
  }
  const usedPercent = config.creditUsagePercent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return usageUnavailable({
      updatedAt,
      error: "Grok billing response did not include credit usage",
      source: "oauth",
    });
  }
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd;
  const resetsAt = periodEnd ? Date.parse(periodEnd) : null;
  const tier = config.subscriptionTier?.trim();
  const planLabel = tier && tier.length > 0 ? tier : undefined;

  return usageOk({
    windows: [
      usageWindow({
        id: "weekly",
        label: "Weekly credits",
        usedPercent,
        windowMinutes: WEEKLY_WINDOW_MINUTES,
        resetsAt: resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null,
      }),
    ],
    updatedAt,
    ...(planLabel ? { planLabel } : {}),
    source: "oauth",
  });
}

export async function fetchGrokUsage(input?: {
  readonly updatedAt?: string;
}): Promise<ServerProviderUsage> {
  return withUsageCache("grok:v2", () => fetchGrokUsageUncached(input));
}

async function fetchGrokUsageUncached(input?: {
  readonly updatedAt?: string;
}): Promise<ServerProviderUsage> {
  const updatedAt = input?.updatedAt ?? new Date().toISOString();
  const nowMs = Date.now();
  const readResult = readGrokAuthSession();
  if (readResult.status === "missing") {
    return usageUnavailable({
      updatedAt,
      error: "Not signed in to Grok — run `grok login`",
      source: "oauth",
    });
  }
  if (readResult.status === "error") {
    return usageError({ updatedAt, error: readResult.error, source: "oauth" });
  }
  const session = readResult.session;
  if (!isGrokAccessTokenFresh(session, nowMs)) {
    return usageError({
      updatedAt,
      error: "Grok session expired — run `grok login` to refresh",
      source: "oauth",
    });
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`,
      "X-XAI-Token-Auth": GROK_CLI_AUTH_HEADER,
      Accept: "application/json",
    };
    if (session.userId) {
      headers["x-userid"] = session.userId;
    }
    const response = await fetch(BILLING_CREDITS_URL, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return usageError({
        updatedAt,
        error: `Grok usage unauthorized (HTTP ${response.status})`,
        source: "oauth",
      });
    }
    if (response.status === 429) {
      return usageError({
        updatedAt,
        error: "Grok usage API rate-limited — try again shortly",
        source: "oauth",
      });
    }
    if (!response.ok) {
      return usageError({
        updatedAt,
        error: `Grok usage request failed (HTTP ${response.status})`,
        source: "oauth",
      });
    }
    const data = (await response.json()) as GrokBillingResponse;
    return mapBillingResponse(data, updatedAt);
  } catch (cause) {
    return usageError({
      updatedAt,
      error: cause instanceof Error ? cause.message : "Grok usage request failed",
      source: "oauth",
    });
  }
}
