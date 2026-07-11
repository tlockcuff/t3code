import type { ServerUpstreamSyncState } from "@t3tools/contracts";

export function shouldShowUpstreamSyncBadge(
  state: ServerUpstreamSyncState | null | undefined,
): boolean {
  return state?.status === "behind" || state?.status === "diverged";
}

export function formatUpstreamSyncBadgeTitle(state: ServerUpstreamSyncState): string {
  if (state.status === "diverged") {
    return `Upstream diverged (${state.behindBy} behind)`;
  }
  if (state.behindBy === 1) {
    return "1 upstream commit";
  }
  return `${state.behindBy} upstream commits`;
}

export function formatUpstreamSyncBadgeDescription(state: ServerUpstreamSyncState): string {
  if (state.suggestedCommand) {
    return `Merge upstream to pick up new changes. ${state.suggestedCommand}`;
  }
  return state.message ?? "Upstream updates are available for this T3 Code checkout.";
}

export function formatUpstreamSyncSettingsDescription(
  state: ServerUpstreamSyncState | null | undefined,
): string {
  if (!state || state.status === "unavailable") {
    return "Upstream sync checks run when this server is started from a git checkout with an upstream remote.";
  }
  if (state.status === "unknown") {
    return state.message ?? "Could not check upstream sync status.";
  }
  if (state.status === "current") {
    return state.message ?? "This checkout is in sync with upstream.";
  }
  if (state.status === "ahead") {
    return state.message ?? "This checkout is ahead of upstream.";
  }
  return state.message ?? "Upstream updates are available.";
}
