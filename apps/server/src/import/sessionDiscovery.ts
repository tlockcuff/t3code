// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ImportableProvider,
  type ImportableSessionSummary,
  type ParsedSession,
  parseSessionFile,
} from "./sessionTranscript.ts";

/** Guardrails so a huge history never stalls the picker. */
const MAX_SESSIONS_PER_PROVIDER = 400;
const MAX_SCAN_FILES_PER_PROVIDER = 3_000;
const MAX_WALK_DEPTH = 8;
const CACHE_TTL_MS = 30_000;

export interface DiscoverSessionsOptions {
  /** Overrides `CLAUDE_CONFIG_DIR` / `~/.claude`. */
  readonly claudeHome?: string | undefined;
  /** Overrides `CODEX_HOME` / `~/.codex`. Must match the target provider instance's home. */
  readonly codexHome?: string | undefined;
}

interface DiscoveredFile {
  readonly path: string;
  readonly mtimeMs: number;
}

const resolveClaudeHome = (override: string | undefined): string =>
  override?.trim() ||
  process.env.CLAUDE_CONFIG_DIR?.trim() ||
  NodePath.join(NodeOS.homedir(), ".claude");

const resolveCodexHome = (override: string | undefined): string =>
  override?.trim() || process.env.CODEX_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".codex");

const listJsonlFiles = (
  root: string,
  matches: (name: string) => boolean,
): Array<DiscoveredFile> => {
  if (!NodeFS.existsSync(root)) return [];
  const files: Array<DiscoveredFile> = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_SCAN_FILES_PER_PROVIDER) return;
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES_PER_PROVIDER) return;
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !matches(entry.name)) continue;
      try {
        files.push({ path: full, mtimeMs: NodeFS.statSync(full).mtimeMs });
      } catch {
        // File vanished between readdir and stat; skip.
      }
    }
  };

  walk(root, 0);
  // Newest first: the session a user wants to resume is almost always a recent one.
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const readLines = (filePath: string): Array<string> | null => {
  try {
    return NodeFS.readFileSync(filePath, "utf8").split("\n");
  } catch {
    return null;
  }
};

const scanProvider = (
  provider: ImportableProvider,
  root: string,
  matches: (name: string) => boolean,
): Array<ImportableSessionSummary> => {
  const summaries: Array<ImportableSessionSummary> = [];
  for (const file of listJsonlFiles(root, matches)) {
    if (summaries.length >= MAX_SESSIONS_PER_PROVIDER) break;
    const lines = readLines(file.path);
    if (lines === null) continue;
    const parsed = parseSessionFile(provider, file.path, lines);
    if (parsed === null) continue;
    summaries.push(parsed.summary);
  }
  return summaries;
};

const isCodexRollout = (name: string): boolean => name.startsWith("rollout-");

/** Most-recently-active first. File mtime drives the scan cap; transcript time drives the display. */
const byRecencyDesc = (left: ImportableSessionSummary, right: ImportableSessionSummary): number =>
  (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");

export const discoverSessions = (
  options: DiscoverSessionsOptions = {},
): Array<ImportableSessionSummary> =>
  [
    ...scanProvider(
      "claude",
      NodePath.join(resolveClaudeHome(options.claudeHome), "projects"),
      () => true,
    ),
    ...scanProvider(
      "codex",
      NodePath.join(resolveCodexHome(options.codexHome), "sessions"),
      isCodexRollout,
    ),
  ].sort(byRecencyDesc);

interface CacheEntry {
  readonly key: string;
  readonly at: number;
  readonly sessions: Array<ImportableSessionSummary>;
}

let cache: CacheEntry | null = null;

/**
 * Scanning every session file costs a few seconds on a large history, and the picker is opened
 * repeatedly, so results are memoised briefly. `nowMs` is supplied by the caller's clock.
 */
export const discoverSessionsCached = (
  nowMs: number,
  options: DiscoverSessionsOptions = {},
): Array<ImportableSessionSummary> => {
  const key = `${resolveClaudeHome(options.claudeHome)}|${resolveCodexHome(options.codexHome)}`;
  if (cache !== null && cache.key === key && nowMs - cache.at < CACHE_TTL_MS) return cache.sessions;
  const sessions = discoverSessions(options);
  cache = { key, at: nowMs, sessions };
  return sessions;
};

export const invalidateSessionDiscoveryCache = (): void => {
  cache = null;
};

/** Reads one session's full transcript for backfill. Returns null if it is no longer parseable. */
export const loadSessionForImport = (
  provider: ImportableProvider,
  filePath: string,
): ParsedSession | null => {
  const lines = readLines(filePath);
  if (lines === null) return null;
  return parseSessionFile(provider, filePath, lines);
};
