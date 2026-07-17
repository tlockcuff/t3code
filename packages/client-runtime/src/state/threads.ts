import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  SNAPSHOT_EPOCH_WILDCARD,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

// Exponential backoff for retrying transient expected failures on the thread
// subscription. Starts at 250ms (matching the previous fixed retry) and doubles
// up to a 5s cap so a persistently failing subscription no longer hammers the
// server ~4x/s over cellular for the whole atom TTL.
const THREAD_RETRY_BASE_DELAY_MS = 250;
const THREAD_RETRY_MAX_DELAY_MS = 5_000;

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

/**
 * A warm cache with no messages is unsafe to resume via `afterSequence` alone.
 * Cursor replay only delivers events after the cached sequence — if the cache
 * ever saved an empty message list at a high sequence (common after
 * `thread.created` / early dispose, or a partial persist), historical
 * `thread.message-sent` events are skipped and the UI stays on the empty
 * conversation prompt until a full page reload rebuilds state.
 *
 * Prefer an HTTP snapshot whenever the cache has no messages. Empty threads
 * are cheap; recovering real history is correctness-critical.
 */
export function shouldRevalidateEmptyThreadCache(thread: OrchestrationThread): boolean {
  return thread.messages.length === 0;
}

/**
 * A thread-not-found failure is terminal: the thread no longer exists on the
 * server, so retrying the subscription can only re-fail forever. The subscribe
 * handler raises this as `OrchestrationGetSnapshotError` with a "was not found"
 * message (see the server's `subscribeThread` handler) — distinct from a
 * transient snapshot/replay error, which uses a different message and should be
 * retried with backoff.
 */
function isThreadNotFoundFailure(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) {
      return false;
    }
    const error = reason.error;
    return (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag: unknown })._tag === "OrchestrationGetSnapshotError" &&
      "message" in error &&
      typeof (error as { message: unknown }).message === "string" &&
      (error as { message: string }).message.endsWith("was not found")
    );
  });
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.thread);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  // Track the epoch the resume cursor belongs to. Sent on subscribe so the
  // server can detect a DB reset/restore (new epoch) and serve a fresh snapshot
  // instead of a cursor replay the client could never reconcile. Refreshed on
  // every snapshot frame so a post-reset snapshot re-anchors the epoch.
  const lastEpoch = yield* SubscriptionRef.make(
    Option.match(cached, {
      onNone: () => Option.none<string>(),
      onSome: (snapshot) => Option.some(snapshot.epoch),
    }),
  );
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
  }));
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
      error: Option.some(formatThreadError(cause)),
    }));

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationThread,
  ) {
    yield* SubscriptionRef.set(state, {
      data: Option.some(thread),
      status: "live",
      error: Option.none(),
    });
    // Persist the thread together with the sequence AND epoch it reflects so the
    // next warm cache can resume from exactly here — and so a later epoch check
    // can detect a server reset/restore.
    const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
    const epoch = yield* SubscriptionRef.get(lastEpoch);
    yield* Queue.offer(persistence, {
      snapshotSequence,
      epoch: Option.getOrElse(epoch, () => SNAPSHOT_EPOCH_WILDCARD),
      thread,
    });
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  // Load a fresh detail snapshot over HTTP, waiting for a prepared connection so
  // the request can be authenticated (mirrors the socket path, which waits for a
  // live session). Returns `Option.none()` when no snapshot can be established.
  const loadColdSnapshot = Effect.fn("EnvironmentThreadState.loadColdSnapshot")(function* () {
    const prepared = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
      Stream.filter(Option.isSome),
      Stream.map((current) => current.value),
      Stream.runHead,
    );
    return Option.isSome(prepared)
      ? yield* snapshotLoader.load(prepared.value, threadId)
      : Option.none<OrchestrationThreadDetailSnapshot>();
  });

  // Set when an empty warm cache could not be revalidated over HTTP. Cleared
  // once a live snapshot frame arrives so subsequent resumes can use cursors.
  const forceFullSnapshotResumeRef = yield* Ref.make(false);

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationThreadStreamItem,
  ) {
    if (item.kind === "snapshot") {
      // Advance the cursor first: `setThread` reads it to tag the persisted
      // snapshot with the sequence it reflects. Re-anchor the epoch too: a fresh
      // snapshot served after a server reset/restore carries the new epoch, and
      // wholesale-replacing the thread discards the pre-reset cached state.
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* SubscriptionRef.set(lastEpoch, Option.some(item.snapshot.epoch));
      yield* Ref.set(forceFullSnapshotResumeRef, false);
      yield* setThread(item.snapshot.thread);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* SubscriptionRef.set(lastSequence, item.event.sequence);
        yield* setDeleted();
        return;
      }
      // A non-delete event arrived with no base thread data to apply it to.
      // Do NOT advance the cursor: consuming-but-not-applying it would let a
      // later resubscribe skip past it permanently (the previous code advanced
      // the cursor unconditionally, dropping the event). Instead reload a fresh
      // snapshot; applying it advances the cursor past this event, and any
      // events replayed after it dedupe by sequence.
      const reloaded = yield* loadColdSnapshot();
      if (Option.isSome(reloaded)) {
        // Advance the cursor first: `setThread` reads it to tag the persisted
        // snapshot with the sequence it reflects.
        yield* SubscriptionRef.set(lastSequence, reloaded.value.snapshotSequence);
        yield* SubscriptionRef.set(lastEpoch, Option.some(reloaded.value.epoch));
        yield* setThread(reloaded.value.thread);
      }
      return;
    }
    // The event applies against real base data, so advance the cursor before
    // reducing (`setThread` tags the persisted snapshot with this sequence). A
    // "unchanged" result is still fully consumed — it just doesn't mutate this
    // thread — so the cursor advances for it too.
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);
    const result = applyThreadDetailEvent(current.data.value, item.event);
    if (result.kind === "updated") {
      yield* setThread(result.thread);
    } else if (result.kind === "deleted") {
      yield* setDeleted();
    }
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  // A thread-not-found failure is terminal; firing this interrupts the whole
  // subscription so the retry loop can never re-request a deleted thread.
  const terminated = yield* Deferred.make<void>();
  // Current backoff delay for retrying transient expected failures. Reset to the
  // base whenever an item is successfully applied (the stream recovered).
  const retryDelayMs = yield* Ref.make(THREAD_RETRY_BASE_DELAY_MS);

  const handleExpectedFailure = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      if (isThreadNotFoundFailure(cause)) {
        // The thread no longer exists: surface it as deleted/absent and stop
        // retrying instead of hammering the server ~4x/s until the atom TTL.
        yield* setDeleted();
        yield* Deferred.succeed(terminated, undefined);
        return;
      }
      yield* setStreamError(cause);
      // Back off exponentially (capped) before the subscription is re-issued so
      // a persistently transient failure does not retry forever at 250ms.
      const delayMs = yield* Ref.get(retryDelayMs);
      yield* Ref.set(retryDelayMs, Math.min(delayMs * 2, THREAD_RETRY_MAX_DELAY_MS));
      yield* Effect.sleep(Duration.millis(delayMs));
    });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      // Establish the base snapshot to resume from, minimizing bytes over the
      // wire:
      // - Warm cache with messages: reuse it (zero network) and resume via
      //   `afterSequence` so we only receive events since the cached sequence.
      // - Warm cache with empty messages: revalidate over HTTP. Resuming an
      //   empty cache via `afterSequence` permanently hides earlier message
      //   events and leaves the chat on the empty-conversation prompt.
      // - Cold cache: load the full snapshot over HTTP (gzip-compressible, and
      //   off the socket), then resume via `afterSequence`.
      // If no base can be established we fall back to the socket-embedded
      // snapshot so the thread still synchronizes. Overlapping/replayed events
      // are deduped by sequence in applyItem.
      //
      // When an empty warm cache cannot be revalidated over HTTP, force the
      // socket to send a full snapshot frame (omit `afterSequence`) rather than
      // cursor-replaying past missing history.
      let usedUnrevalidatedEmptyCache = false;
      const base = yield* Effect.gen(function* () {
        if (Option.isNone(cached)) {
          return yield* loadColdSnapshot();
        }
        if (!shouldRevalidateEmptyThreadCache(cached.value.thread)) {
          return cached;
        }
        const revalidated = yield* loadColdSnapshot();
        if (Option.isSome(revalidated)) {
          return revalidated;
        }
        usedUnrevalidatedEmptyCache = true;
        return cached;
      });

      if (Option.isSome(base)) {
        yield* applyItem({ kind: "snapshot", snapshot: base.value });
      }
      // applyItem clears the force flag on every snapshot (including the warm
      // cache seed above). Re-arm it only when that seed was an unrevalidated
      // empty cache so the first socket frame is a full snapshot.
      if (usedUnrevalidatedEmptyCache) {
        yield* Ref.set(forceFullSnapshotResumeRef, true);
      }

      // Resolved per subscription attempt, not once: see the equivalent comment
      // in state/shell.ts. `lastSequence` tracks every applied item, so a
      // reconnect resumes from what we actually hold rather than from the
      // sequence we happened to start with.
      const subscribeInput = () => {
        const afterSequence = SubscriptionRef.getUnsafe(lastSequence);
        if (afterSequence <= 0 || Ref.getUnsafe(forceFullSnapshotResumeRef)) {
          return { threadId };
        }
        // Send the epoch the cursor belongs to so the server can detect a DB
        // reset/restore and reply with a fresh snapshot instead of a doomed
        // cursor replay.
        return Option.match(SubscriptionRef.getUnsafe(lastEpoch), {
          onNone: () => ({ threadId, afterSequence }),
          onSome: (epoch) => ({ threadId, afterSequence, epoch }),
        });
      };

      yield* subscribe(ORCHESTRATION_WS_METHODS.subscribeThread, subscribeInput, {
        onExpectedFailure: handleExpectedFailure,
        // The retry delay is applied inside `handleExpectedFailure` (exponential
        // backoff), so the RPC layer re-subscribes immediately afterwards.
        retryExpectedFailureAfter: "0 millis",
      }).pipe(
        // A recovered stream resets the backoff so the next transient blip
        // starts fresh at the base delay.
        Stream.tap(() => Ref.set(retryDelayMs, THREAD_RETRY_BASE_DELAY_MS)),
        Stream.interruptWhen(Deferred.await(terminated)),
        Stream.runForEach(applyItem),
      );
    }),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([
      SubscriptionRef.get(state),
      SubscriptionRef.get(lastSequence),
      SubscriptionRef.get(lastEpoch),
    ]).pipe(
      Effect.flatMap(([current, snapshotSequence, epoch]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            persist({
              snapshotSequence,
              epoch: Option.getOrElse(epoch, () => SNAPSHOT_EPOCH_WILDCARD),
              thread,
            }),
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
