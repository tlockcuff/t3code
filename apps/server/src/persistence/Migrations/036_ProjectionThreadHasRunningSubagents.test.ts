import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (sql: SqlClient.SqlClient, threadId: string) => sql`
  INSERT INTO projection_threads (
    thread_id,
    project_id,
    title,
    model_selection_json,
    runtime_mode,
    interaction_mode,
    branch,
    worktree_path,
    latest_turn_id,
    created_at,
    updated_at,
    archived_at,
    latest_user_message_at,
    pending_approval_count,
    pending_user_input_count,
    has_actionable_proposed_plan,
    deleted_at
  )
  VALUES (
    ${threadId},
    'project-1',
    'Thread',
    '{"provider":"codex","model":"gpt-5-codex"}',
    'approval-required',
    'plan',
    NULL,
    NULL,
    'turn-1',
    '2026-02-24T00:00:00.000Z',
    '2026-02-24T00:00:00.000Z',
    NULL,
    NULL,
    0,
    0,
    0,
    NULL
  )
`;

const insertSession = (sql: SqlClient.SqlClient, threadId: string, status: string) => sql`
  INSERT INTO projection_thread_sessions (
    thread_id,
    status,
    provider_name,
    provider_thread_id,
    active_turn_id,
    last_error,
    updated_at
  )
  VALUES (
    ${threadId},
    ${status},
    'codex',
    NULL,
    'turn-1',
    NULL,
    '2026-02-24T00:00:00.000Z'
  )
`;

const insertActivity = (
  sql: SqlClient.SqlClient,
  input: {
    readonly activityId: string;
    readonly threadId: string;
    readonly kind: string;
    readonly payloadJson: string;
    readonly sequence: number | null;
    readonly createdAt: string;
  },
) => sql`
  INSERT INTO projection_thread_activities (
    activity_id,
    thread_id,
    turn_id,
    tone,
    kind,
    summary,
    payload_json,
    sequence,
    created_at
  )
  VALUES (
    ${input.activityId},
    ${input.threadId},
    'turn-1',
    'info',
    ${input.kind},
    'summary',
    ${input.payloadJson},
    ${input.sequence},
    ${input.createdAt}
  )
`;

layer("036_ProjectionThreadHasRunningSubagents", (it) => {
  it.effect("backfills has_running_subagents only for running sessions with an open task", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      // running session, task still open -> 1
      yield* insertThread(sql, "thread-open-running");
      yield* insertSession(sql, "thread-open-running", "running");
      yield* insertActivity(sql, {
        activityId: "act-open-running-1",
        threadId: "thread-open-running",
        kind: "task.started",
        payloadJson: '{"taskId":"task-1"}',
        sequence: 1,
        createdAt: "2026-02-24T00:01:00.000Z",
      });

      // interrupted/dead session, task orphaned open -> must stay 0
      yield* insertThread(sql, "thread-orphaned");
      yield* insertSession(sql, "thread-orphaned", "interrupted");
      yield* insertActivity(sql, {
        activityId: "act-orphaned-1",
        threadId: "thread-orphaned",
        kind: "task.started",
        payloadJson: '{"taskId":"task-1"}',
        sequence: 1,
        createdAt: "2026-02-24T00:01:00.000Z",
      });

      // running session, task completed -> 0
      yield* insertThread(sql, "thread-completed-running");
      yield* insertSession(sql, "thread-completed-running", "running");
      yield* insertActivity(sql, {
        activityId: "act-completed-1",
        threadId: "thread-completed-running",
        kind: "task.started",
        payloadJson: '{"taskId":"task-1"}',
        sequence: 1,
        createdAt: "2026-02-24T00:01:00.000Z",
      });
      yield* insertActivity(sql, {
        activityId: "act-completed-2",
        threadId: "thread-completed-running",
        kind: "task.completed",
        payloadJson: '{"taskId":"task-1","status":"completed"}',
        sequence: 2,
        createdAt: "2026-02-24T00:02:00.000Z",
      });

      // no task activity at all -> 0 (and skips json_extract scan)
      yield* insertThread(sql, "thread-no-tasks");
      yield* insertSession(sql, "thread-no-tasks", "running");

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly hasRunningSubagents: number;
      }>`
          SELECT
            thread_id AS "threadId",
            has_running_subagents AS "hasRunningSubagents"
          FROM projection_threads
          ORDER BY thread_id ASC
        `;

      assert.deepStrictEqual(rows, [
        { threadId: "thread-completed-running", hasRunningSubagents: 0 },
        { threadId: "thread-no-tasks", hasRunningSubagents: 0 },
        { threadId: "thread-open-running", hasRunningSubagents: 1 },
        { threadId: "thread-orphaned", hasRunningSubagents: 0 },
      ]);
    }),
  );

  it.effect("orders latest task state by sequence, not created_at", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });

      // completed has a LATER sequence but an EARLIER created_at than started;
      // ordering by created_at alone would wrongly treat the task as open.
      yield* insertThread(sql, "thread-seq");
      yield* insertSession(sql, "thread-seq", "running");
      yield* insertActivity(sql, {
        activityId: "act-seq-started",
        threadId: "thread-seq",
        kind: "task.started",
        payloadJson: '{"taskId":"task-1"}',
        sequence: 1,
        createdAt: "2026-02-24T00:05:00.000Z",
      });
      yield* insertActivity(sql, {
        activityId: "act-seq-completed",
        threadId: "thread-seq",
        kind: "task.completed",
        payloadJson: '{"taskId":"task-1","status":"completed"}',
        sequence: 2,
        createdAt: "2026-02-24T00:01:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{ readonly hasRunningSubagents: number }>`
        SELECT has_running_subagents AS "hasRunningSubagents"
        FROM projection_threads
        WHERE thread_id = 'thread-seq'
      `;

      assert.deepStrictEqual(rows, [{ hasRunningSubagents: 0 }]);
    }),
  );

  it.effect("is idempotent when re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      // Re-running the migration must not fail on the already-present column.
      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.isTrue(columns.some((column) => column.name === "has_running_subagents"));
    }),
  );
});
