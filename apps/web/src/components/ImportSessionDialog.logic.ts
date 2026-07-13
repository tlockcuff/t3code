import {
  defaultInstanceIdForDriver,
  type ImportableSession,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Grouping + filtering for the import picker. Sessions are grouped by provider, then by the working
 * directory they ran in, so a long system-wide history stays navigable.
 */

export interface ImportSessionWorkspaceGroup {
  readonly cwd: string;
  readonly sessions: ReadonlyArray<ImportableSession>;
}

export interface ImportSessionProviderGroup {
  readonly provider: ImportableSession["provider"];
  readonly workspaces: ReadonlyArray<ImportSessionWorkspaceGroup>;
  readonly sessionCount: number;
}

export const PROVIDER_LABELS: Record<ImportableSession["provider"], string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * Session files are keyed by product name; the provider registry keys drivers by slug, and Claude's
 * slug is `claudeAgent`. Mirrors the server's `driverKindForProvider`.
 */
export const driverKindForSessionProvider = (
  provider: ImportableSession["provider"],
): ProviderDriverKind => (provider === "claude" ? "claudeAgent" : "codex") as ProviderDriverKind;

/**
 * The model selection an imported session must run under.
 *
 * An imported session can only be resumed by the driver that wrote it, so the thread has to be
 * created on an instance of *that* driver — not on the project's default, which is frequently a
 * different provider and would lock the thread to a provider that cannot replay its context.
 *
 * Returns `null` when that driver has no enabled instance, which is what lets the picker disable
 * the session up front instead of failing after the user clicks it. The server re-resolves this
 * independently, so a stale snapshot here cannot produce a mismatched thread.
 */
export const resolveImportModelSelection = (
  providers: ReadonlyArray<ServerProvider>,
  provider: ImportableSession["provider"],
): ModelSelection | null => {
  const driverKind = driverKindForSessionProvider(provider);
  const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
  const usable = providers.filter(
    (candidate) =>
      candidate.driver === driverKind &&
      candidate.enabled &&
      candidate.availability !== "unavailable",
  );
  const snapshot =
    usable.find((candidate) => candidate.instanceId === defaultInstanceId) ?? usable[0];
  if (snapshot === undefined) return null;

  // Custom models are user-authored aliases that may point anywhere; the first stock model is the
  // safest default for a thread the user did not pick a model for.
  const model = snapshot.models.find((candidate) => !candidate.isCustom) ?? snapshot.models[0];
  if (model === undefined) return null;

  return { instanceId: snapshot.instanceId, model: model.slug };
};

const UNKNOWN_WORKSPACE = "Unknown workspace";

const matchesQuery = (session: ImportableSession, query: string): boolean => {
  if (query.length === 0) return true;
  const haystack = `${session.title ?? ""} ${session.cwd ?? ""}`.toLowerCase();
  return haystack.includes(query);
};

export interface ImportSessionFilters {
  readonly query?: string;
  readonly preferredCwd?: string | null;
  /** Null means "all providers". */
  readonly provider?: ImportableSession["provider"] | null;
  /** Null means "all folders". Only meaningful once a provider is chosen. */
  readonly cwd?: string | null;
}

export const workspaceKey = (session: ImportableSession): string =>
  session.cwd ?? UNKNOWN_WORKSPACE;

/** Distinct providers present in the session list, for the provider dropdown. */
export const listSessionProviders = (
  sessions: ReadonlyArray<ImportableSession>,
): ReadonlyArray<ImportableSession["provider"]> => {
  const seen = new Set<ImportableSession["provider"]>();
  for (const session of sessions) seen.add(session.provider);
  return [...seen].sort((left, right) => left.localeCompare(right));
};

/** Folders available for the chosen provider, most sessions first, for the project dropdown. */
export const listSessionWorkspaces = (
  sessions: ReadonlyArray<ImportableSession>,
  provider: ImportableSession["provider"] | null,
): ReadonlyArray<{ readonly cwd: string; readonly count: number }> => {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (provider !== null && session.provider !== provider) continue;
    const cwd = workspaceKey(session);
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cwd, count]) => ({ cwd, count }))
    .sort((left, right) => right.count - left.count || left.cwd.localeCompare(right.cwd));
};

/**
 * Sessions whose `cwd` matches the active project sort first, since importing into the project you
 * are already looking at is the common case. Everything else remains reachable below.
 */
export const groupImportableSessions = (
  sessions: ReadonlyArray<ImportableSession>,
  options: ImportSessionFilters = {},
): ReadonlyArray<ImportSessionProviderGroup> => {
  const query = (options.query ?? "").trim().toLowerCase();
  const preferredCwd = options.preferredCwd ?? null;
  const providerFilter = options.provider ?? null;
  const cwdFilter = options.cwd ?? null;

  const byProvider = new Map<
    ImportableSession["provider"],
    Map<string, Array<ImportableSession>>
  >();

  for (const session of sessions) {
    if (providerFilter !== null && session.provider !== providerFilter) continue;
    if (cwdFilter !== null && workspaceKey(session) !== cwdFilter) continue;
    if (!matchesQuery(session, query)) continue;
    const workspaces =
      byProvider.get(session.provider) ?? new Map<string, Array<ImportableSession>>();
    const cwd = workspaceKey(session);
    const bucket = workspaces.get(cwd) ?? [];
    bucket.push(session);
    workspaces.set(cwd, bucket);
    byProvider.set(session.provider, workspaces);
  }

  const groups: Array<ImportSessionProviderGroup> = [];

  for (const [provider, workspaceMap] of byProvider) {
    const workspaces = [...workspaceMap.entries()]
      .map(([cwd, workspaceSessions]) => ({ cwd, sessions: workspaceSessions }))
      .sort((left, right) => {
        if (preferredCwd !== null) {
          const leftPreferred = left.cwd === preferredCwd;
          const rightPreferred = right.cwd === preferredCwd;
          if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
        }
        return left.cwd.localeCompare(right.cwd);
      });

    groups.push({
      provider,
      workspaces,
      sessionCount: workspaces.reduce((total, workspace) => total + workspace.sessions.length, 0),
    });
  }

  return groups.sort((left, right) => left.provider.localeCompare(right.provider));
};

/** Shortens a long absolute path for display without losing the identifying tail. */
export const formatWorkspaceLabel = (cwd: string): string => {
  const segments = cwd.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 2) return cwd;
  return `…/${segments.slice(-2).join("/")}`;
};

export const formatSessionSubtitle = (session: ImportableSession): string => {
  const count = `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`;
  if (session.updatedAt === null) return count;
  return `${count} · ${session.updatedAt.slice(0, 10)}`;
};
