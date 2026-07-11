// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ServerProviderUsage } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { usageError, usageOk, usageUnavailable, usageWindow } from "./usageTypes.ts";
import { withUsageCache } from "./usageCache.ts";

const API_TIMEOUT_MS = 10_000;
const MONTHLY_WINDOW_MINUTES = 43_200;
const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

type CursorAuthSession = {
  readonly accessToken: string;
  readonly email: string | null;
  readonly membershipType: string | null;
};

type CursorPlanUsage = {
  readonly totalSpend?: number;
  readonly includedSpend?: number;
  readonly limit?: number;
  readonly autoPercentUsed?: number;
  readonly apiPercentUsed?: number;
  readonly totalPercentUsed?: number;
};

type CursorPeriodUsageResponse = {
  readonly billingCycleEnd?: string;
  readonly planUsage?: CursorPlanUsage;
  readonly displayMessage?: string;
};

function cursorStateDbPath(): string | null {
  const home = NodeOS.homedir();
  const platform = Effect.runSync(Effect.service(HostProcessPlatform));
  const candidates =
    platform === "darwin"
      ? [
          NodePath.join(
            home,
            "Library",
            "Application Support",
            "Cursor",
            "User",
            "globalStorage",
            "state.vscdb",
          ),
        ]
      : platform === "win32"
        ? [
            NodePath.join(
              process.env.APPDATA ?? NodePath.join(home, "AppData", "Roaming"),
              "Cursor",
              "User",
              "globalStorage",
              "state.vscdb",
            ),
          ]
        : [
            NodePath.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
            NodePath.join(home, ".config", "cursor", "User", "globalStorage", "state.vscdb"),
          ];
  return candidates.find((path) => NodeFS.existsSync(path)) ?? null;
}

function readSqliteValue(dbPath: string, key: string): string | null {
  try {
    const nodeRequire = NodeModule.createRequire(import.meta.url);
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        options?: { readonly?: boolean },
      ) => {
        prepare: (sql: string) => {
          get: (...params: unknown[]) => { value?: unknown } | undefined;
        };
        close: () => void;
      };
    };
    const db = new DatabaseSync(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key);
      const value = row?.value;
      if (typeof value === "string") return value;
      if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
      if (Buffer.isBuffer(value)) return value.toString("utf8");
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function readSqliteValueViaCli(dbPath: string, key: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${key.replaceAll("'", "''")}';`],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function readCursorAuthSession(): Promise<CursorAuthSession | null> {
  const dbPath = cursorStateDbPath();
  if (!dbPath) return null;

  const readKey = async (key: string): Promise<string | null> => {
    const syncValue = readSqliteValue(dbPath, key);
    if (syncValue) return syncValue;
    return readSqliteValueViaCli(dbPath, key);
  };

  const accessToken = await readKey("cursorAuth/accessToken");
  if (!accessToken) return null;
  const email = await readKey("cursorAuth/cachedEmail");
  const membershipType = await readKey("cursorAuth/stripeMembershipType");
  return {
    accessToken,
    email,
    membershipType,
  };
}

function parseBillingCycleMs(value: string | undefined): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1_000_000_000_000) {
    return asNumber;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapPeriodUsage(
  data: CursorPeriodUsageResponse,
  session: CursorAuthSession,
  updatedAt: string,
): ServerProviderUsage {
  const plan = data.planUsage;
  if (!plan) {
    return usageUnavailable({
      updatedAt,
      error: "Cursor usage response did not include plan usage",
      source: "http",
    });
  }

  const resetsAt = parseBillingCycleMs(data.billingCycleEnd);
  const windows = [];

  if (typeof plan.totalPercentUsed === "number" && Number.isFinite(plan.totalPercentUsed)) {
    windows.push(
      usageWindow({
        id: "total",
        label: "Included total",
        usedPercent: plan.totalPercentUsed,
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt,
      }),
    );
  }
  if (typeof plan.autoPercentUsed === "number" && Number.isFinite(plan.autoPercentUsed)) {
    windows.push(
      usageWindow({
        id: "auto",
        label: "First-party pool",
        usedPercent: plan.autoPercentUsed,
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt,
      }),
    );
  }
  if (typeof plan.apiPercentUsed === "number" && Number.isFinite(plan.apiPercentUsed)) {
    windows.push(
      usageWindow({
        id: "api",
        label: "API pool",
        usedPercent: plan.apiPercentUsed,
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt,
      }),
    );
  }

  if (
    windows.length === 0 &&
    typeof plan.includedSpend === "number" &&
    typeof plan.limit === "number" &&
    plan.limit > 0
  ) {
    windows.push(
      usageWindow({
        id: "included",
        label: "Included spend",
        usedPercent: (plan.includedSpend / plan.limit) * 100,
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt,
      }),
    );
  }

  if (windows.length === 0) {
    return usageUnavailable({
      updatedAt,
      error: data.displayMessage ?? "Cursor usage windows unavailable",
      source: "http",
    });
  }

  const membership = session.membershipType?.trim();
  const planLabel = membership
    ? membership.charAt(0).toUpperCase() + membership.slice(1).toLowerCase()
    : undefined;

  return usageOk({
    windows,
    updatedAt,
    ...(planLabel ? { planLabel } : {}),
    source: "http",
  });
}

export async function fetchCursorUsage(input?: {
  readonly updatedAt?: string;
}): Promise<ServerProviderUsage> {
  return withUsageCache("cursor:v2", () => fetchCursorUsageUncached(input));
}

async function fetchCursorUsageUncached(input?: {
  readonly updatedAt?: string;
}): Promise<ServerProviderUsage> {
  const updatedAt = input?.updatedAt ?? new Date().toISOString();
  try {
    const session = await readCursorAuthSession();
    if (!session) {
      return usageUnavailable({
        updatedAt,
        error: "Not signed in to Cursor IDE — open Cursor and sign in",
        source: "http",
      });
    }

    const response = await fetch(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return usageError({
        updatedAt,
        error: `Cursor usage unauthorized (HTTP ${response.status})`,
        source: "http",
      });
    }
    if (response.status === 429) {
      return usageError({
        updatedAt,
        error: "Cursor usage API rate-limited — try again shortly",
        source: "http",
      });
    }
    if (!response.ok) {
      return usageError({
        updatedAt,
        error: `Cursor usage request failed (HTTP ${response.status})`,
        source: "http",
      });
    }
    const data = (await response.json()) as CursorPeriodUsageResponse;
    return mapPeriodUsage(data, session, updatedAt);
  } catch (cause) {
    return usageError({
      updatedAt,
      error: cause instanceof Error ? cause.message : "Cursor usage request failed",
      source: "http",
    });
  }
}
