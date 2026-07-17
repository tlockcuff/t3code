// @effect-diagnostics globalDate:off
/**
 * Local-calendar day keys (`yyyy-MM-dd`) for spend / usage tiles.
 *
 * Matches OpenUsage's `DailyUsageAccumulator.dayKey`: buckets must follow the
 * machine's local calendar so "Today" / "Yesterday" line up with the user's day,
 * not UTC midnight.
 */

export function localDayKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayKeyFromMs(ms: number): string {
  return localDayKeyFromDate(new Date(ms));
}

/** Parse an ISO timestamp into a local calendar day, or null if invalid. */
export function localDayKeyFromIso(iso: string): string | null {
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return localDayKeyFromMs(ms);
}

/** Local calendar day `daysAgo` before `nowMs` (0 = today). */
export function localDayOffset(daysAgo: number, nowMs = Date.now()): string {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return localDayKeyFromDate(date);
}
