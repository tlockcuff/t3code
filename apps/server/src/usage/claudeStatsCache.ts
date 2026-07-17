// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { localDayKeyFromIso, localDayKeyFromMs } from "@t3tools/shared/localDay";

import { estimateCostUsd, roundUsd } from "./modelPricing.ts";

export type MachineUsageDayRow = {
  readonly day: string;
  readonly model: string | null;
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
  readonly estimatedCostUsd: number;
};

export type MachineUsageSourceResult = {
  readonly provider: "claude" | "codex" | "grok" | "cursor";
  readonly status: "ok" | "missing" | "error";
  readonly error?: string;
  readonly daily: ReadonlyArray<MachineUsageDayRow>;
  readonly sourcePath?: string;
};

type TokenBreakdown = {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly isFast: boolean;
};

type ClaudeUsageEntry = {
  readonly timestampMs: number;
  readonly day: string;
  readonly tokens: TokenBreakdown;
  readonly messageId: string | null;
  readonly requestId: string | null;
  readonly isSidechain: boolean;
  readonly hasSpeed: boolean;
  readonly costUsd: number | null;
  readonly model: string | null;
};

type MutableDayRow = {
  day: string;
  model: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

const SESSION_SCAN_CACHE_TTL_MS = 60_000;
const MAX_SESSION_FILES = 2_000;
const USAGE_MARKER = '"usage":{';

type SessionScanCache = {
  readonly expiresAt: number;
  readonly fromDay: string;
  readonly toDay: string | undefined;
  readonly homePath: string | undefined;
  readonly rows: ReadonlyArray<MachineUsageDayRow>;
};

let sessionScanCache: SessionScanCache | null = null;

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function totalTokensOf(tokens: TokenBreakdown): number {
  return (
    tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead + tokens.output
  );
}

/**
 * Claude config roots that contain a `projects/` folder.
 *
 * Order mirrors OpenUsage / ccusage:
 * - every entry of `CLAUDE_CONFIG_DIR` (comma-separated) when set
 * - else `$XDG_CONFIG_HOME/claude` and `~/.claude`
 * - always append Cowork desktop agent sandboxes when present
 */
function resolveClaudeRoots(homeOverride?: string): Array<string> {
  const roots: Array<string> = [];
  const seen = new Set<string>();

  const addIfValid = (candidate: string) => {
    const projects = NodePath.join(candidate, "projects");
    if (!NodeFS.existsSync(projects)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    roots.push(candidate);
  };

  if (homeOverride?.trim()) {
    addIfValid(homeOverride.trim());
    return roots;
  }

  const envRaw = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envRaw) {
    for (const part of envRaw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)) {
      let dir = part;
      if (NodePath.basename(dir) === "projects" && NodeFS.existsSync(dir)) {
        dir = NodePath.dirname(dir);
      }
      addIfValid(dir);
    }
  } else {
    const home = NodeOS.homedir();
    const xdg = process.env.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config");
    addIfValid(NodePath.join(xdg, "claude"));
    addIfValid(NodePath.join(home, ".claude"));
  }

  for (const sandbox of listCoworkClaudeDirs(NodeOS.homedir())) {
    addIfValid(sandbox);
  }
  return roots;
}

/** Cowork (Claude desktop agent mode) per-session `.claude` sandboxes. */
function listCoworkClaudeDirs(home: string): Array<string> {
  const base = NodePath.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "local-agent-mode-sessions",
  );
  if (!NodeFS.existsSync(base)) return [];

  const subdirs = (dir: string): Array<string> => {
    try {
      return NodeFS.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => NodePath.join(dir, entry.name));
    } catch {
      return [];
    }
  };

  const dirs: Array<string> = [];
  for (const group of subdirs(base)) {
    for (const sub of subdirs(group)) {
      let sessions = subdirs(sub);
      for (const holder of sessions) {
        if (NodePath.basename(holder) === "agent") {
          sessions = sessions.concat(subdirs(holder));
        }
      }
      for (const session of sessions) {
        dirs.push(NodePath.join(session, ".claude"));
      }
    }
  }
  return dirs.sort();
}

function listSessionFiles(roots: ReadonlyArray<string>, fromDay: string): Array<string> {
  // Include prior day of mtime so local-evening files near the window edge are kept.
  const fromMs = Date.parse(`${fromDay}T00:00:00`) - 24 * 60 * 60 * 1_000;
  const files: Array<{ path: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 10 || files.length >= MAX_SESSION_FILES * 2) return;
    let entries: Array<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const mtimeMs = NodeFS.statSync(full).mtimeMs;
        if (Number.isFinite(fromMs) && mtimeMs < fromMs) continue;
        files.push({ path: full, mtimeMs });
      } catch {
        // skip
      }
    }
  };

  for (const root of roots) {
    walk(NodePath.join(root, "projects"), 0);
  }

  return files
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_SESSION_FILES)
    .map((file) => file.path);
}

function parseTokenBreakdown(usage: Record<string, unknown>): {
  readonly tokens: TokenBreakdown;
  readonly hasSpeed: boolean;
} | null {
  const inputRaw = usage.input_tokens;
  const outputRaw = usage.output_tokens;
  if (typeof inputRaw !== "number" || !Number.isFinite(inputRaw)) return null;
  if (typeof outputRaw !== "number" || !Number.isFinite(outputRaw)) return null;

  const speed = typeof usage.speed === "string" ? usage.speed : null;
  if (speed !== null && speed !== "fast" && speed !== "standard") return null;

  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  const cacheCreation = usage.cache_creation;
  if (cacheCreation && typeof cacheCreation === "object" && !Array.isArray(cacheCreation)) {
    const creation = cacheCreation as Record<string, unknown>;
    cacheWrite5m = asNonNegativeInt(creation.ephemeral_5m_input_tokens);
    cacheWrite1h = asNonNegativeInt(creation.ephemeral_1h_input_tokens);
  } else {
    cacheWrite5m = asNonNegativeInt(usage.cache_creation_input_tokens);
  }

  return {
    tokens: {
      input: Math.max(0, Math.floor(inputRaw)),
      cacheWrite5m,
      cacheWrite1h,
      cacheRead: asNonNegativeInt(usage.cache_read_input_tokens),
      output: Math.max(0, Math.floor(outputRaw)),
      isFast: speed === "fast",
    },
    hasSpeed: speed !== null,
  };
}

function isSemverPrefix(value: string): boolean {
  return /^\d+\.\d+\.\d/.test(value);
}

function isValidEntry(object: Record<string, unknown>, message: Record<string, unknown>): boolean {
  const version = object.version;
  if (typeof version === "string" && version.length > 0 && !isSemverPrefix(version)) {
    return false;
  }
  for (const value of [object.sessionId, object.requestId, message.id, message.model]) {
    if (typeof value === "string" && value.length === 0) return false;
  }
  return true;
}

function parseEntriesFromLine(line: string): Array<ClaudeUsageEntry> {
  if (!line.includes(USAGE_MARKER)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const object = parsed as Record<string, unknown>;
  const timestampRaw = typeof object.timestamp === "string" ? object.timestamp : null;
  if (!timestampRaw) return [];
  const day = localDayKeyFromIso(timestampRaw);
  const timestampMs = Date.parse(timestampRaw);
  if (!day || !Number.isFinite(timestampMs)) return [];

  const message = object.message;
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;
  const usage = messageRecord.usage;
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;
  const breakdown = parseTokenBreakdown(usageRecord);
  if (!breakdown) return [];
  if (!isValidEntry(object, messageRecord)) return [];

  const modelRaw = typeof messageRecord.model === "string" ? messageRecord.model.trim() : null;
  const model = modelRaw && modelRaw !== "<synthetic>" && modelRaw.length > 0 ? modelRaw : null;
  const messageId =
    typeof messageRecord.id === "string" && messageRecord.id.trim().length > 0
      ? messageRecord.id.trim()
      : null;
  const requestId =
    typeof object.requestId === "string" && object.requestId.trim().length > 0
      ? object.requestId.trim()
      : null;
  const costUsd =
    typeof object.costUSD === "number" && Number.isFinite(object.costUSD) && object.costUSD >= 0
      ? object.costUSD
      : null;

  const parent: ClaudeUsageEntry = {
    timestampMs,
    day,
    tokens: breakdown.tokens,
    messageId,
    requestId,
    isSidechain: object.isSidechain === true,
    hasSpeed: breakdown.hasSpeed,
    costUsd,
    model,
  };

  const entries: Array<ClaudeUsageEntry> = [parent];
  const iterations = usageRecord.iterations;
  if (!Array.isArray(iterations)) return entries;

  let advisorIndex = 0;
  for (const iteration of iterations) {
    if (typeof iteration !== "object" || iteration === null) continue;
    const iter = iteration as Record<string, unknown>;
    if (iter.type !== "advisor_message") continue;
    const advisorModel =
      typeof iter.model === "string" && iter.model.trim().length > 0 ? iter.model.trim() : null;
    if (!advisorModel) continue;
    const advisorBreakdown = parseTokenBreakdown(iter);
    if (!advisorBreakdown) continue;
    entries.push({
      timestampMs,
      day,
      tokens: advisorBreakdown.tokens,
      messageId: messageId ? `${messageId}:advisor:${advisorIndex}` : null,
      requestId,
      isSidechain: parent.isSidechain,
      hasSpeed: advisorBreakdown.hasSpeed,
      costUsd: null,
      model: advisorModel,
    });
    advisorIndex += 1;
  }
  return entries;
}

function shouldReplace(candidate: ClaudeUsageEntry, existing: ClaudeUsageEntry): boolean {
  if (candidate.isSidechain !== existing.isSidechain) {
    return existing.isSidechain; // prefer parent
  }
  const candidateTotal = totalTokensOf(candidate.tokens);
  const existingTotal = totalTokensOf(existing.tokens);
  if (candidateTotal !== existingTotal) {
    return candidateTotal > existingTotal;
  }
  return candidate.hasSpeed && !existing.hasSpeed;
}

/**
 * Deduplicate replayed usage lines (resume copies + sidechains).
 * Mirrors OpenUsage: exact (messageId, requestId), then sidechain-aware messageId match.
 */
function dedupeEntries(entries: ReadonlyArray<ClaudeUsageEntry>): Array<ClaudeUsageEntry> {
  const deduped: Array<ClaudeUsageEntry> = [];
  const exactIndex = new Map<string, number>();
  const messageIndex = new Map<string, Array<number>>();

  const exactKey = (messageId: string, requestId: string | null) =>
    requestId ? `${messageId}::${requestId}` : messageId;

  for (const entry of entries) {
    if (!entry.messageId) {
      deduped.push(entry);
      continue;
    }

    const key = exactKey(entry.messageId, entry.requestId);
    let collision = exactIndex.get(key);
    if (collision === undefined) {
      const candidates = messageIndex.get(entry.messageId);
      if (candidates) {
        collision = candidates.find((index) => {
          const existing = deduped[index];
          return existing !== undefined && (entry.isSidechain || existing.isSidechain);
        });
      }
    }

    if (collision !== undefined) {
      const existing = deduped[collision]!;
      if (shouldReplace(entry, existing)) {
        if (existing.messageId) {
          exactIndex.delete(exactKey(existing.messageId, existing.requestId));
        }
        deduped[collision] = entry;
        exactIndex.set(key, collision);
      }
      continue;
    }

    const index = deduped.length;
    deduped.push(entry);
    exactIndex.set(key, index);
    const list = messageIndex.get(entry.messageId) ?? [];
    list.push(index);
    messageIndex.set(entry.messageId, list);
  }
  return deduped;
}

function addPricedRow(byKey: Map<string, MutableDayRow>, entry: ClaudeUsageEntry): void {
  const tokens = entry.tokens;
  const totalTokens = totalTokensOf(tokens);
  if (totalTokens <= 0 && entry.costUsd === null) return;

  const cacheWriteTokens = tokens.cacheWrite5m + tokens.cacheWrite1h;
  const estimatedCostUsd = roundUsd(
    estimateCostUsd({
      model: entry.model,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite5m,
      cacheWrite1hTokens: tokens.cacheWrite1h,
      outputTokens: tokens.output,
      isFast: tokens.isFast,
      costUsd: entry.costUsd,
      totalTokens,
    }),
  );

  const key = `${entry.day}::${entry.model ?? ""}`;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, {
      day: entry.day,
      model: entry.model,
      totalTokens,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedInputTokens: tokens.cacheRead,
      cacheWriteTokens,
      estimatedCostUsd,
    });
    return;
  }
  existing.totalTokens += totalTokens;
  existing.inputTokens += tokens.input;
  existing.outputTokens += tokens.output;
  existing.cachedInputTokens += tokens.cacheRead;
  existing.cacheWriteTokens += cacheWriteTokens;
  existing.estimatedCostUsd = roundUsd(existing.estimatedCostUsd + estimatedCostUsd);
}

function finalizeRows(byKey: Map<string, MutableDayRow>): Array<MachineUsageDayRow> {
  return [...byKey.values()]
    .map((row) => ({
      day: row.day,
      model: row.model,
      totalTokens: row.totalTokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      estimatedCostUsd: row.estimatedCostUsd,
    }))
    .sort((a, b) =>
      a.day === b.day ? (a.model ?? "").localeCompare(b.model ?? "") : a.day.localeCompare(b.day),
    );
}

function scanSessionFiles(
  files: ReadonlyArray<string>,
  fromDay: string,
  toDay: string | undefined,
): Array<MachineUsageDayRow> {
  const raw: Array<ClaudeUsageEntry> = [];
  for (const filePath of files) {
    let content: string;
    try {
      content = NodeFS.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      for (const entry of parseEntriesFromLine(line)) {
        if (entry.day < fromDay) continue;
        if (toDay && entry.day > toDay) continue;
        raw.push(entry);
      }
    }
  }

  const byKey = new Map<string, MutableDayRow>();
  for (const entry of dedupeEntries(raw)) {
    addPricedRow(byKey, entry);
  }
  return finalizeRows(byKey);
}

/**
 * Scan Claude project session transcripts for spend (OpenUsage-aligned).
 *
 * Always reads project session JSONL logs (and Cowork sandboxes). Prefers
 * per-line `costUSD` when present; otherwise prices token buckets including
 * 5m/1h cache writes. Days are local-calendar keys.
 */
export function readClaudeSessionTranscriptUsage(input?: {
  readonly fromDay: string;
  readonly toDay?: string;
  readonly homePath?: string;
  readonly nowMs?: number;
}): ReadonlyArray<MachineUsageDayRow> {
  const fromDay = input?.fromDay;
  if (!fromDay) return [];
  const nowMs = input?.nowMs ?? Date.now();
  const homePath = input?.homePath?.trim() || undefined;

  if (
    sessionScanCache &&
    sessionScanCache.fromDay === fromDay &&
    sessionScanCache.toDay === input?.toDay &&
    sessionScanCache.homePath === homePath &&
    sessionScanCache.expiresAt > nowMs
  ) {
    return sessionScanCache.rows;
  }

  const roots = resolveClaudeRoots(homePath);
  if (roots.length === 0) return [];

  const files = listSessionFiles(roots, fromDay);
  const rows = scanSessionFiles(files, fromDay, input?.toDay);

  sessionScanCache = {
    fromDay,
    toDay: input?.toDay,
    homePath,
    expiresAt: nowMs + SESSION_SCAN_CACHE_TTL_MS,
    rows,
  };
  return rows;
}

/**
 * Machine-level Claude spend history.
 *
 * Kept export name for RPC/call-site stability. Implementation is now a full
 * OpenUsage-style session log scan (stats-cache totals are no longer used —
 * they lag and lack per-bucket breakdowns needed for accurate dollars).
 */
export function readClaudeStatsCacheUsage(input?: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly homePath?: string;
  readonly nowMs?: number;
}): MachineUsageSourceResult {
  const homePath = input?.homePath?.trim() || undefined;
  const roots = resolveClaudeRoots(homePath);
  const primaryRoot = roots[0];
  const projectsPath = primaryRoot
    ? NodePath.join(primaryRoot, "projects")
    : NodePath.join(homePath ?? NodeOS.homedir(), ".claude", "projects");

  if (roots.length === 0) {
    return {
      provider: "claude",
      status: "missing",
      daily: [],
      sourcePath: projectsPath,
    };
  }

  try {
    const nowMs = input?.nowMs ?? Date.now();
    const fromDay = input?.fromDay ?? localDayKeyFromMs(nowMs - 29 * 24 * 60 * 60 * 1_000);

    const daily = readClaudeSessionTranscriptUsage({
      fromDay,
      ...(input?.toDay !== undefined ? { toDay: input.toDay } : {}),
      ...(homePath !== undefined ? { homePath } : {}),
      nowMs,
    });

    return {
      provider: "claude",
      status: "ok",
      daily,
      sourcePath: projectsPath,
    };
  } catch (err) {
    return {
      provider: "claude",
      status: "error",
      daily: [],
      sourcePath: projectsPath,
      error: err instanceof Error ? err.message : "Failed to read Claude usage",
    };
  }
}
