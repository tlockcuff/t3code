import { useEffect } from "react";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  registerSelfHostedPushForConnection,
  unregisterAgentAwarenessConnection,
} from "./remoteRegistration";

// Fires self-hosted push registration for every currently-connected environment.
// Runs outside the Clerk/relay path: the device's existing environment session
// authorizes the request, so this works for plain paired (bearer) connections.
// Registration itself is deduped per environment by payload signature, so this
// effect can run on every connection-set change cheaply.
export function useSelfHostedPushRegistration(): void {
  const { savedConnectionsById } = useSavedRemoteConnections();

  useEffect(() => {
    const environmentIds = Object.keys(savedConnectionsById) as EnvironmentId[];
    for (const environmentId of environmentIds) {
      const prepared = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      if (Option.isSome(prepared)) {
        registerSelfHostedPushForConnection(prepared.value);
      }
    }
  }, [savedConnectionsById]);

  useEffect(
    () => () => {
      // Clear per-environment dedup state on unmount so a later mount re-registers.
      for (const environmentId of Object.keys(savedConnectionsById) as EnvironmentId[]) {
        unregisterAgentAwarenessConnection(environmentId);
      }
    },
    [savedConnectionsById],
  );
}
