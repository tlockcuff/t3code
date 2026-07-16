import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Establishes a stable, per-database "epoch" identity used by the resume
 * protocol. Clients dedupe orchestration events purely by sequence and resume
 * with `afterSequence` from their local cache. If the server database is reset,
 * restored from a backup, or otherwise re-created, sequences restart from a
 * lower value — every future event then fails a warm client's sequence check
 * and is silently dropped forever, freezing the UI until app data is cleared.
 *
 * The epoch is generated exactly once, on the first run of this migration for a
 * given database file. A fresh/restored database re-runs the migration and
 * therefore mints a NEW epoch, so the server and its clients can detect the
 * discontinuity: a client resuming with a stale epoch is served a fresh
 * snapshot instead of a cursor-based replay it could never reconcile.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_epoch (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // Insert the singleton epoch row only when absent. hex(randomblob(16)) yields
  // a 32-char random hex string (128 bits) — collision-free across DB
  // lifetimes. INSERT OR IGNORE keeps a re-run (e.g. after a partial migration
  // failure) idempotent without overwriting an already-minted epoch.
  yield* sql`
    INSERT OR IGNORE INTO projection_epoch (id, epoch, created_at)
    VALUES (1, lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `;
});
