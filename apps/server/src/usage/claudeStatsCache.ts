// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

type ClaudeDailyModelTokens = {
  readonly date?: string;
  readonly tokensByModel?: Record<string, number>;
};

type ClaudeStatsCache = {
  readonly lastComputedDate?: string;
  readonly dailyModelTokens?: ReadonlyArray<ClaudeDailyModelTokens>;
};

type MutableDayRow = {
  day: string;
  model: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

const SESSION_SCAN_CACHE_TTL_MS = 60_000;
const MAX_SESSION_FILES = 800;

type SessionScanCache = {
  readonly expiresAt: number;
  readonly fromDay: string;
  readonly rows: ReadonlyArray<MachineUsageDayRow>;
};

let sessionScanCache: SessionScanCache | null = null;

function getClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude");
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function dayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addToRowMap(
  byKey: Map<string, MutableDayRow>,
  input: {
    readonly day: string;
    readonly model: string | null;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
  },
): void {
  const totalTokens =
    input.inputTokens + input.cachedInputTokens + input.cacheWriteTokens + input.outputTokens;
  if (totalTokens <= 0) return;
  const key = `${input.day}::${input.model ?? ""}`;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, {
      day: input.day,
      model: input.model,
      totalTokens,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheWriteTokens: input.cacheWriteTokens,
    });
    return;
  }
  existing.totalTokens += totalTokens;
  existing.inputTokens += input.inputTokens;
  existing.outputTokens += input.outputTokens;
  existing.cachedInputTokens += input.cachedInputTokens;
  existing.cacheWriteTokens += input.cacheWriteTokens;
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
      estimatedCostUsd: roundUsd(
        estimateCostUsd({
          model: row.model,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          outputTokens: row.outputTokens,
          totalTokens: row.totalTokens,
        }),
      ),
    }))
    .sort((a, b) =>
      a.day === b.day ? (a.model ?? "").localeCompare(b.model ?? "") : a.day.localeCompare(b.day),
    );
}

function listRecentSessionFiles(projectsRoot: string, fromDay: string): Array<string> {
  if (!NodeFS.existsSync(projectsRoot)) return [];
  // Include the prior UTC day so local-evening files near the boundary are not missed.
  const fromMs = Date.parse(`${fromDay}T00:00:00.000Z`) - 24 * 60 * 60 * 1_000;
  const files: Array<{ path: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 8 || files.length >= MAX_SESSION_FILES * 2) return;
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
        if (mtimeMs < fromMs) continue;
        files.push({ path: full, mtimeMs });
      } catch {
        // skip
      }
    }
  };

  walk(projectsRoot, 0);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSION_FILES)
    .map((file) => file.path);
}

/**
 * Identity of a single Anthropic API response, for de-duplication.
 *
 * Claude Code copies prior messages into a new transcript whenever a session is
 * resumed (`--continue`, `/resume`) or a subagent writes a sidechain, so the
 * same assistant response is present in several `.jsonl` files. Summing every
 * line therefore counts one API call many times — on a machine with a long
 * resume history this roughly doubles the reported tokens.
 *
 * `message.id` is the Anthropic response id and is the real identity;
 * `requestId` disambiguates the rare case where a retried request reuses an id.
 * Lines carrying neither (older transcripts) cannot be deduplicated and are
 * always counted, which is the safe direction: under-counting a real call is
 * worse than double-counting a legacy one.
 */
function usageDedupeKey(row: {
  readonly requestId?: string;
  readonly message?: { readonly id?: string };
}): string | null {
  const messageId = row.message?.id?.trim();
  if (!messageId) return null;
  const requestId = row.requestId?.trim();
  return requestId ? `${messageId}::${requestId}` : messageId;
}

function readSessionFileUsage(
  filePath: string,
  fromDay: string,
  toDay: string | undefined,
  byKey: Map<string, MutableDayRow>,
  seenUsageKeys: Set<string>,
): void {
  let content: string;
  try {
    content = NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const row = parsed as {
      type?: string;
      timestamp?: string;
      requestId?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };
    };
    if (row.type !== "assistant" || !row.message?.usage) continue;
    const day = row.timestamp?.slice(0, 10);
    if (!day || day < fromDay) continue;
    if (toDay && day > toDay) continue;
    const modelRaw = row.message.model?.trim() || null;
    if (modelRaw === "<synthetic>") continue;

    const dedupeKey = usageDedupeKey(row);
    if (dedupeKey !== null) {
      if (seenUsageKeys.has(dedupeKey)) continue;
      seenUsageKeys.add(dedupeKey);
    }

    const usage = row.message.usage;
    addToRowMap(byKey, {
      day,
      model: modelRaw,
      inputTokens: asNonNegativeInt(usage.input_tokens),
      cachedInputTokens: asNonNegativeInt(usage.cache_read_input_tokens),
      cacheWriteTokens: asNonNegativeInt(usage.cache_creation_input_tokens),
      outputTokens: asNonNegativeInt(usage.output_tokens),
    });
  }
}

/**
 * Scan Claude project session transcripts for days after the stats-cache cursor.
 *
 * `stats-cache.json` often lags (or freezes) while project session `.jsonl`
 * files still have fresh assistant `message.usage` rows for today/yesterday.
 */
export function readClaudeSessionTranscriptUsage(input?: {
  readonly fromDay: string;
  readonly toDay?: string;
  readonly homePath?: string;
  readonly nowMs?: number;
}): ReadonlyArray<MachineUsageDayRow> {
  const home = input?.homePath?.trim() || getClaudeHome();
  const fromDay = input?.fromDay;
  if (!fromDay) return [];
  const nowMs = input?.nowMs ?? Date.now();
  const cacheKey = fromDay;
  if (
    sessionScanCache &&
    sessionScanCache.fromDay === cacheKey &&
    sessionScanCache.expiresAt > nowMs &&
    input?.homePath === undefined
  ) {
    const toDay = input?.toDay;
    return toDay ? sessionScanCache.rows.filter((row) => row.day <= toDay) : sessionScanCache.rows;
  }

  const projectsRoot = NodePath.join(home, "projects");
  const byKey = new Map<string, MutableDayRow>();
  // Shared across every file in the scan: a resumed session re-emits the same
  // assistant messages into a *different* transcript, so a per-file set would
  // miss exactly the duplicates that matter.
  const seenUsageKeys = new Set<string>();
  for (const filePath of listRecentSessionFiles(projectsRoot, fromDay)) {
    readSessionFileUsage(filePath, fromDay, input?.toDay, byKey, seenUsageKeys);
  }
  const rows = finalizeRows(byKey);
  if (input?.homePath === undefined) {
    sessionScanCache = {
      fromDay: cacheKey,
      expiresAt: nowMs + SESSION_SCAN_CACHE_TTL_MS,
      rows,
    };
  }
  return rows;
}

function nextDayKey(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return day;
  return dayKeyFromMs(ms + 24 * 60 * 60 * 1_000);
}

export function readClaudeStatsCacheUsage(input?: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly homePath?: string;
  readonly nowMs?: number;
}): MachineUsageSourceResult {
  const home = input?.homePath?.trim() || getClaudeHome();
  const sourcePath = NodePath.join(home, "stats-cache.json");
  const projectsPath = NodePath.join(home, "projects");
  const hasCache = NodeFS.existsSync(sourcePath);
  const hasProjects = NodeFS.existsSync(projectsPath);
  if (!hasCache && !hasProjects) {
    return { provider: "claude", status: "missing", daily: [], sourcePath };
  }

  try {
    const byKey = new Map<string, MutableDayRow>();
    let lastComputedDate: string | null = null;

    if (hasCache) {
      const parsed = JSON.parse(NodeFS.readFileSync(sourcePath, "utf8")) as ClaudeStatsCache;
      lastComputedDate = parsed.lastComputedDate?.trim() || null;
      for (const entry of parsed.dailyModelTokens ?? []) {
        const day = entry.date?.trim();
        if (!day) continue;
        if (input?.fromDay && day < input.fromDay) continue;
        if (input?.toDay && day > input.toDay) continue;
        // Prefer session transcripts for days after the cache cursor.
        if (lastComputedDate && day > lastComputedDate) continue;
        const byModel = entry.tokensByModel ?? {};
        for (const [model, totalTokensRaw] of Object.entries(byModel)) {
          const totalTokens =
            typeof totalTokensRaw === "number" && Number.isFinite(totalTokensRaw)
              ? Math.max(0, Math.floor(totalTokensRaw))
              : 0;
          if (totalTokens <= 0) continue;
          const key = `${day}::${model}`;
          byKey.set(key, {
            day,
            model,
            totalTokens,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
          });
        }
      }
    }

    const transcriptFromDay =
      lastComputedDate !== null
        ? nextDayKey(lastComputedDate)
        : (input?.fromDay ??
          dayKeyFromMs((input?.nowMs ?? Date.now()) - 29 * 24 * 60 * 60 * 1_000));

    if (hasProjects) {
      const transcriptRows = readClaudeSessionTranscriptUsage({
        fromDay: transcriptFromDay,
        ...(input?.toDay !== undefined ? { toDay: input.toDay } : {}),
        ...(input?.homePath !== undefined ? { homePath: input.homePath } : {}),
        ...(input?.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      });
      for (const row of transcriptRows) {
        if (input?.fromDay && row.day < input.fromDay) continue;
        if (input?.toDay && row.day > input.toDay) continue;
        addToRowMap(byKey, {
          day: row.day,
          model: row.model,
          inputTokens: row.inputTokens,
          cachedInputTokens: row.cachedInputTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          outputTokens: row.outputTokens,
        });
      }
    }

    const daily = finalizeRows(byKey);
    return {
      provider: "claude",
      status: "ok",
      daily,
      sourcePath: hasCache ? sourcePath : projectsPath,
    };
  } catch (err) {
    return {
      provider: "claude",
      status: "error",
      daily: [],
      sourcePath,
      error: err instanceof Error ? err.message : "Failed to read Claude usage",
    };
  }
}
