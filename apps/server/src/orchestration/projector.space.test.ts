import { CommandId, EventId, ProjectId, type OrchestrationEvent } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: now,
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const createPayload = (space: string | null) => ({
  projectId,
  title: "Project",
  workspaceRoot: "/tmp/project-1",
  defaultModelSelection: null,
  scripts: [],
  space,
  createdAt: now,
  updatedAt: now,
});

it.effect("sets space on project.created", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "project.created", payload: createPayload("Work") }),
    );
    expect(created.projects[0]?.space).toBe("Work");
  }),
);

it.effect("defaults space to null on project.created without a space", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "project.created", payload: createPayload(null) }),
    );
    expect(created.projects[0]?.space).toBe(null);
  }),
);

it.effect("applies space on project.meta-updated when provided", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "project.created", payload: createPayload(null) }),
    );
    const updated = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "project.meta-updated",
        payload: { projectId, space: "Personal", updatedAt: now },
      }),
    );
    expect(updated.projects[0]?.space).toBe("Personal");
  }),
);

it.effect("clears space on project.meta-updated with explicit null", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "project.created", payload: createPayload("Work") }),
    );
    const updated = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "project.meta-updated",
        payload: { projectId, space: null, updatedAt: now },
      }),
    );
    expect(updated.projects[0]?.space).toBe(null);
  }),
);

it.effect("leaves space untouched on project.meta-updated when omitted", () =>
  Effect.gen(function* () {
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({ sequence: 1, type: "project.created", payload: createPayload("Work") }),
    );
    const updated = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "project.meta-updated",
        payload: { projectId, title: "Renamed", updatedAt: now },
      }),
    );
    expect(updated.projects[0]?.space).toBe("Work");
  }),
);
