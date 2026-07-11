import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_ledger_entries (
      activity_id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      turn_id TEXT,
      provider_name TEXT,
      model TEXT,
      day TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_day
    ON usage_ledger_entries(day)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_project_day
    ON usage_ledger_entries(project_id, day)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_thread
    ON usage_ledger_entries(thread_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS usage_ledger_cursors (
      thread_id TEXT PRIMARY KEY NOT NULL,
      last_total_processed INTEGER NOT NULL DEFAULT 0,
      last_activity_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
