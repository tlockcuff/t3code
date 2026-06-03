import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import "./index.css";

import { WebSocketConnectionCoordinator } from "./components/WebSocketConnectionSurface";
import { ToastProvider } from "./components/ui/toast";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "./rpc/wsConnectionState";
import { writePrimaryEnvironmentDescriptor } from "./environments/primary/context";

function initializeMockEnvironment() {
  const mockDescriptor: ExecutionEnvironmentDescriptor = {
    environmentId: EnvironmentId.make("harness-mock-env"),
    label: "React Scan Harness Mock",
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: false,
    },
  };

  writePrimaryEnvironmentDescriptor(mockDescriptor);
}

function seedReconnectWaitingState() {
  resetWsConnectionStateForTests();
  recordWsConnectionAttempt("ws://localhost:9999", { connectionLabel: "React Scan Harness" });
  recordWsConnectionOpened({ connectionLabel: "React Scan Harness" });
  for (let index = 0; index < 5; index += 1) {
    recordWsConnectionAttempt("ws://localhost:9999", { connectionLabel: "React Scan Harness" });
    recordWsConnectionClosed(
      { code: 1006, reason: "Harness disconnect" },
      {
        connectionLabel: "React Scan Harness",
      },
    );
  }

  const status = getWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  console.log("[Harness] WS status after seed:", { status, uiState });
}

function HarnessView() {
  useEffect(() => {
    initializeMockEnvironment();
    seedReconnectWaitingState();
  }, []);

  return (
    <ToastProvider>
      <WebSocketConnectionCoordinator />
      <main className="min-h-screen bg-background p-8 text-foreground">
        <section className="mx-auto max-w-xl rounded-xl border border-border bg-card p-6 shadow-sm">
          <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
            React Scan harness
          </p>
          <h1 className="mt-3 text-xl font-semibold">WebSocket reconnect toast</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            The WebSocket coordinator is in a reconnect-waiting state. React Scan is enabled to show
            whether the toast stack keeps rerendering while the countdown is visible.
          </p>
          <button
            className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
            onClick={seedReconnectWaitingState}
            type="button"
          >
            Restart reconnect countdown
          </button>
        </section>
      </main>
    </ToastProvider>
  );
}

const rootRoute = createRootRoute({
  component: HarnessView,
});

const router = createRouter({
  routeTree: rootRoute,
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
