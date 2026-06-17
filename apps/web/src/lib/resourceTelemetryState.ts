import { useAtomValue } from "@effect/atom-react";
import type {
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import {
  getPrimaryEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { ensureLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const RESOURCE_TELEMETRY_HISTORY_STALE_TIME_MS = 5_000;
const RESOURCE_TELEMETRY_IDLE_TTL_MS = 5 * 60_000;
const RESOURCE_TELEMETRY_HISTORY_INPUT_SEPARATOR = ":";

interface ResourceTelemetryLiveState {
  readonly data: ResourceTelemetrySnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

const resourceTelemetryLiveAtom = Atom.make<ResourceTelemetryLiveState>({
  data: null,
  error: null,
  isPending: true,
}).pipe(Atom.keepAlive, Atom.withLabel("resource-telemetry-live"));

function formatResourceTelemetryError(error: unknown): string {
  return error instanceof Error ? error.message : "Failed to load resource telemetry.";
}

function updateLiveState(
  update: (current: ResourceTelemetryLiveState) => ResourceTelemetryLiveState,
): void {
  appAtomRegistry.set(
    resourceTelemetryLiveAtom,
    update(appAtomRegistry.get(resourceTelemetryLiveAtom)),
  );
}

let retainCount = 0;
let requestGeneration = 0;
let activeClient: object | null = null;
let unsubscribeTelemetry: () => void = () => undefined;
let unsubscribeConnections: () => void = () => undefined;

function applySnapshot(snapshot: ResourceTelemetrySnapshot): void {
  updateLiveState(() => ({
    data: snapshot,
    error: null,
    isPending: false,
  }));
}

function refreshFromCurrentClient(): void {
  const generation = ++requestGeneration;
  updateLiveState((current) => ({
    ...current,
    error: null,
    isPending: true,
  }));

  let server: ReturnType<typeof getPrimaryEnvironmentConnection>["client"]["server"];
  try {
    server = getPrimaryEnvironmentConnection().client.server;
  } catch (error) {
    if (generation !== requestGeneration) return;
    updateLiveState((current) => ({
      ...current,
      error: formatResourceTelemetryError(error),
      isPending: false,
    }));
    return;
  }

  void server.getResourceTelemetry().then(
    (snapshot) => {
      if (generation !== requestGeneration) return;
      applySnapshot(snapshot);
    },
    (error: unknown) => {
      if (generation !== requestGeneration) return;
      updateLiveState((current) => ({
        ...current,
        error: formatResourceTelemetryError(error),
        isPending: false,
      }));
    },
  );
}

function attachResourceTelemetry(): void {
  let client: ReturnType<typeof getPrimaryEnvironmentConnection>["client"];
  try {
    client = getPrimaryEnvironmentConnection().client;
  } catch (error) {
    activeClient = null;
    unsubscribeTelemetry();
    unsubscribeTelemetry = () => undefined;
    updateLiveState((current) => ({
      ...current,
      error: formatResourceTelemetryError(error),
      isPending: false,
    }));
    return;
  }

  if (client === activeClient) {
    return;
  }

  activeClient = client;
  unsubscribeTelemetry();
  refreshFromCurrentClient();
  unsubscribeTelemetry = client.server.subscribeResourceTelemetry(applySnapshot, {
    onResubscribe: refreshFromCurrentClient,
  });
}

function retainResourceTelemetry(): () => void {
  retainCount += 1;
  if (retainCount === 1) {
    unsubscribeConnections = subscribeEnvironmentConnections(() => {
      activeClient = null;
      attachResourceTelemetry();
    });
    attachResourceTelemetry();
  }

  return () => {
    retainCount = Math.max(0, retainCount - 1);
    if (retainCount !== 0) return;
    requestGeneration += 1;
    activeClient = null;
    unsubscribeTelemetry();
    unsubscribeTelemetry = () => undefined;
    unsubscribeConnections();
    unsubscribeConnections = () => undefined;
  };
}

function formatHistoryKey(input: ResourceTelemetryHistoryInput): string {
  return `${input.windowMs}${RESOURCE_TELEMETRY_HISTORY_INPUT_SEPARATOR}${input.bucketMs}`;
}

function parseHistoryKey(key: string): ResourceTelemetryHistoryInput {
  const [windowMs = "0", bucketMs = "0"] = key.split(RESOURCE_TELEMETRY_HISTORY_INPUT_SEPARATOR);
  return {
    windowMs: Number(windowMs),
    bucketMs: Number(bucketMs),
  };
}

const resourceTelemetryHistoryAtom = Atom.family((key: string) => {
  const input = parseHistoryKey(key);
  return Atom.make(
    Effect.promise(() => ensureLocalApi().server.getResourceTelemetryHistory(input)),
  ).pipe(
    Atom.swr({
      staleTime: RESOURCE_TELEMETRY_HISTORY_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(RESOURCE_TELEMETRY_IDLE_TTL_MS),
    Atom.withLabel(`resource-telemetry-history:${key}`),
  );
});

export interface ResourceTelemetryState extends ResourceTelemetryLiveState {
  readonly refresh: () => void;
  readonly retry: () => Promise<ResourceTelemetrySnapshot>;
}

export interface ResourceTelemetryHistoryState {
  readonly data: ResourceTelemetryHistory | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function refreshResourceTelemetry(): void {
  refreshFromCurrentClient();
}

export async function retryResourceTelemetry(): Promise<ResourceTelemetrySnapshot> {
  const result = await ensureLocalApi().server.retryResourceTelemetry();
  applySnapshot(result.snapshot);
  return result.snapshot;
}

export function useResourceTelemetry(): ResourceTelemetryState {
  useEffect(retainResourceTelemetry, []);
  const state = useAtomValue(resourceTelemetryLiveAtom);
  const refresh = useCallback(refreshResourceTelemetry, []);
  const retry = useCallback(() => retryResourceTelemetry(), []);

  return {
    ...state,
    refresh,
    retry,
  };
}

export function useResourceTelemetryHistory(
  input: ResourceTelemetryHistoryInput,
): ResourceTelemetryHistoryState {
  const atom = resourceTelemetryHistoryAtom(formatHistoryKey(input));
  const result = useAtomValue(atom);
  const data = Option.getOrNull(AsyncResult.value(result));
  const refresh = useCallback(() => {
    appAtomRegistry.refresh(atom);
  }, [atom]);

  return {
    data,
    error:
      result._tag === "Failure" ? formatResourceTelemetryError(Cause.squash(result.cause)) : null,
    isPending: result.waiting,
    refresh,
  };
}
