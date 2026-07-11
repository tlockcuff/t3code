// @effect-diagnostics globalDate:off
import type { ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";

/** Don't schedule provider usage refreshes more often than this. */
export const MIN_PROVIDER_SNAPSHOT_REFRESH_DELAY_MS = 5_000;

/** Refresh shortly after a rate-limit window resets so meters drop promptly. */
export const USAGE_RESET_REFRESH_BUFFER_MS = 2_000;

/**
 * Pick the next snapshot refresh delay from the base interval and any usage
 * window `resetsAt` timestamps on the current snapshot.
 *
 * Providers normally refresh every ~5 minutes. When a plan/rate-limit window
 * is about to reset sooner than that, wake up just after the reset so the
 * sidebar meters update without waiting for the full interval.
 */
export function nextProviderSnapshotRefreshDelay(
  snapshot: ServerProvider,
  refreshInterval: Duration.Duration,
  nowMs = Date.now(),
): Duration.Duration {
  const intervalMs = Math.max(
    MIN_PROVIDER_SNAPSHOT_REFRESH_DELAY_MS,
    Duration.toMillis(refreshInterval),
  );
  let delayMs = intervalMs;

  const usage = snapshot.usage;
  if (usage?.status === "ok") {
    for (const window of usage.windows) {
      const resetsAt = window.resetsAt;
      if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) continue;
      const untilResetMs = resetsAt - nowMs + USAGE_RESET_REFRESH_BUFFER_MS;
      if (untilResetMs > 0 && untilResetMs < delayMs) {
        delayMs = untilResetMs;
      }
    }
  }

  return Duration.millis(
    Math.min(intervalMs, Math.max(MIN_PROVIDER_SNAPSHOT_REFRESH_DELAY_MS, delayMs)),
  );
}
