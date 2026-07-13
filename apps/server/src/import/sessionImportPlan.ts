import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
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

const isProviderInstanceUsable = (snapshot: ServerProvider): boolean =>
  snapshot.enabled && snapshot.availability !== "unavailable";

/**
 * Resolves the model selection an imported thread must run under.
 *
 * The thread's `modelSelection.instanceId` is what the composer locks the thread to and what the
 * runtime binding routes the resume cursor through, so it has to name an instance of the session's
 * own driver. A caller-supplied selection is honoured only when it already does; otherwise it is
 * replaced, because carrying it through would hand a Claude cursor to the Codex adapter and lock
 * the thread to a provider that cannot resume it.
 *
 * Returns `null` when the session's driver has no usable instance — the caller is expected to fail
 * the import rather than create a thread whose original context can never be resumed.
 */
export const resolveImportModelSelection = (input: {
  readonly driverKind: ProviderDriverKind;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly requested: ModelSelection;
}): ModelSelection | null => {
  const requestedSnapshot = input.providers.find(
    (candidate) => candidate.instanceId === input.requested.instanceId,
  );
  if (
    requestedSnapshot !== undefined &&
    requestedSnapshot.driver === input.driverKind &&
    isProviderInstanceUsable(requestedSnapshot)
  ) {
    return input.requested;
  }

  const defaultInstanceId = defaultInstanceIdForDriver(input.driverKind);
  const usable = input.providers.filter(
    (candidate) => candidate.driver === input.driverKind && isProviderInstanceUsable(candidate),
  );
  const snapshot =
    usable.find((candidate) => candidate.instanceId === defaultInstanceId) ?? usable[0];
  if (snapshot === undefined) return null;

  // Custom models are user-authored aliases that may point anywhere; the first stock model is the
  // safest default for a thread the user did not pick a model for.
  const model = snapshot.models.find((candidate) => !candidate.isCustom) ?? snapshot.models[0];
  if (model === undefined) return null;

  return { instanceId: snapshot.instanceId, model: model.slug };
};

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
