import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderUsage,
  type SidebarUsageDisplayMode,
} from "@t3tools/contracts";

export const USAGE_SIDEBAR_DRIVERS = [
  ProviderDriverKind.make("claudeAgent"),
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("cursor"),
  ProviderDriverKind.make("grok"),
] as const;

export type UsageSidebarDriver = (typeof USAGE_SIDEBAR_DRIVERS)[number];

export type ProviderUsageSidebarEntry = {
  readonly instanceId: string;
  readonly driver: UsageSidebarDriver;
  readonly displayName: string;
  readonly planLabel: string | undefined;
  readonly usage: ServerProviderUsage;
  readonly primaryWindow: ServerProviderUsage["windows"][number];
  readonly usedPercent: number;
  readonly remainingPercent: number;
};

function isUsageSidebarDriver(driver: ProviderDriverKind): driver is UsageSidebarDriver {
  return (USAGE_SIDEBAR_DRIVERS as ReadonlyArray<ProviderDriverKind>).includes(driver);
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Prefer the settings-style auth label (plan type). Never surface emails.
 */
export function resolveUsagePlanLabel(provider: ServerProvider): string | undefined {
  const authLabel = provider.auth.label?.trim();
  if (authLabel && !looksLikeEmail(authLabel)) {
    return authLabel;
  }

  const usageLabel = provider.usage?.planLabel?.trim();
  if (!usageLabel) return undefined;
  if (looksLikeEmail(usageLabel)) return undefined;

  // "email@x.com (pro)" → "Pro"
  const parenMatch = usageLabel.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const before = parenMatch[1]?.trim() ?? "";
    const inside = parenMatch[2]?.trim() ?? "";
    if (looksLikeEmail(before) && inside) {
      return inside.charAt(0).toUpperCase() + inside.slice(1);
    }
  }

  return usageLabel;
}

export function clampUsagePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function remainingFromUsed(usedPercent: number): number {
  return clampUsagePercent(100 - clampUsagePercent(usedPercent));
}

export function displayUsagePercent(usedPercent: number, mode: SidebarUsageDisplayMode): number {
  const used = clampUsagePercent(usedPercent);
  return mode === "remaining" ? remainingFromUsed(used) : used;
}

export function formatUsageReset(
  resetsAt: number | null | undefined,
  nowMs: number,
): string | null {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const deltaMs = resetsAt - nowMs;
  if (deltaMs <= 0) return "resetting";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

export function formatUsagePercent(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 99.5) return "100%";
  if (value <= 0.5) return "0%";
  if (value < 10) return `${value.toFixed(0)}%`;
  return `${Math.round(value)}%`;
}

export function formatUsageDisplayLabel(
  usedPercent: number,
  mode: SidebarUsageDisplayMode,
): string {
  const percent = formatUsagePercent(displayUsagePercent(usedPercent, mode));
  return mode === "remaining" ? `${percent} left` : `${percent} used`;
}

/**
 * Keep allowlist order stable and limited to drivers that can show usage.
 */
export function normalizeSidebarUsageDrivers(
  drivers: ReadonlyArray<ProviderDriverKind>,
): Array<UsageSidebarDriver> {
  const enabled = new Set(drivers);
  return USAGE_SIDEBAR_DRIVERS.filter((driver) => enabled.has(driver));
}

export function getProviderUsageSidebarEntries(
  providers: ReadonlyArray<ServerProvider>,
  allowedDrivers: ReadonlyArray<ProviderDriverKind> = USAGE_SIDEBAR_DRIVERS,
): ReadonlyArray<ProviderUsageSidebarEntry> {
  const allowed = new Set(allowedDrivers);
  const entries: Array<ProviderUsageSidebarEntry> = [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed) continue;
    if (!isUsageSidebarDriver(provider.driver)) continue;
    if (!allowed.has(provider.driver)) continue;
    const usage = provider.usage;
    if (!usage || usage.status !== "ok" || usage.windows.length === 0) continue;
    const primaryWindow = usage.windows[0];
    if (!primaryWindow) continue;
    const usedPercent = clampUsagePercent(primaryWindow.usedPercent);
    entries.push({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName?.trim() || provider.driver,
      planLabel: resolveUsagePlanLabel(provider),
      usage,
      primaryWindow,
      usedPercent,
      remainingPercent: remainingFromUsed(usedPercent),
    });
  }
  return entries;
}

export type UsageTone = "critical" | "warning" | "normal";

/**
 * Urgency always keys off remaining capacity, regardless of display mode.
 *
 * This returns a semantic tone rather than a class name: this package is shared with the React
 * Native app, and Tailwind only scans the web app's sources — so class names authored here would
 * never be compiled into the stylesheet. Each platform maps the tone to its own styling.
 */
export function usageTone(remainingPercent: number): UsageTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "warning";
  return "normal";
}
