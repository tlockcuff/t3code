// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { readCursorAuthSession } from "../provider/usage/cursorUsage.ts";
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

const CURSOR_USAGE_CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv";

function decodeJwtSubject(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as { sub?: unknown };
    return typeof parsed.sub === "string" && parsed.sub.trim().length > 0
      ? parsed.sub.trim()
      : null;
  } catch {
    return null;
  }
}

function dayKeyFromCsvDate(value: string): string | null {
  const trimmed = value.trim();
  // CSV dates look like "2026-07-10 14:22:01" or ISO.
  const day = trimmed.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function parseCsvNumber(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parseCsvLine(line: string): Array<string> {
  const cells: Array<string> = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function addRow(
  byKey: Map<string, MutableDayRow>,
  input: {
    readonly day: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
  },
): void {
  const totalTokens =
    input.inputTokens + input.cachedInputTokens + input.cacheWriteTokens + input.outputTokens;
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

export function parseCursorUsageCsv(
  text: string,
  range: { readonly fromDay: string; readonly toDay: string },
):
  | { readonly ok: true; readonly daily: Array<MachineUsageDayRow> }
  | { readonly ok: false; readonly error: string } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { ok: true, daily: [] };
  }

  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.findIndex((h) => h === "date"),
    model: header.findIndex((h) => h === "model"),
    inputNoCacheWrite: header.findIndex(
      (h) => h.includes("input") && (h.includes("without") || h.includes("w/o")),
    ),
    inputWithCacheWrite: header.findIndex(
      (h) =>
        h.includes("input") &&
        (h.includes("with cache") || h.includes("w/ cache")) &&
        !h.includes("without") &&
        !h.includes("w/o"),
    ),
    cacheRead: header.findIndex((h) => h.includes("cache read")),
    output: header.findIndex((h) => h.includes("output")),
  };
  if (idx.date < 0 || idx.model < 0) {
    return { ok: false, error: "Cursor usage CSV missing Date/Model columns" };
  }

  const byKey = new Map<string, MutableDayRow>();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const day = dayKeyFromCsvDate(cells[idx.date] ?? "");
    if (!day) continue;
    if (day < range.fromDay || day > range.toDay) continue;
    const model = (cells[idx.model] ?? "").trim();
    if (!model) continue;

    const inputWithCacheWrite = parseCsvNumber(cells[idx.inputWithCacheWrite]);
    const inputNoCacheWrite = parseCsvNumber(cells[idx.inputNoCacheWrite]);
    const cacheWriteTokens = Math.max(0, inputWithCacheWrite - inputNoCacheWrite);
    const inputTokens = inputNoCacheWrite > 0 ? inputNoCacheWrite : inputWithCacheWrite;
    const cachedInputTokens = parseCsvNumber(cells[idx.cacheRead]);
    const outputTokens = parseCsvNumber(cells[idx.output]);

    addRow(byKey, {
      day,
      model,
      inputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
    });
  }

  const daily: Array<MachineUsageDayRow> = [...byKey.values()]
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

  return { ok: true, daily };
}

/**
 * Fetch Cursor historical usage via the dashboard CSV export API.
 *
 * Same approach as OpenUsage: auth from local Cursor state DB, then
 * `cursor.com/api/dashboard/export-usage-events-csv`.
 */
export async function readCursorUsageHistory(input?: {
  readonly fromDay?: string;
  readonly toDay?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<MachineUsageSourceResult> {
  const session = await readCursorAuthSession();
  if (!session) {
    return {
      provider: "cursor",
      status: "missing",
      daily: [],
      error: "Cursor auth session not found in local state DB",
    };
  }

  const userId = decodeJwtSubject(session.accessToken);
  if (!userId) {
    return {
      provider: "cursor",
      status: "error",
      daily: [],
      error: "Could not decode Cursor user id from access token",
    };
  }

  const toDay = input?.toDay ?? new Date().toISOString().slice(0, 10);
  const fromDay =
    input?.fromDay ??
    new Date(Date.parse(`${toDay}T00:00:00.000Z`) - 29 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  const startDateMs = Date.parse(`${fromDay}T00:00:00.000Z`);
  const endDateMs = Date.parse(`${toDay}T23:59:59.999Z`);
  if (!Number.isFinite(startDateMs) || !Number.isFinite(endDateMs)) {
    return {
      provider: "cursor",
      status: "error",
      daily: [],
      error: "Invalid date range for Cursor usage export",
    };
  }

  const url = new URL(CURSOR_USAGE_CSV_URL);
  url.searchParams.set("startDate", String(startDateMs));
  url.searchParams.set("endDate", String(endDateMs));
  url.searchParams.set("strategy", "tokens");
  // OpenUsage format: userId%3A%3AaccessToken (only `::` is percent-encoded).
  const cookie = `WorkosCursorSessionToken=${userId}%3A%3A${session.accessToken}`;

  try {
    const fetchImpl = input?.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "text/csv",
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      return {
        provider: "cursor",
        status: "error",
        daily: [],
        sourcePath: url.toString(),
        error: `Cursor usage CSV export failed (${response.status})`,
      };
    }

    const text = await response.text();
    const parsed = parseCursorUsageCsv(text, { fromDay, toDay });
    if (!parsed.ok) {
      return {
        provider: "cursor",
        status: "error",
        daily: [],
        sourcePath: url.toString(),
        error: parsed.error,
      };
    }

    return { provider: "cursor", status: "ok", daily: parsed.daily, sourcePath: url.toString() };
  } catch (err) {
    return {
      provider: "cursor",
      status: "error",
      daily: [],
      error: err instanceof Error ? err.message : "Failed to fetch Cursor usage CSV",
    };
  }
}
