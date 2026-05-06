import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadDesktopIpcPocSnapshot,
  makeDesktopIpcPocBrowserClient,
} from "./effectRpcIpcPoc/example/browser-client.ts";
import { runDesktopIpcPocRpcServer } from "./effectRpcIpcPoc/example/rpc-server.ts";
import { DESKTOP_IPC_POC_METHODS } from "./effectRpcIpcPoc/example/protocol.ts";
import { EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY } from "effect-electron-ipc/ipc";
import type {
  EffectElectronIpcMainFrame,
  EffectElectronIpcMainSource,
  EffectElectronIpcRendererBridge,
  EffectElectronIpcRendererFrame,
} from "effect-electron-ipc/ipc";

describe("effect RPC over Electron IPC proof of concept", () => {
  it("runs the end-to-end consumer example over the Electron IPC transport", async () => {
    const ipc = new InMemoryEffectElectronIpc();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runDesktopIpcPocRpcServer({
            port: ipc.mainPort,
            appVersion: "1.2.3",
            platform: "test-os",
            now: () => new Date("2026-05-06T12:00:00.000Z"),
          });

          return yield* withEffectElectronIpcRendererBridge(
            ipc.rendererPort,
            loadDesktopIpcPocSnapshot,
          );
        }),
      ),
    );

    expect(result).toEqual({
      runtimeInfo: {
        appVersion: "1.2.3",
        platform: "test-os",
        ipcTransport: "electron-ipc",
      },
      echo: {
        text: "hello from the renderer",
        echoedAt: "2026-05-06T12:00:00.000Z",
      },
      ticks: [
        { sequence: 1, label: "tick:1" },
        { sequence: 2, label: "tick:2" },
        { sequence: 3, label: "tick:3" },
      ],
    });
  });

  it("lets browser code consume the generated Effect RPC client directly", async () => {
    const ipc = new InMemoryEffectElectronIpc();

    const ticks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runDesktopIpcPocRpcServer({
            port: ipc.mainPort,
            appVersion: "0.0.0-test",
            platform: "test-os",
          });

          return yield* withEffectElectronIpcRendererBridge(
            ipc.rendererPort,
            Effect.gen(function* () {
              const client = yield* makeDesktopIpcPocBrowserClient;

              return yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({ take: 3 }).pipe(
                Stream.runCollect,
                Effect.map((chunk) => Array.from(chunk)),
              );
            }),
          );
        }),
      ),
    );

    expect(ticks).toEqual([
      { sequence: 1, label: "tick:1" },
      { sequence: 2, label: "tick:2" },
      { sequence: 3, label: "tick:3" },
    ]);
  });

  it("round-trips typed app-level RPC errors", async () => {
    const ipc = new InMemoryEffectElectronIpc();

    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runDesktopIpcPocRpcServer({
            port: ipc.mainPort,
            appVersion: "0.0.0-test",
            platform: "test-os",
          });

          return yield* withEffectElectronIpcRendererBridge(
            ipc.rendererPort,
            Effect.gen(function* () {
              const client = yield* makeDesktopIpcPocBrowserClient;

              return yield* client[DESKTOP_IPC_POC_METHODS.echo]({ text: "" }).pipe(Effect.flip);
            }),
          );
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "DesktopIpcPocEchoError",
      reason: "empty-text",
      message: "Echo text cannot be empty.",
    });
  });
});

class InMemoryEffectElectronIpc {
  private readonly mainListeners = new Set<
    (source: EffectElectronIpcMainSource, frame: EffectElectronIpcRendererFrame) => void
  >();
  private readonly rendererListeners = new Set<(frame: EffectElectronIpcMainFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  readonly source: EffectElectronIpcMainSource = {
    id: 1,
    send: (frame) => {
      queueMicrotask(() => {
        for (const listener of this.rendererListeners) {
          listener(frame);
        }
      });
    },
    isClosed: () => this.closed,
    onClose: (listener) => {
      this.closeListeners.add(listener);
      return () => {
        this.closeListeners.delete(listener);
      };
    },
  };

  readonly mainPort = {
    subscribe: (
      listener: (
        source: EffectElectronIpcMainSource,
        frame: EffectElectronIpcRendererFrame,
      ) => void,
    ) => {
      this.mainListeners.add(listener);
      return () => {
        this.mainListeners.delete(listener);
      };
    },
  };

  readonly rendererPort = {
    send: (frame: EffectElectronIpcRendererFrame) => {
      queueMicrotask(() => {
        for (const listener of this.mainListeners) {
          listener(this.source, frame);
        }
      });
    },
    subscribe: (listener: (frame: EffectElectronIpcMainFrame) => void) => {
      this.rendererListeners.add(listener);
      return () => {
        this.rendererListeners.delete(listener);
      };
    },
  };

  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

const withEffectElectronIpcRendererBridge = <A, E, R>(
  bridge: EffectElectronIpcRendererBridge,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const globalObject = globalThis as Partial<
        Record<typeof EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY, EffectElectronIpcRendererBridge>
      >;
      const previousBridge = globalObject[EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY];
      globalObject[EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY] = bridge;

      return () => {
        if (previousBridge !== undefined) {
          globalObject[EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY] = previousBridge;
        } else {
          delete globalObject[EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY];
        }
      };
    }),
    () => effect,
    (restore) => Effect.sync(restore),
  );
