import { describe, expect, it } from "@effect/vitest";

import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

import type { PushDevice } from "./DeviceTokenStore.ts";
import { notificationForDevice } from "./PushNotifier.ts";

const NOW_MS = Date.parse("2026-07-11T12:00:00.000Z");

const baseDevice: PushDevice = {
  deviceId: "device-1",
  label: "iPhone",
  pushToken: "token-1",
  bundleId: "dev.tlok.t3code.dev",
  apsEnvironment: "sandbox",
  appVersion: "0.1.0",
  iosMajorVersion: 18,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
  updatedAt: "2026-07-11T11:00:00.000Z",
};

function stateWith(overrides: Partial<RelayAgentActivityState> = {}): RelayAgentActivityState {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    projectTitle: "My Project",
    threadTitle: "Fix the bug",
    phase: "waiting_for_approval",
    headline: "Waiting for approval",
    modelTitle: "Opus",
    updatedAt: new Date(NOW_MS).toISOString(),
    deepLink: "/threads/env-1/thread-1",
    ...overrides,
  } as RelayAgentActivityState;
}

describe("notificationForDevice", () => {
  it("builds an alert for a waiting-for-approval state", () => {
    const notification = notificationForDevice({
      device: baseDevice,
      state: stateWith({ phase: "waiting_for_approval" }),
      nowMs: NOW_MS,
    });
    expect(notification).toEqual({
      title: "Fix the bug",
      body: "Waiting for approval: My Project",
      environmentId: "env-1",
      threadId: "thread-1",
      deepLink: "/threads/env-1/thread-1",
    });
  });

  it("returns null when notifications are disabled on the device", () => {
    const notification = notificationForDevice({
      device: { ...baseDevice, notificationsEnabled: false },
      state: stateWith(),
      nowMs: NOW_MS,
    });
    expect(notification).toBeNull();
  });

  it("returns null when the matching per-phase preference is off", () => {
    const notification = notificationForDevice({
      device: { ...baseDevice, notifyOnApproval: false },
      state: stateWith({ phase: "waiting_for_approval" }),
      nowMs: NOW_MS,
    });
    expect(notification).toBeNull();
  });

  it("does not notify for non-terminal, non-waiting phases", () => {
    for (const phase of ["starting", "running", "stale"] as const) {
      const notification = notificationForDevice({
        device: baseDevice,
        state: stateWith({ phase }),
        nowMs: NOW_MS,
      });
      expect(notification, phase).toBeNull();
    }
  });

  it("drops stale terminal states older than the freshness window", () => {
    const staleState = stateWith({
      phase: "completed",
      updatedAt: new Date(NOW_MS - 5 * 60 * 1_000).toISOString(),
    });
    expect(
      notificationForDevice({ device: baseDevice, state: staleState, nowMs: NOW_MS }),
    ).toBeNull();
  });

  it("notifies for a fresh completed state", () => {
    const freshState = stateWith({
      phase: "completed",
      headline: "Done",
      updatedAt: new Date(NOW_MS - 30 * 1_000).toISOString(),
    });
    const notification = notificationForDevice({
      device: baseDevice,
      state: freshState,
      nowMs: NOW_MS,
    });
    expect(notification?.body).toBe("Done: My Project");
  });
});
