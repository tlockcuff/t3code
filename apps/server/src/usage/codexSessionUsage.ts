// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { estimateCostUsd, roundUsd } from "./modelPricing.ts";
import type { MachineUsageDayRow, MachineUsageSourceResult } from "./claudeStatsCache.ts";

type CodexTokenBreakdown = {
  readonly input_tokens?: number;
  readonly cached_input_tokens?: number;
  readonly output_tokens?: number;
  readonly reasoning_output_tokens?: number;
  readonly total_tokens?: number;
};

type CodexSessionTotals = {
  readonly day: string;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
};

function getCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".codex");
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function dayFromSessionPath(filePath: string): string | null {
  const match = filePath.match(/[/\\]sessions[/\\](\d{4})[/\\](\d{2})[/\\](\d{2})[/\\]/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function readSessionTotals(filePath: string): CodexSessionTotals | null {
  const day = dayFromSessionPath(filePath);
  if (!day) return null;

  let model: string | null = null;
  let lastUsage: CodexTokenBreakdown | null = null;

  try {
    const content = NodeFS.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const row = parsed as {
        type?: string;
        payload?: {
          type?: string;
          model?: string;
          info?: { total_token_usage?: CodexTokenBreakdown };
          payload?: { model?: string };
        };
      };

      if (row.type === "turn_context" && typeof row.payload?.model === "string") {
        model = row.payload.model;
      }
      if (
        row.type === "event_msg" &&
        row.payload?.type === "token_count" &&
        row.payload.info?.total_token_usage
      ) {
        lastUsage = row.payload.info.total_token_usage;
      }
      // Some rollouts nest model under payload.payload
      const nestedModel = row.payload?.payload?.model;
      if (typeof nestedModel === "string" && nestedModel.length > 0) {
        model = nestedModel;
      }
    }
  } catch {
    return null;
  }

  if (!lastUsage) return null;
  const inputTokens = asNonNegativeInt(lastUsage.input_tokens);
  const cachedInputTokens = asNonNegativeInt(lastUsage.cached_input_tokens);
  const outputTokens =
    asNonNegativeInt(lastUsage.output_tokens) + asNonNegativeInt(lastUsage.reasoning_output_tokens);
  const totalTokens = asNonNegativeInt(lastUsage.total_tokens) || inputTokens + outputTokens;

  if (totalTokens <= 0) return null;
  return {
    day,
    model,
    inputTokens: Math.max(0, inputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens,
    totalTokens,
  };
}

function listSessionFiles(sessionsRoot: string, maxFiles: number): Array<string> {
  if (!NodeFS.existsSync(sessionsRoot)) return [];
  const files: Array<{ path: string; mtimeMs: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 5 || files.length >= maxFiles * 2) return;
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
      if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) {
        try {
          files.push({ path: full, mtimeMs: NodeFS.statSync(full).mtimeMs });
        } catch {
          // skip
        }
      }
    }
  };

  walk(sessionsRoot, 0);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, maxFiles)
    .map((file) => file.path);
}

export function readCodexSessionUsage(input?: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly homePath?: string;
  readonly maxFiles?: number;
}): MachineUsageSourceResult {
  const home = input?.homePath?.trim() || getCodexHome();
  const sessionsRoot = NodePath.join(home, "sessions");
  if (!NodeFS.existsSync(sessionsRoot)) {
    return { provider: "codex", status: "missing", daily: [], sourcePath: sessionsRoot };
  }

  try {
    const files = listSessionFiles(sessionsRoot, input?.maxFiles ?? 400);
    const byKey = new Map<string, MachineUsageDayRow>();

    for (const filePath of files) {
      const totals = readSessionTotals(filePath);
      if (!totals) continue;
      if (input?.fromDay && totals.day < input.fromDay) continue;
      if (input?.toDay && totals.day > input.toDay) continue;

      const key = `${totals.day}::${totals.model ?? ""}`;
      const existing = byKey.get(key);
      const estimatedCostUsd = roundUsd(
        estimateCostUsd({
          model: totals.model,
          inputTokens: totals.inputTokens,
          cachedInputTokens: totals.cachedInputTokens,
          outputTokens: totals.outputTokens,
          totalTokens: totals.totalTokens,
        }),
      );
      if (!existing) {
        byKey.set(key, {
          day: totals.day,
          model: totals.model,
          totalTokens: totals.totalTokens,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cachedInputTokens: totals.cachedInputTokens,
          cacheWriteTokens: 0,
          estimatedCostUsd,
        });
        continue;
      }
      byKey.set(key, {
        ...existing,
        totalTokens: existing.totalTokens + totals.totalTokens,
        inputTokens: existing.inputTokens + totals.inputTokens,
        outputTokens: existing.outputTokens + totals.outputTokens,
        cachedInputTokens: existing.cachedInputTokens + totals.cachedInputTokens,
        estimatedCostUsd: roundUsd(existing.estimatedCostUsd + estimatedCostUsd),
      });
    }

    const daily = [...byKey.values()].sort((a, b) =>
      a.day === b.day ? (a.model ?? "").localeCompare(b.model ?? "") : a.day.localeCompare(b.day),
    );
    return { provider: "codex", status: "ok", daily, sourcePath: sessionsRoot };
  } catch (err) {
    return {
      provider: "codex",
      status: "error",
      daily: [],
      sourcePath: sessionsRoot,
      error: err instanceof Error ? err.message : "Failed to read Codex sessions",
    };
  }
}
