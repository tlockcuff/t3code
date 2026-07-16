import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  deriveHasRunningSubagentsFromActivities,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

describe("deriveHasRunningSubagentsFromActivities", () => {
  it("returns false when there are no task activities", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-1",
          kind: "tool.started",
          payload: { toolCallId: "tool-1" },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
    ).toBe(false);
  });

  it("returns true while a task has started without completing", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-1",
          kind: "task.started",
          payload: { taskId: "task-1" },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
      ]),
    ).toBe(true);
  });

  it("returns true when the latest event for a task is progress", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-1",
          kind: "task.started",
          payload: { taskId: "task-1" },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          activityId: "act-2",
          kind: "task.progress",
          payload: { taskId: "task-1", summary: "still going" },
          createdAt: "2026-05-01T00:00:01.000Z",
        },
      ]),
    ).toBe(true);
  });

  it("returns false after every open task completes", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-1",
          kind: "task.started",
          payload: { taskId: "task-1" },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          activityId: "act-2",
          kind: "task.started",
          payload: { taskId: "task-2" },
          createdAt: "2026-05-01T00:00:01.000Z",
        },
        {
          activityId: "act-3",
          kind: "task.completed",
          payload: { taskId: "task-1", status: "completed" },
          createdAt: "2026-05-01T00:00:02.000Z",
        },
        {
          activityId: "act-4",
          kind: "task.completed",
          payload: { taskId: "task-2", status: "failed" },
          createdAt: "2026-05-01T00:00:03.000Z",
        },
      ]),
    ).toBe(false);
  });

  it("returns true when one of several concurrent tasks is still open", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-1",
          kind: "task.started",
          payload: { taskId: "done" },
          createdAt: "2026-05-01T00:00:00.000Z",
        },
        {
          activityId: "act-2",
          kind: "task.started",
          payload: { taskId: "running" },
          createdAt: "2026-05-01T00:00:01.000Z",
        },
        {
          activityId: "act-3",
          kind: "task.completed",
          payload: { taskId: "done", status: "completed" },
          createdAt: "2026-05-01T00:00:02.000Z",
        },
      ]),
    ).toBe(true);
  });

  it("orders by sequence first, matching the DB read path and client", () => {
    // completed has a LATER sequence but an EARLIER createdAt than started.
    // Sorting by createdAt alone would treat the task as still open.
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-started",
          kind: "task.started",
          payload: { taskId: "task-1" },
          createdAt: "2026-05-01T00:00:05.000Z",
          sequence: 1,
        },
        {
          activityId: "act-completed",
          kind: "task.completed",
          payload: { taskId: "task-1", status: "completed" },
          createdAt: "2026-05-01T00:00:01.000Z",
          sequence: 2,
        },
      ]),
    ).toBe(false);
  });

  it("keeps a task open when a later sequence is progress despite earlier createdAt", () => {
    expect(
      deriveHasRunningSubagentsFromActivities([
        {
          activityId: "act-completed",
          kind: "task.completed",
          payload: { taskId: "task-1", status: "completed" },
          createdAt: "2026-05-01T00:00:09.000Z",
          sequence: 1,
        },
        {
          activityId: "act-progress",
          kind: "task.progress",
          payload: { taskId: "task-1", summary: "still going" },
          createdAt: "2026-05-01T00:00:02.000Z",
          sequence: 2,
        },
      ]),
    ).toBe(true);
  });
});

const SettleTestLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-running-subagents-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const seedThreadWithOpenTask = (threadId: ThreadId, turnId: TurnId) =>
  Effect.gen(function* () {
    const eventStore = yield* OrchestrationEventStore;
    const now = "2026-06-01T00:00:00.000Z";

    yield* eventStore.append({
      type: "thread.created",
      eventId: EventId.make(`${threadId}-evt-created`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: CommandId.make(`${threadId}-cmd-created`),
      causationEventId: null,
      correlationId: CorrelationId.make(`${threadId}-cmd-created`),
      metadata: {},
      payload: {
        threadId,
        projectId: ProjectId.make("project-running-subagents"),
        title: "Running subagents",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude"),
          model: "claude-opus",
        },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    });

    yield* eventStore.append({
      type: "thread.session-set",
      eventId: EventId.make(`${threadId}-evt-session-running`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-06-01T00:00:01.000Z",
      commandId: CommandId.make(`${threadId}-cmd-session-running`),
      causationEventId: null,
      correlationId: CorrelationId.make(`${threadId}-cmd-session-running`),
      metadata: {},
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claude",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-06-01T00:00:01.000Z",
        },
      },
    });

    // A subagent task starts but never emits task.completed (the only activity
    // that clears it) — the interrupt/crash path.
    yield* eventStore.append({
      type: "thread.activity-appended",
      eventId: EventId.make(`${threadId}-evt-task-started`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-06-01T00:00:02.000Z",
      commandId: CommandId.make(`${threadId}-cmd-task-started`),
      causationEventId: null,
      correlationId: CorrelationId.make(`${threadId}-cmd-task-started`),
      metadata: {},
      payload: {
        threadId,
        activity: {
          id: EventId.make(`${threadId}-activity-task-started`),
          tone: "info",
          kind: "task.started",
          summary: "Subagent started",
          payload: { taskId: "task-1" },
          turnId,
          sequence: 1,
          createdAt: "2026-06-01T00:00:02.000Z",
        },
      },
    });
  });

const readHasRunningSubagents = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly hasRunningSubagents: number }>`
      SELECT has_running_subagents AS "hasRunningSubagents"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.hasRunningSubagents ?? null;
  });

it.layer(SettleTestLayer)("hasRunningSubagents settle on session-set", (it) => {
  it.effect("reports running while the session is running with an open task", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const threadId = ThreadId.make("thread-open-running");
      const turnId = TurnId.make("turn-1");

      yield* seedThreadWithOpenTask(threadId, turnId);
      yield* pipeline.bootstrap;

      assert.equal(yield* readHasRunningSubagents(threadId), 1);
    }),
  );

  for (const status of [
    "interrupted",
    "error",
    "stopped",
  ] as const satisfies ReadonlyArray<OrchestrationSessionStatus>) {
    it.effect(`settles open subagents when the session becomes ${status}`, () =>
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const threadId = ThreadId.make(`thread-settle-${status}`);
        const turnId = TurnId.make(`turn-${status}`);
        const eventStore = yield* OrchestrationEventStore;

        yield* seedThreadWithOpenTask(threadId, turnId);

        // Session leaves "running" without any task.completed — must settle.
        yield* eventStore.append({
          type: "thread.session-set",
          eventId: EventId.make(`${threadId}-evt-session-${status}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: "2026-06-01T00:00:03.000Z",
          commandId: CommandId.make(`${threadId}-cmd-session-${status}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`${threadId}-cmd-session-${status}`),
          metadata: {},
          payload: {
            threadId,
            session: {
              threadId,
              status,
              providerName: "claude",
              runtimeMode: "full-access",
              activeTurnId: status === "error" ? turnId : null,
              lastError: status === "error" ? "boom" : null,
              updatedAt: "2026-06-01T00:00:03.000Z",
            },
          },
        });

        yield* pipeline.bootstrap;

        assert.equal(yield* readHasRunningSubagents(threadId), 0);
      }),
    );
  }
});
