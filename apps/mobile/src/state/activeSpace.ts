import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { useAtomCommand } from "./use-atom-command";
import { serverEnvironment } from "./server";

const EMPTY_SERVER_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null).pipe(
  Atom.withLabel("activeSpace:no-environment"),
);

/**
 * The active Space label shared across devices. The value lives in server
 * settings, so it is read from the first connected environment and written to
 * every connected environment — each server then broadcasts the change to its
 * other clients via the settings stream.
 */
export function useActiveSpace(
  environmentIds: ReadonlyArray<EnvironmentId>,
): readonly [string | null, (space: string | null) => void] {
  const firstEnvironmentId = environmentIds[0] ?? null;
  const settings = useAtomValue(
    firstEnvironmentId === null
      ? EMPTY_SERVER_SETTINGS_ATOM
      : serverEnvironment.settingsValueAtom(firstEnvironmentId),
  );
  const activeSpace = settings?.activeSpace ?? null;

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const setActiveSpace = useCallback(
    (space: string | null) => {
      for (const environmentId of environmentIds) {
        void updateSettings({ environmentId, input: { patch: { activeSpace: space } } });
      }
    },
    [environmentIds, updateSettings],
  );

  return [activeSpace, setActiveSpace] as const;
}
