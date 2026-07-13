import * as DateTime from "effect/DateTime";

import type { ImportableProvider, ImportedMessage } from "./sessionTranscript.ts";

/**
 * Pure planning logic for a session import: the resume cursor handed to the provider adapter and
 * the synthetic timestamps used to order backfilled history.
 */

export interface PlannedMessage {
  readonly messageId: string;
  readonly role: ImportedMessage["role"];
  readonly text: string;
  readonly createdAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/**
 * Session files are keyed by product name, while the provider registry keys drivers by slug — and
 * Claude's driver slug is `claudeAgent`, not `claude`. Binding to the wrong slug would leave the
 * thread pointing at a driver that does not exist.
 */
export const driverKindForProvider = (provider: ImportableProvider): string =>
  provider === "claude" ? "claudeAgent" : "codex";

/**
 * Builds the provider-native resume cursor.
 *
 * Claude's adapter drops a cursor whose `resume` is not a UUID, and Codex silently falls back to a
 * fresh thread when `thread/resume` cannot find the id — both failures look like a successful
 * import that quietly forgot everything, so an unusable id is rejected up front instead.
 */
export const buildResumeCursor = (
  provider: ImportableProvider,
  sessionId: string,
): Record<string, unknown> | null => {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) return null;

  if (provider === "claude") {
    if (!isUuid(trimmed)) return null;
    return { resume: trimmed, turnCount: 0 };
  }

  return { threadId: trimmed };
};

/** Backfilled messages must sort strictly before anything the user sends after importing. */
const MIN_STEP_MS = 1;

/**
 * Assigns each backfilled message a distinct, monotonically increasing ISO timestamp.
 *
 * The thread timeline sorts on `createdAt` alone with no stable tie-break, so identical timestamps
 * would render history in an arbitrary order. Original timestamps are preserved where they are
 * usable and strictly increasing; anything missing or out of order is nudged forward instead.
 */
export const planBackfillMessages = (
  messages: ReadonlyArray<ImportedMessage>,
  fallbackStartMs: number,
): Array<PlannedMessage> => {
  const planned: Array<PlannedMessage> = [];
  let previousMs = Number.NEGATIVE_INFINITY;

  messages.forEach((message, index) => {
    const parsed = message.timestamp === null ? Number.NaN : Date.parse(message.timestamp);
    const candidateMs = Number.isNaN(parsed) ? fallbackStartMs + index : parsed;
    const ms =
      previousMs === Number.NEGATIVE_INFINITY
        ? candidateMs
        : Math.max(candidateMs, previousMs + MIN_STEP_MS);
    previousMs = ms;

    planned.push({
      // Zero-padded ordinal keeps the id-based tie-break aligned with transcript order.
      messageId: `import-${String(index).padStart(5, "0")}`,
      role: message.role,
      text: message.text,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(ms)),
    });
  });

  return planned;
};
