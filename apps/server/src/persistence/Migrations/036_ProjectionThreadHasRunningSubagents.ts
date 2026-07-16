import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Add the column only when absent. A bare `Effect.catch(() => Effect.void)`
  // would tolerate a re-run's "duplicate column name" but ALSO swallow every
  // other failure (locked DB, disk error) — silently skipping the backfill.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "has_running_subagents")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN has_running_subagents INTEGER NOT NULL DEFAULT 0
    `;
  }

  // Backfill only for threads whose session is currently running AND whose
  // latest task.* activity is still open. Historical threads with orphaned open
  // tasks (interrupt / crash / server death) must NOT be baked in as running —
  // a dead session cannot have live subagents. The EXISTS guard lets the
  // majority of threads (no task activity) skip the json_extract scan entirely.
  yield* sql`
    UPDATE projection_threads
    SET has_running_subagents = 1
    WHERE EXISTS (
        SELECT 1
        FROM projection_thread_sessions AS session
        WHERE session.thread_id = projection_threads.thread_id
          AND session.status = 'running'
      )
      AND EXISTS (
        SELECT 1
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_threads.thread_id
          AND activity.kind IN ('task.started', 'task.progress', 'task.completed')
      )
      AND COALESCE((
        WITH latest_task_states AS (
          SELECT
            latest.task_id,
            latest.kind
          FROM (
            SELECT
              json_extract(activity.payload_json, '$.taskId') AS task_id,
              activity.kind,
              ROW_NUMBER() OVER (
                PARTITION BY json_extract(activity.payload_json, '$.taskId')
                ORDER BY
                  CASE WHEN activity.sequence IS NULL THEN 0 ELSE 1 END DESC,
                  activity.sequence DESC,
                  activity.created_at DESC,
                  activity.activity_id DESC
              ) AS row_number
            FROM projection_thread_activities AS activity
            WHERE activity.thread_id = projection_threads.thread_id
              AND json_extract(activity.payload_json, '$.taskId') IS NOT NULL
              AND activity.kind IN (
                'task.started',
                'task.progress',
                'task.completed'
              )
          ) AS latest
          WHERE latest.row_number = 1
        )
        SELECT CASE
          WHEN EXISTS (
            SELECT 1
            FROM latest_task_states
            WHERE latest_task_states.kind IN ('task.started', 'task.progress')
          )
            THEN 1
            ELSE 0
          END
      ), 0) = 1
  `;
});
