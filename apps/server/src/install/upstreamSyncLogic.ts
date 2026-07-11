import type { ServerUpstreamSyncState, ServerUpstreamSyncStatus } from "@t3tools/contracts";

export const DEFAULT_UPSTREAM_REMOTE_NAME = "upstream";
export const DEFAULT_UPSTREAM_BRANCH = "main";

const CANONICAL_UPSTREAM_HOST_PATHS = [
  "github.com/pingdotgg/t3code",
  "github.com/t3dotgg/t3-code",
] as const;

export function normalizeGitRemoteUrl(url: string): string {
  return url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^git\+/i, "")
    .replace(/^ssh:\/\//i, "")
    .replace(/^git@/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^ssh\./i, "")
    .replace(/:/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

export function isCanonicalUpstreamUrl(url: string): boolean {
  const normalized = normalizeGitRemoteUrl(url);
  return CANONICAL_UPSTREAM_HOST_PATHS.some(
    (path) => normalized === path || normalized.endsWith(`/${path}`),
  );
}

export function classifyUpstreamDivergence(
  aheadBy: number,
  behindBy: number,
): Extract<ServerUpstreamSyncStatus, "current" | "behind" | "ahead" | "diverged"> {
  if (behindBy > 0 && aheadBy > 0) return "diverged";
  if (behindBy > 0) return "behind";
  if (aheadBy > 0) return "ahead";
  return "current";
}

export function parseLeftRightCount(stdout: string): { aheadBy: number; behindBy: number } | null {
  const match = stdout.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  const aheadBy = Number(match[1]);
  const behindBy = Number(match[2]);
  if (!Number.isFinite(aheadBy) || !Number.isFinite(behindBy)) return null;
  return { aheadBy, behindBy };
}

export function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function resolveUpstreamRemoteName(input: {
  readonly remotes: ReadonlyArray<string>;
  readonly preferredRemoteName?: string | undefined;
}): string | null {
  const preferred = input.preferredRemoteName?.trim() || DEFAULT_UPSTREAM_REMOTE_NAME;
  if (input.remotes.includes(preferred)) return preferred;
  return null;
}

export function resolveUpstreamBranchFromSymbolicRef(stdout: string, remoteName: string): string {
  const trimmed = stdout.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (trimmed.startsWith(prefix)) {
    const branch = trimmed.slice(prefix.length).trim();
    if (branch.length > 0) return branch;
  }
  return DEFAULT_UPSTREAM_BRANCH;
}

export function buildSuggestedUpstreamCommand(remoteName: string, branch: string): string {
  return `git fetch ${remoteName} && git merge ${remoteName}/${branch}`;
}

export function createUnavailableUpstreamSyncState(input?: {
  readonly checkedAt?: string | null;
  readonly installRoot?: string | null;
  readonly message?: string | null;
}): ServerUpstreamSyncState {
  return {
    status: "unavailable",
    checkedAt: input?.checkedAt ?? null,
    behindBy: 0,
    aheadBy: 0,
    installRoot: input?.installRoot ?? null,
    upstreamRemote: null,
    upstreamUrl: null,
    upstreamRef: null,
    localSha: null,
    upstreamSha: null,
    suggestedCommand: null,
    message:
      input?.message ?? "Upstream sync checks require a git checkout with an upstream remote.",
  };
}

export function createUnknownUpstreamSyncState(input: {
  readonly checkedAt: string | null;
  readonly installRoot: string | null;
  readonly upstreamRemote: string | null;
  readonly upstreamUrl: string | null;
  readonly upstreamRef: string | null;
  readonly message: string;
}): ServerUpstreamSyncState {
  return {
    status: "unknown",
    checkedAt: input.checkedAt,
    behindBy: 0,
    aheadBy: 0,
    installRoot: input.installRoot,
    upstreamRemote: input.upstreamRemote,
    upstreamUrl: input.upstreamUrl,
    upstreamRef: input.upstreamRef,
    localSha: null,
    upstreamSha: null,
    suggestedCommand:
      input.upstreamRemote && input.upstreamRef
        ? buildSuggestedUpstreamCommand(
            input.upstreamRemote,
            input.upstreamRef.replace(`${input.upstreamRemote}/`, ""),
          )
        : null,
    message: input.message,
  };
}

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
