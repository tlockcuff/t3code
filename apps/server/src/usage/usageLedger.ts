import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import { computeTokenUsageDelta, dayKeyFromIso } from "./tokenUsageDelta.ts";
import { estimateCostUsd, MODEL_PRICING_VERSION, roundUsd } from "./modelPricing.ts";

export type UsageLedgerWriteInput = {
  readonly activityId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly payload: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractUsagePayload(payload: unknown) {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    totalProcessedTokens: asFiniteNumber(record.totalProcessedTokens),
    lastInputTokens: asFiniteNumber(record.lastInputTokens),
    lastCachedInputTokens: asFiniteNumber(record.lastCachedInputTokens),
    lastOutputTokens: asFiniteNumber(record.lastOutputTokens),
    lastReasoningOutputTokens: asFiniteNumber(record.lastReasoningOutputTokens),
    lastUsedTokens: asFiniteNumber(record.lastUsedTokens),
    inputTokens: asFiniteNumber(record.inputTokens),
    cachedInputTokens: asFiniteNumber(record.cachedInputTokens),
    outputTokens: asFiniteNumber(record.outputTokens),
    reasoningOutputTokens: asFiniteNumber(record.reasoningOutputTokens),
  };
}

function mapLedgerSqlError(operation: string) {
  return (error: unknown): ProjectionRepositoryError =>
    isPersistenceError(error) ? error : toPersistenceSqlError(operation)(error);
}

export const recordUsageLedgerFromActivity = (
  input: UsageLedgerWriteInput,
): Effect.Effect<void, ProjectionRepositoryError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const usage = extractUsagePayload(input.payload);
    if (!usage) return;

    const cursorRows = yield* sql<{
      threadId: string;
      lastTotalProcessed: number;
    }>`
      SELECT
        thread_id AS "threadId",
        last_total_processed AS "lastTotalProcessed"
      FROM usage_ledger_cursors
      WHERE thread_id = ${input.threadId}
      LIMIT 1
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.recordLedgerFromActivity:findCursor")));

    const computed = computeTokenUsageDelta(
      usage,
      cursorRows[0] ? { lastTotalProcessed: cursorRows[0].lastTotalProcessed } : null,
    );
    if (!computed) return;

    if (computed.delta.totalTokens > 0) {
      const metaRows = yield* sql<{
        projectId: string;
        model: string | null;
        providerName: string | null;
      }>`
        SELECT
          t.project_id AS "projectId",
          json_extract(t.model_selection_json, '$.model') AS "model",
          s.provider_name AS "providerName"
        FROM projection_threads t
        LEFT JOIN projection_thread_sessions s
          ON s.thread_id = t.thread_id
        WHERE t.thread_id = ${input.threadId}
        LIMIT 1
      `.pipe(Effect.mapError(mapLedgerSqlError("usage.recordLedgerFromActivity:findThreadMeta")));

      const meta = metaRows[0];
      if (meta) {
        yield* sql`
          INSERT OR IGNORE INTO usage_ledger_entries (
            activity_id,
            thread_id,
            project_id,
            turn_id,
            provider_name,
            model,
            day,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            total_tokens,
            created_at
          ) VALUES (
            ${input.activityId},
            ${input.threadId},
            ${meta.projectId},
            ${input.turnId},
            ${meta.providerName},
            ${meta.model},
            ${dayKeyFromIso(input.createdAt)},
            ${computed.delta.inputTokens},
            ${computed.delta.cachedInputTokens},
            ${computed.delta.outputTokens},
            ${computed.delta.reasoningOutputTokens},
            ${computed.delta.totalTokens},
            ${input.createdAt}
          )
        `.pipe(Effect.mapError(mapLedgerSqlError("usage.recordLedgerFromActivity:insert")));
      }
    }

    yield* sql`
      INSERT INTO usage_ledger_cursors (
        thread_id,
        last_total_processed,
        last_activity_id,
        updated_at
      ) VALUES (
        ${input.threadId},
        ${computed.nextCursor.lastTotalProcessed},
        ${input.activityId},
        ${input.createdAt}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        last_total_processed = excluded.last_total_processed,
        last_activity_id = excluded.last_activity_id,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.recordLedgerFromActivity:upsertCursor")));
  });

export const syncUsageLedgerAfterThreadRevert = (
  threadId: string,
  updatedAt: string,
): Effect.Effect<void, ProjectionRepositoryError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM usage_ledger_entries
      WHERE thread_id = ${threadId}
        AND activity_id NOT IN (
          SELECT activity_id
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
        )
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.syncLedgerAfterThreadRevert:delete")));

    const latest = yield* sql<{ lastTotal: number | null }>`
      SELECT MAX(
        CAST(json_extract(payload_json, '$.totalProcessedTokens') AS INTEGER)
      ) AS "lastTotal"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND kind = 'context-window.updated'
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.syncLedgerAfterThreadRevert:latest")));

    const lastTotal = latest[0]?.lastTotal;
    if (typeof lastTotal === "number" && Number.isFinite(lastTotal) && lastTotal >= 0) {
      yield* sql`
        INSERT INTO usage_ledger_cursors (
          thread_id,
          last_total_processed,
          last_activity_id,
          updated_at
        ) VALUES (
          ${threadId},
          ${lastTotal},
          NULL,
          ${updatedAt}
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          last_total_processed = excluded.last_total_processed,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(mapLedgerSqlError("usage.syncLedgerAfterThreadRevert:cursor")));
      return;
    }

    yield* sql`
      DELETE FROM usage_ledger_cursors WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.syncLedgerAfterThreadRevert:deleteCursor")));
  });

const ActivityBackfillRow = Schema.Struct({
  activityId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  payloadJson: Schema.String,
});

export const backfillUsageLedger = (): Effect.Effect<
  { readonly inserted: number; readonly skipped: boolean },
  ProjectionRepositoryError,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const existing = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM usage_ledger_entries
    `.pipe(Effect.mapError(mapLedgerSqlError("usage.backfillLedger:count")));
    if ((existing[0]?.count ?? 0) > 0) {
      return { inserted: 0, skipped: true };
    }

    const listActivities = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ActivityBackfillRow,
      execute: () => sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          created_at AS "createdAt",
          payload_json AS "payloadJson"
        FROM projection_thread_activities
        WHERE kind = 'context-window.updated'
        ORDER BY thread_id ASC,
          COALESCE(sequence, -1) ASC,
          created_at ASC,
          activity_id ASC
      `,
    });

    const rows = yield* listActivities(undefined).pipe(
      Effect.mapError(mapLedgerSqlError("usage.backfillLedger:list")),
    );

    const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
    let inserted = 0;
    for (const row of rows) {
      const payload = decodePayload(row.payloadJson);
      if (payload._tag === "None") continue;
      const before = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM usage_ledger_entries WHERE activity_id = ${row.activityId}
      `.pipe(Effect.mapError(mapLedgerSqlError("usage.backfillLedger:exists")));
      yield* recordUsageLedgerFromActivity({
        activityId: row.activityId,
        threadId: row.threadId,
        turnId: row.turnId,
        createdAt: row.createdAt,
        payload: payload.value,
      });
      const after = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM usage_ledger_entries WHERE activity_id = ${row.activityId}
      `.pipe(Effect.mapError(mapLedgerSqlError("usage.backfillLedger:existsAfter")));
      if ((after[0]?.count ?? 0) > (before[0]?.count ?? 0)) {
        inserted += 1;
      }
    }

    return { inserted, skipped: false };
  });

export type UsageLedgerDayAggregate = {
  readonly day: string;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  readonly model: string | null;
  readonly providerName: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
};

export type UsageLedgerQueryResult = {
  readonly rows: ReadonlyArray<UsageLedgerDayAggregate>;
  readonly totals: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly totalTokens: number;
    readonly estimatedCostUsd: number;
  };
  readonly pricingVersion: string;
};

const DayAggregateRow = Schema.Struct({
  day: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  projectTitle: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  inputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  outputTokens: Schema.Number,
  reasoningOutputTokens: Schema.Number,
  totalTokens: Schema.Number,
});

export const listUsageLedgerAggregates = (input: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly projectId?: string;
}): Effect.Effect<UsageLedgerQueryResult, ProjectionRepositoryError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* backfillUsageLedger();
    const sql = yield* SqlClient.SqlClient;

    const listRows = SqlSchema.findAll({
      Request: Schema.Struct({
        fromDay: Schema.NullOr(Schema.String),
        toDay: Schema.NullOr(Schema.String),
        projectId: Schema.NullOr(Schema.String),
      }),
      Result: DayAggregateRow,
      execute: ({ fromDay, toDay, projectId }) => sql`
        SELECT
          e.day AS "day",
          e.project_id AS "projectId",
          p.title AS "projectTitle",
          e.model AS "model",
          e.provider_name AS "providerName",
          SUM(e.input_tokens) AS "inputTokens",
          SUM(e.cached_input_tokens) AS "cachedInputTokens",
          SUM(e.output_tokens) AS "outputTokens",
          SUM(e.reasoning_output_tokens) AS "reasoningOutputTokens",
          SUM(e.total_tokens) AS "totalTokens"
        FROM usage_ledger_entries e
        LEFT JOIN projection_projects p
          ON p.project_id = e.project_id
        WHERE (${fromDay} IS NULL OR e.day >= ${fromDay})
          AND (${toDay} IS NULL OR e.day <= ${toDay})
          AND (${projectId} IS NULL OR e.project_id = ${projectId})
        GROUP BY e.day, e.project_id, p.title, e.model, e.provider_name
        ORDER BY e.day DESC, p.title ASC, e.model ASC
      `,
    });

    const decoded = yield* listRows({
      fromDay: input.fromDay ?? null,
      toDay: input.toDay ?? null,
      projectId: input.projectId ?? null,
    }).pipe(Effect.mapError(mapLedgerSqlError("usage.listLedgerAggregates:query")));

    const aggregates: Array<UsageLedgerDayAggregate> = decoded.map((row) => {
      const estimatedCostUsd = roundUsd(
        estimateCostUsd({
          model: row.model,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          outputTokens: row.outputTokens,
          reasoningOutputTokens: row.reasoningOutputTokens,
          totalTokens: row.totalTokens,
        }),
      );
      return {
        day: row.day,
        projectId: row.projectId,
        projectTitle:
          row.projectTitle && row.projectTitle.trim().length > 0 ? row.projectTitle.trim() : null,
        model: row.model && row.model.trim().length > 0 ? row.model.trim() : null,
        providerName:
          row.providerName && row.providerName.trim().length > 0 ? row.providerName.trim() : null,
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
        reasoningOutputTokens: row.reasoningOutputTokens,
        totalTokens: row.totalTokens,
        estimatedCostUsd,
      };
    });

    const totals = aggregates.reduce(
      (acc, row) => ({
        inputTokens: acc.inputTokens + row.inputTokens,
        cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + row.reasoningOutputTokens,
        totalTokens: acc.totalTokens + row.totalTokens,
        estimatedCostUsd: acc.estimatedCostUsd + row.estimatedCostUsd,
      }),
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
    );

    return {
      rows: aggregates,
      totals: {
        ...totals,
        estimatedCostUsd: roundUsd(totals.estimatedCostUsd),
      },
      pricingVersion: MODEL_PRICING_VERSION,
    } satisfies UsageLedgerQueryResult;
  });
