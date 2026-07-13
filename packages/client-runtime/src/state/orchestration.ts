import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    contextUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:context-usage",
      tag: ORCHESTRATION_WS_METHODS.listContextUsage,
    }),
    tokenUsageLedger: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:token-usage-ledger",
      tag: ORCHESTRATION_WS_METHODS.listTokenUsageLedger,
    }),
    machineUsageHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:machine-usage-history",
      tag: ORCHESTRATION_WS_METHODS.getMachineUsageHistory,
    }),
    importableSessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:importable-sessions",
      tag: ORCHESTRATION_WS_METHODS.listImportableSessions,
    }),
    importSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:orchestration:import-session",
      tag: ORCHESTRATION_WS_METHODS.importSession,
    }),
  };
}
