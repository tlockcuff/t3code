import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const seedProject = (now: string, projectId: ProjectId) =>
  projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId(`evt-create-${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make(`cmd-create-${projectId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-create-${projectId}`),
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      space: null,
      createdAt: now,
      updatedAt: now,
    },
  });

it.layer(NodeServices.layer)("decider project space", (it) => {
  it.effect("includes space on project.create when provided", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-space"),
          projectId: asProjectId("project-space"),
          title: "Space",
          workspaceRoot: "/tmp/space",
          space: "Work",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { space: unknown }).space).toBe("Work");
    }),
  );

  it.effect("defaults space to null on project.create when omitted", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-nospace"),
          projectId: asProjectId("project-nospace"),
          title: "No Space",
          workspaceRoot: "/tmp/nospace",
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { space: unknown }).space).toBe(null);
    }),
  );

  it.effect("sets space in project.meta.update payload when provided", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now, asProjectId("project-update"));

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-space"),
          projectId: asProjectId("project-update"),
          space: "Personal",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { space?: unknown }).space).toBe("Personal");
    }),
  );

  it.effect("clears space in project.meta.update payload with explicit null", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now, asProjectId("project-clear"));

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-clear-space"),
          projectId: asProjectId("project-clear"),
          space: null,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      const payload = event.payload as { space?: unknown };
      expect("space" in payload).toBe(true);
      expect(payload.space).toBe(null);
    }),
  );

  it.effect("omits space in project.meta.update payload when untouched", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const readModel = yield* seedProject(now, asProjectId("project-untouched"));

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-untouched-space"),
          projectId: asProjectId("project-untouched"),
          title: "Renamed",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect("space" in (event.payload as object)).toBe(false);
    }),
  );
});
