import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  DESKTOP_IPC_POC_METHODS,
  DesktopIpcPocRpcGroup,
  type DesktopIpcPocEchoError,
  type DesktopIpcPocEchoResult,
  type DesktopIpcPocRuntimeInfo,
  type DesktopIpcPocTick,
} from "@t3tools/contracts/effectElectronIpcPoc";
import type { Cause } from "effect";
import { AsyncResult, Atom, AtomRpc } from "effect/unstable/reactivity";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  getEffectElectronIpcRendererBridge,
  layerEffectElectronIpcRendererProtocol,
  makeEffectElectronIpcRendererPort,
} from "effect-electron-ipc/client";
import { createRoot } from "react-dom/client";
import type { ReactElement, ReactNode } from "react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

// -----------------------------------------------------------------------------
// example/preload.ts
// -----------------------------------------------------------------------------
// import { contextBridge, ipcRenderer } from "electron";
// import { exposeEffectElectronIpcPreloadBridge } from "effect-electron-ipc/preload";
//
// exposeEffectElectronIpcPreloadBridge({ contextBridge, ipcRenderer });

// -----------------------------------------------------------------------------
// packages/contracts/src/effectElectronIpcPoc.ts
// -----------------------------------------------------------------------------
// The shared contract owns only app-level RPC method names and schemas:
//
//   DESKTOP_IPC_POC_METHODS
//   DesktopIpcPocRuntimeInfo
//   DesktopIpcPocEchoInput
//   DesktopIpcPocEchoResult
//   DesktopIpcPocSubscribeTicksInput
//   DesktopIpcPocTick
//   DesktopIpcPocRpcGroup
//
// The generic Electron transport package does not import these contracts.

// -----------------------------------------------------------------------------
// example/browser-client.ts
// -----------------------------------------------------------------------------
// preload bridge -> Effect Electron IPC renderer protocol layer
//                -> AtomRpc service
//                -> query / mutation atoms with typed success and error values

export interface DesktopIpcPocSnapshot {
  readonly runtimeInfo: DesktopIpcPocRuntimeInfo;
  readonly echo: DesktopIpcPocEchoResult;
  readonly ticks: ReadonlyArray<DesktopIpcPocTick>;
}

export class DesktopIpcPocRpcClient extends AtomRpc.Service<DesktopIpcPocRpcClient>()(
  "desktop-ipc-poc:rpc-client",
  {
    group: DesktopIpcPocRpcGroup,
    protocol: () => {
      const bridge = getEffectElectronIpcRendererBridge();
      const rendererPort = makeEffectElectronIpcRendererPort(bridge);
      return layerEffectElectronIpcRendererProtocol(rendererPort);
    },
  },
) {}

// -----------------------------------------------------------------------------
// example/browser-atoms.ts
// -----------------------------------------------------------------------------

const DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS = 5_000;
const DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS = 60_000;

export const desktopIpcPocRuntimeInfoAtom = DesktopIpcPocRpcClient.query(
  DESKTOP_IPC_POC_METHODS.getRuntimeInfo,
  {},
  { timeToLive: DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS },
).pipe(Atom.keepAlive, Atom.withLabel("desktop-ipc-poc:runtime-info"));

export const desktopIpcPocEchoAtom = DesktopIpcPocRpcClient.query(
  DESKTOP_IPC_POC_METHODS.echo,
  { text: "hello from the renderer" },
  { timeToLive: DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS },
).pipe(
  Atom.swr({
    staleTime: DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS),
  Atom.withLabel("desktop-ipc-poc:echo-query"),
);

export const desktopIpcPocTickPullAtom = DesktopIpcPocRpcClient.query(
  DESKTOP_IPC_POC_METHODS.subscribeTicks,
  { take: 3 },
  { timeToLive: DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS },
).pipe(
  Atom.setIdleTTL(DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS),
  Atom.withLabel("desktop-ipc-poc:tick-pull"),
);

export const desktopIpcPocTicksAtom = Atom.mapResult(
  desktopIpcPocTickPullAtom,
  (pullResult) => pullResult.items,
).pipe(Atom.withLabel("desktop-ipc-poc:ticks"));

export const desktopIpcPocSnapshotAtom = Atom.readable((get) =>
  AsyncResult.all({
    runtimeInfo: get(desktopIpcPocRuntimeInfoAtom),
    echo: get(desktopIpcPocEchoAtom),
    ticks: get(desktopIpcPocTicksAtom),
  }),
).pipe(
  Atom.setIdleTTL(DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS),
  Atom.withLabel("desktop-ipc-poc:snapshot"),
);

export const desktopIpcPocEchoMutationAtom = DesktopIpcPocRpcClient.mutation(
  DESKTOP_IPC_POC_METHODS.echo,
).pipe(Atom.withLabel("desktop-ipc-poc:echo-mutation"));

// -----------------------------------------------------------------------------
// example/components/DesktopIpcPocPanel.tsx
// -----------------------------------------------------------------------------

type DesktopIpcPocExpectedError =
  | Cause.NoSuchElementError
  | DesktopIpcPocEchoError
  | RpcClientError;

function formatDesktopIpcPocError(error: DesktopIpcPocExpectedError): string {
  switch (error._tag) {
    case "DesktopIpcPocEchoError":
      return error.message;
    case "NoSuchElementError":
      return "The tick stream did not return any items.";
    case "RpcClientError":
      return `Transport error: ${error.message}`;
  }
}

function formatDefect(defect: unknown): string {
  return defect instanceof Error ? defect.message : String(defect);
}

function DesktopIpcPocErrorAlert(props: {
  readonly error: DesktopIpcPocExpectedError;
}): ReactElement {
  return <p role="alert">{formatDesktopIpcPocError(props.error)}</p>;
}

function DesktopIpcPocDefectAlert(props: { readonly defect: unknown }): ReactElement {
  return <p role="alert">Unexpected defect: {formatDefect(props.defect)}</p>;
}

function AsyncResultView<A, E>(props: {
  readonly result: AsyncResult.AsyncResult<A, E>;
  readonly renderSuccess: (value: A) => ReactNode;
  readonly renderError: (error: E) => ReactNode;
  readonly emptyLabel: string;
  readonly waitingLabel: string;
}): ReactElement {
  return (
    <>
      {AsyncResult.matchWithError(props.result, {
        onInitial: (initial) => <p>{initial.waiting ? props.waitingLabel : props.emptyLabel}</p>,
        onError: (error) => props.renderError(error),
        onDefect: (defect) => <DesktopIpcPocDefectAlert defect={defect} />,
        onSuccess: (success) => props.renderSuccess(success.value),
      })}
      {props.result.waiting && props.result._tag !== "Initial" ? (
        <p aria-live="polite">Refreshing</p>
      ) : null}
    </>
  );
}

function DesktopIpcPocClientStatus(): ReactElement {
  const runtimeResult = useAtomValue(DesktopIpcPocRpcClient.runtime);

  return AsyncResult.matchWithError(runtimeResult, {
    onInitial: (initial) => (
      <span data-state="initial">
        {initial.waiting ? "Connecting RPC client" : "RPC client idle"}
      </span>
    ),
    onError: () => <span data-state="failed">RPC client failed</span>,
    onDefect: (defect) => <span data-state="failed">{formatDefect(defect)}</span>,
    onSuccess: () => <span data-state="ready">Effect RPC client ready</span>,
  });
}

function RuntimeInfoView(props: { readonly runtimeInfo: DesktopIpcPocRuntimeInfo }): ReactElement {
  return (
    <dl aria-label="Runtime info">
      <dt>App version</dt>
      <dd>{props.runtimeInfo.appVersion}</dd>
      <dt>Platform</dt>
      <dd>{props.runtimeInfo.platform}</dd>
      <dt>Transport</dt>
      <dd>{props.runtimeInfo.ipcTransport}</dd>
    </dl>
  );
}

function EchoView(props: { readonly echo: DesktopIpcPocEchoResult }): ReactElement {
  return (
    <p>
      Echoed &quot;{props.echo.text}&quot; at {props.echo.echoedAt}
    </p>
  );
}

function TickList(props: { readonly ticks: ReadonlyArray<DesktopIpcPocTick> }): ReactElement {
  return (
    <ol aria-label="Streamed ticks">
      {props.ticks.map((tick) => (
        <li key={tick.sequence}>
          {tick.sequence}: {tick.label}
        </li>
      ))}
    </ol>
  );
}

function ManualEchoButton(): ReactElement {
  const echoResult = useAtomValue(desktopIpcPocEchoMutationAtom);
  const sendEcho = useAtomSet(desktopIpcPocEchoMutationAtom);

  return (
    <div>
      <button
        disabled={echoResult.waiting}
        type="button"
        onClick={() =>
          sendEcho({
            payload: {
              text: "manual echo from an AtomRpc mutation",
            },
          })
        }
      >
        {echoResult.waiting ? "Sending" : "Send manual echo"}
      </button>
      <button
        disabled={echoResult.waiting}
        type="button"
        onClick={() =>
          sendEcho({
            payload: {
              text: "",
            },
          })
        }
      >
        Send invalid echo
      </button>
      <AsyncResultView
        result={echoResult}
        emptyLabel="No manual echo sent"
        waitingLabel="Sending echo"
        renderError={(error) => <DesktopIpcPocErrorAlert error={error} />}
        renderSuccess={(echo) => <EchoView echo={echo} />}
      />
    </div>
  );
}

function TickPullButton(): ReactElement {
  const tickResult = useAtomValue(desktopIpcPocTickPullAtom);
  const pullTicks = useAtomSet(desktopIpcPocTickPullAtom);
  const isDone = AsyncResult.isSuccess(tickResult) && tickResult.value.done;

  return (
    <div>
      <button disabled={tickResult.waiting || isDone} type="button" onClick={() => pullTicks()}>
        {isDone ? "Tick stream done" : tickResult.waiting ? "Pulling ticks" : "Pull next ticks"}
      </button>
      <AsyncResultView
        result={tickResult}
        emptyLabel="No ticks pulled"
        waitingLabel="Pulling ticks"
        renderError={(error) => <DesktopIpcPocErrorAlert error={error} />}
        renderSuccess={(pullResult) => (
          <p>
            {pullResult.done ? "Stream completed" : `${pullResult.items.length} ticks received`}
          </p>
        )}
      />
    </div>
  );
}

export function DesktopIpcPocPanel(): ReactElement {
  const snapshotResult = useAtomValue(desktopIpcPocSnapshotAtom);
  const refreshSnapshot = useAtomRefresh(desktopIpcPocSnapshotAtom);

  return (
    <section aria-label="Effect Electron IPC proof of concept">
      <header>
        <DesktopIpcPocClientStatus />
      </header>
      <button disabled={snapshotResult.waiting} type="button" onClick={() => refreshSnapshot()}>
        {snapshotResult.waiting ? "Refreshing" : "Refresh"}
      </button>
      <AsyncResultView
        result={snapshotResult}
        emptyLabel="Desktop RPC data has not loaded"
        waitingLabel="Loading desktop RPC data"
        renderError={(error) => <DesktopIpcPocErrorAlert error={error} />}
        renderSuccess={(snapshot) => (
          <div>
            <RuntimeInfoView runtimeInfo={snapshot.runtimeInfo} />
            <EchoView echo={snapshot.echo} />
            <TickList ticks={snapshot.ticks} />
            <TickPullButton />
            <ManualEchoButton />
          </div>
        )}
      />
    </section>
  );
}

// -----------------------------------------------------------------------------
// example/renderer.tsx
// -----------------------------------------------------------------------------

export function mountDesktopIpcPocReactExample(container: Element): void {
  createRoot(container).render(
    <AppAtomRegistryProvider>
      <DesktopIpcPocPanel />
    </AppAtomRegistryProvider>,
  );
}
