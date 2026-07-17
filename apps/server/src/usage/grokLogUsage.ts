// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { localDayKeyFromIso } from "@t3tools/shared/localDay";

import { estimateCostUsd, roundUsd } from "./modelPricing.ts";
import type { MachineUsageDayRow, MachineUsageSourceResult } from "./claudeStatsCache.ts";

type MutableDayRow = {
  day: string;
  model: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
};

function getGrokHome(): string {
  return process.env.GROK_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".grok");
}

function asNonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function extractModelId(msg: string, ctx: Record<string, unknown>): string | null {
  let raw: unknown;
  switch (msg) {
    case "model changed":
      raw = ctx.model;
      break;
    case "model catalog: notifying clients":
      raw = ctx.current_model_id;
      break;
    case "backend_search: model switch":
      raw = ctx.model ?? ctx.current_model_id ?? ctx.model_id;
      break;
    case "subagent model resolved":
      raw = ctx.model_id ?? ctx.model;
      break;
    default:
      return null;
  }
  if (typeof raw !== "string") return null;
  const model = raw.trim();
  return model.length > 0 ? model : null;
}

function addRow(
  byKey: Map<string, MutableDayRow>,
  input: {
    readonly day: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  },
): void {
  const totalTokens = input.inputTokens + input.cachedInputTokens + input.outputTokens;
  if (totalTokens <= 0) return;
  const key = `${input.day}::${input.model}`;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, {
      day: input.day,
      model: input.model,
      totalTokens,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheWriteTokens: 0,
    });
    return;
  }
  existing.totalTokens += totalTokens;
  existing.inputTokens += input.inputTokens;
  existing.outputTokens += input.outputTokens;
  existing.cachedInputTokens += input.cachedInputTokens;
}

function finalizeDaily(byKey: Map<string, MutableDayRow>): Array<MachineUsageDayRow> {
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
          outputTokens: row.outputTokens,
          totalTokens: row.totalTokens,
        }),
      ),
    }))
    .sort((a, b) =>
      a.day === b.day ? (a.model ?? "").localeCompare(b.model ?? "") : a.day.localeCompare(b.day),
    );
}

/**
 * Read Grok CLI historical spend from `~/.grok/logs/unified.jsonl`.
 *
 * Mirrors OpenUsage's GrokLogUsageScanner: `shell.turn.inference_done` rows carry
 * token counts; model is attributed from per-pid model-change events.
 */
export async function readGrokLogUsage(input?: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly homePath?: string;
}): Promise<MachineUsageSourceResult> {
  const home = input?.homePath?.trim() || getGrokHome();
  const sourcePath = NodePath.join(home, "logs", "unified.jsonl");
  if (!NodeFS.existsSync(sourcePath)) {
    return { provider: "grok", status: "missing", daily: [], sourcePath };
  }

  try {
    const modelByPid = new Map<number, string>();
    const byKey = new Map<string, MutableDayRow>();
    const stream = NodeFS.createReadStream(sourcePath, { encoding: "utf8" });
    const rl = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.includes("inference_done") && !line.includes("model")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const row = parsed as {
        ts?: string;
        pid?: number;
        msg?: string;
        ctx?: Record<string, unknown>;
      };
      const msg = row.msg?.trim();
      if (!msg) continue;
      const ctx = row.ctx ?? {};
      const pid = typeof row.pid === "number" && Number.isFinite(row.pid) ? row.pid : null;

      const modelFromEvent = extractModelId(msg, ctx);
      if (modelFromEvent) {
        if (pid !== null) modelByPid.set(pid, modelFromEvent);
        continue;
      }

      if (msg !== "shell.turn.inference_done") continue;
      const ts = row.ts?.trim();
      if (!ts) continue;
      const day = localDayKeyFromIso(ts);
      if (!day) continue;
      if (input?.fromDay && day < input.fromDay) continue;
      if (input?.toDay && day > input.toDay) continue;

      const promptTokens = asNonNegativeNumber(ctx.prompt_tokens);
      const cachedRaw = asNonNegativeNumber(ctx.cached_prompt_tokens);
      const cachedInputTokens = Math.min(cachedRaw, promptTokens);
      const inputTokens = Math.max(0, promptTokens - cachedInputTokens);
      const outputTokens =
        asNonNegativeNumber(ctx.completion_tokens) + asNonNegativeNumber(ctx.reasoning_tokens);
      if (inputTokens + cachedInputTokens + outputTokens <= 0) continue;

      const model = pid !== null ? modelByPid.get(pid) : undefined;
      if (!model) continue;

      addRow(byKey, {
        day,
        model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      });
    }

    return { provider: "grok", status: "ok", daily: finalizeDaily(byKey), sourcePath };
  } catch (err) {
    return {
      provider: "grok",
      status: "error",
      daily: [],
      sourcePath,
      error: err instanceof Error ? err.message : "Failed to read Grok usage log",
    };
  }
}
