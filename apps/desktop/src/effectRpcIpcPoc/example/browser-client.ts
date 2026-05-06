import { Effect, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  getEffectElectronIpcRendererBridge,
  makeEffectElectronIpcRendererPort,
  makeEffectElectronIpcRendererProtocol,
} from "effect-electron-ipc/client";
import {
  DESKTOP_IPC_POC_METHODS,
  makeDesktopIpcPocClient,
  type DesktopIpcPocClient,
  type DesktopIpcPocEchoError,
  type DesktopIpcPocEchoResult,
  type DesktopIpcPocRuntimeInfo,
  type DesktopIpcPocTick,
} from "./protocol.ts";

export interface DesktopIpcPocSnapshot {
  readonly runtimeInfo: DesktopIpcPocRuntimeInfo;
  readonly echo: DesktopIpcPocEchoResult;
  readonly ticks: ReadonlyArray<DesktopIpcPocTick>;
}

export const makeDesktopIpcPocBrowserClient: Effect.Effect<
  DesktopIpcPocClient,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const bridge = yield* Effect.sync(() => getEffectElectronIpcRendererBridge());
  const rendererPort = makeEffectElectronIpcRendererPort(bridge);
  const rendererProtocol = yield* makeEffectElectronIpcRendererProtocol(rendererPort);

  return yield* makeDesktopIpcPocClient.pipe(
    Effect.provideService(RpcClient.Protocol, rendererProtocol),
  );
});

export const loadDesktopIpcPocSnapshot: Effect.Effect<
  DesktopIpcPocSnapshot,
  DesktopIpcPocEchoError | RpcClientError,
  Scope.Scope
> = Effect.gen(function* () {
  const client = yield* makeDesktopIpcPocBrowserClient;
  const runtimeInfo = yield* client[DESKTOP_IPC_POC_METHODS.getRuntimeInfo]({});
  const echo = yield* client[DESKTOP_IPC_POC_METHODS.echo]({
    text: "hello from the renderer",
  });
  const ticks = yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({
    take: 3,
  }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

  return {
    runtimeInfo,
    echo,
    ticks,
  };
});
