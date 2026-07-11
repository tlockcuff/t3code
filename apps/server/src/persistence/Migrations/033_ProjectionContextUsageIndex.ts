import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_context_window
    ON projection_thread_activities(kind, thread_id, sequence DESC, created_at DESC, activity_id DESC)
  `;
});
