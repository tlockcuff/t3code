import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatUsageDisplayLabel,
  formatUsagePercent,
  formatUsageReset,
  displayUsagePercent,
  getProviderUsageSidebarEntries,
  remainingFromUsed,
  resolveUsagePlanLabel,
} from "./SidebarUsageStatus.logic";

function makeProvider(
  overrides: Partial<ServerProvider> & Pick<ServerProvider, "instanceId" | "driver">,
): ServerProvider {
  return {
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("SidebarUsageStatus.logic", () => {
  it("computes remaining percent from used", () => {
    expect(remainingFromUsed(23)).toBe(77);
    expect(remainingFromUsed(100)).toBe(0);
    expect(remainingFromUsed(-5)).toBe(100);
  });

  it("formats percent and reset labels", () => {
    expect(formatUsagePercent(77.2)).toBe("77%");
    expect(formatUsageReset(Date.now() + 90 * 60_000, Date.now())).toBe("2h");
  });

  it("switches display percent between used and remaining", () => {
    expect(displayUsagePercent(23, "used")).toBe(23);
    expect(displayUsagePercent(23, "remaining")).toBe(77);
    expect(formatUsageDisplayLabel(23, "used")).toBe("23% used");
    expect(formatUsageDisplayLabel(23, "remaining")).toBe("77% left");
  });

  it("collects only enabled providers with ok usage windows", () => {
    const entries = getProviderUsageSidebarEntries([
      makeProvider({
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude",
        auth: {
          status: "authenticated",
          label: "Claude Max Subscription",
          email: "user@example.com",
        },
        usage: {
          status: "ok",
          planLabel: "user@example.com (max)",
          windows: [{ id: "five_hour", label: "5-hour", usedPercent: 23 }],
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
      makeProvider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        usage: {
          status: "unavailable",
          windows: [],
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
      makeProvider({
        instanceId: ProviderInstanceId.make("opencode"),
        driver: ProviderDriverKind.make("opencode"),
        usage: {
          status: "ok",
          windows: [{ id: "primary", label: "Primary", usedPercent: 10 }],
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.driver).toBe(ProviderDriverKind.make("claudeAgent"));
    expect(entries[0]?.remainingPercent).toBe(77);
    expect(entries[0]?.planLabel).toBe("Claude Max Subscription");
  });

  it("filters entries by the sidebar usage allowlist", () => {
    const providers = [
      makeProvider({
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        usage: {
          status: "ok",
          windows: [{ id: "five_hour", label: "5-hour", usedPercent: 10 }],
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
      makeProvider({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        usage: {
          status: "ok",
          windows: [{ id: "primary", label: "Primary", usedPercent: 20 }],
          updatedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    ];

    expect(getProviderUsageSidebarEntries(providers, [ProviderDriverKind.make("codex")])).toEqual([
      expect.objectContaining({ driver: ProviderDriverKind.make("codex") }),
    ]);
    expect(getProviderUsageSidebarEntries(providers, [])).toEqual([]);
  });

  it("prefers auth plan labels and strips emails from usage plan labels", () => {
    expect(
      resolveUsagePlanLabel(
        makeProvider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          auth: { status: "authenticated", label: "Cursor Pro Subscription" },
          usage: {
            status: "ok",
            planLabel: "tlockcuff@gmail.com (pro)",
            windows: [{ id: "total", label: "Included total", usedPercent: 30 }],
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        }),
      ),
    ).toBe("Cursor Pro Subscription");

    expect(
      resolveUsagePlanLabel(
        makeProvider({
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          auth: { status: "unknown" },
          usage: {
            status: "ok",
            planLabel: "tlockcuff@gmail.com",
            windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 40 }],
            updatedAt: "2026-07-10T00:00:00.000Z",
          },
        }),
      ),
    ).toBeUndefined();
  });
});
