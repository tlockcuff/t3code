import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

import {
  MIN_PROVIDER_SNAPSHOT_REFRESH_DELAY_MS,
  nextProviderSnapshotRefreshDelay,
  USAGE_RESET_REFRESH_BUFFER_MS,
} from "./providerSnapshotRefresh.ts";

function makeSnapshot(resetsAt: number | null): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    usage: {
      status: "ok",
      updatedAt: "2026-07-10T00:00:00.000Z",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          usedPercent: 40,
          resetsAt,
        },
      ],
    },
  };
}

describe("nextProviderSnapshotRefreshDelay", () => {
  it("uses the base interval when no reset is sooner", () => {
    const nowMs = 1_000_000;
    const delay = nextProviderSnapshotRefreshDelay(
      makeSnapshot(nowMs + Duration.toMillis(Duration.hours(2))),
      Duration.minutes(5),
      nowMs,
    );
    expect(Duration.toMillis(delay)).toBe(Duration.toMillis(Duration.minutes(5)));
  });

  it("wakes shortly after the soonest usage window reset", () => {
    const nowMs = 1_000_000;
    const resetsAt = nowMs + 90_000;
    const delay = nextProviderSnapshotRefreshDelay(
      makeSnapshot(resetsAt),
      Duration.minutes(5),
      nowMs,
    );
    expect(Duration.toMillis(delay)).toBe(90_000 + USAGE_RESET_REFRESH_BUFFER_MS);
  });

  it("never schedules faster than the minimum delay", () => {
    const nowMs = 1_000_000;
    const delay = nextProviderSnapshotRefreshDelay(
      makeSnapshot(nowMs + 500),
      Duration.minutes(5),
      nowMs,
    );
    expect(Duration.toMillis(delay)).toBe(MIN_PROVIDER_SNAPSHOT_REFRESH_DELAY_MS);
  });
});
