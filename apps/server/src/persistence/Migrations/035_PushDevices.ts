import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Self-hosted APNs push: device tokens registered directly by paired mobile
// clients, bypassing the managed relay. One row per device; re-registration
// upserts on device_id.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_devices (
      device_id TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL,
      push_token TEXT NOT NULL,
      bundle_id TEXT,
      aps_environment TEXT NOT NULL,
      app_version TEXT,
      ios_major_version INTEGER NOT NULL,
      notifications_enabled INTEGER NOT NULL DEFAULT 0,
      notify_on_approval INTEGER NOT NULL DEFAULT 1,
      notify_on_input INTEGER NOT NULL DEFAULT 1,
      notify_on_completion INTEGER NOT NULL DEFAULT 1,
      notify_on_failure INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `;
});
