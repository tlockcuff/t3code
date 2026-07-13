import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectTitleMap,
  isPhaseEnabled,
  resolveAgentNotifications,
  type NotificationTriggerSettings,
  type ThreadPhaseMap,
  threadPhaseKey,
} from "./AgentNotifier.logic.ts";

const ENV = "local" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;

const ALL_TRIGGERS: NotificationTriggerSettings = {
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnFailure: true,
};

/**
 * Minimal thread shell. `projectThreadAwareness` only reads the fields listed
 * in its input type, so the rest is cast rather than faithfully constructed.
 */
const thread = (input: {
  readonly id?: string;
  readonly sessionStatus?: string | null;
  readonly turnState?: string | null;
  readonly completedAt?: string | null;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): EnvironmentThreadShell =>
  ({
    environmentId: ENV,
    id: (input.id ?? THREAD) as ThreadId,
    projectId: "project-1",
    title: "Refactor the parser",
    modelSelection: { model: "gpt-5" },
    updatedAt: "2026-07-13T00:00:00.000Z",
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    session:
      input.sessionStatus === undefined || input.sessionStatus === null
        ? null
        : { status: input.sessionStatus, providerName: "codex", lastError: null },
    latestTurn:
      input.turnState === undefined || input.turnState === null
        ? null
        : { state: input.turnState, completedAt: input.completedAt ?? null },
  }) as unknown as EnvironmentThreadShell;

const PROJECT_TITLES = new Map([[`${ENV}::project-1`, "t3code"]]);

const resolve = (input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly previousPhases?: ThreadPhaseMap;
  readonly settings?: NotificationTriggerSettings;
  readonly appFocused?: boolean;
  readonly seeded?: boolean;
}) =>
  resolveAgentNotifications({
    threads: input.threads,
    projectTitlesByRef: PROJECT_TITLES,
    previousPhases: input.previousPhases ?? new Map(),
    settings: input.settings ?? ALL_TRIGGERS,
    appFocused: input.appFocused ?? false,
    seeded: input.seeded ?? true,
  });

describe("resolveAgentNotifications", () => {
  it("notifies on the edge into a completed turn", () => {
    const running = new Map([[threadPhaseKey(ENV, THREAD), "running" as const]]);
    const { notifications } = resolve({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      previousPhases: running,
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.phase).toBe("completed");
    expect(notifications[0]?.title).toBe("Agent finished");
    expect(notifications[0]?.body).toBe("Refactor the parser · t3code");
    expect(notifications[0]?.threadId).toBe(THREAD);
  });

  it("does not re-notify while the thread stays in the same phase", () => {
    const settled = new Map([[threadPhaseKey(ENV, THREAD), "completed" as const]]);
    const { notifications } = resolve({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      previousPhases: settled,
    });

    expect(notifications).toEqual([]);
  });

  it("stays silent on the first (seeding) pass so existing threads do not replay", () => {
    const { notifications, nextPhases } = resolve({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      seeded: false,
    });

    expect(notifications).toEqual([]);
    // The phase is still recorded, so the next real transition has a baseline.
    expect(nextPhases.get(threadPhaseKey(ENV, THREAD))).toBe("completed");
  });

  it("stays silent while the app is focused", () => {
    const running = new Map([[threadPhaseKey(ENV, THREAD), "running" as const]]);
    const { notifications, nextPhases } = resolve({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      previousPhases: running,
      appFocused: true,
    });

    expect(notifications).toEqual([]);
    // Phase still advances, so re-blurring does not fire a stale completion.
    expect(nextPhases.get(threadPhaseKey(ENV, THREAD))).toBe("completed");
  });

  it("does not notify for non-notifiable phases", () => {
    const { notifications } = resolve({
      threads: [thread({ sessionStatus: "running", turnState: "running" })],
    });

    expect(notifications).toEqual([]);
  });

  it("notifies for approval, input, and failure phases", () => {
    const running = new Map([[threadPhaseKey(ENV, THREAD), "running" as const]]);

    expect(
      resolve({
        threads: [thread({ sessionStatus: "running", hasPendingApprovals: true })],
        previousPhases: running,
      }).notifications[0]?.phase,
    ).toBe("waiting_for_approval");

    expect(
      resolve({
        threads: [thread({ sessionStatus: "running", hasPendingUserInput: true })],
        previousPhases: running,
      }).notifications[0]?.phase,
    ).toBe("waiting_for_input");

    expect(
      resolve({
        threads: [thread({ sessionStatus: "error" })],
        previousPhases: running,
      }).notifications[0]?.phase,
    ).toBe("failed");
  });

  it("respects per-trigger toggles", () => {
    const running = new Map([[threadPhaseKey(ENV, THREAD), "running" as const]]);
    const { notifications } = resolve({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      previousPhases: running,
      settings: { ...ALL_TRIGGERS, notifyOnCompletion: false },
    });

    expect(notifications).toEqual([]);
  });

  it("tracks threads independently", () => {
    const previous = new Map([
      [threadPhaseKey(ENV, "a" as ThreadId), "running" as const],
      [threadPhaseKey(ENV, "b" as ThreadId), "completed" as const],
    ]);
    const { notifications } = resolve({
      threads: [
        thread({ id: "a", sessionStatus: "ready", turnState: "completed" }),
        thread({ id: "b", sessionStatus: "ready", turnState: "completed" }),
      ],
      previousPhases: previous,
    });

    // Only "a" transitioned; "b" was already completed.
    expect(notifications.map((entry) => entry.threadId)).toEqual(["a"]);
  });

  it("falls back to the thread title alone when the project is unknown", () => {
    const running = new Map([[threadPhaseKey(ENV, THREAD), "running" as const]]);
    const { notifications } = resolveAgentNotifications({
      threads: [thread({ sessionStatus: "ready", turnState: "completed" })],
      projectTitlesByRef: new Map(),
      previousPhases: running,
      settings: ALL_TRIGGERS,
      appFocused: false,
      seeded: true,
    });

    expect(notifications[0]?.body).toBe("Refactor the parser");
  });
});

describe("isPhaseEnabled", () => {
  it("maps each phase to its own toggle", () => {
    const onlyApproval: NotificationTriggerSettings = {
      notifyOnCompletion: false,
      notifyOnApproval: true,
      notifyOnInput: false,
      notifyOnFailure: false,
    };

    expect(isPhaseEnabled("waiting_for_approval", onlyApproval)).toBe(true);
    expect(isPhaseEnabled("completed", onlyApproval)).toBe(false);
    expect(isPhaseEnabled("waiting_for_input", onlyApproval)).toBe(false);
    expect(isPhaseEnabled("failed", onlyApproval)).toBe(false);
  });
});

describe("buildProjectTitleMap", () => {
  it("keys project titles by environment and project id", () => {
    const map = buildProjectTitleMap([
      { environmentId: ENV, id: "project-1", title: "t3code" },
    ] as never);

    expect(map.get(`${ENV}::project-1`)).toBe("t3code");
  });
});
