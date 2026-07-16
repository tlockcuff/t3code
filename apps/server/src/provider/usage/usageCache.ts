// @effect-diagnostics globalDate:off
import type { ServerProviderUsage } from "@t3tools/contracts";

/** Aligns with provider snapshot refresh (~5 minutes). */
export const USAGE_CACHE_TTL_MS = 5 * 60 * 1_000;

/** Brief backoff after a non-rate-limit error so we retry sooner than the full TTL. */
const USAGE_ERROR_BACKOFF_MS = 60_000;

/** Keep a little headroom after a window reset before serving a cached meter. */
const USAGE_RESET_CACHE_BUFFER_MS = 1_000;

type UsageCacheEntry = {
  readonly value: ServerProviderUsage;
  readonly expiresAt: number;
};

/** Live TTL cache (what we serve while fresh). */
const cache = new Map<string, UsageCacheEntry>();
/**
 * Last displayable snapshot per key. Survives `clearUsageCache()` so force
 * refresh + rate-limit/error still keeps sidebar meters populated.
 */
const lastGood = new Map<string, ServerProviderUsage>();
const inflight = new Map<string, Promise<ServerProviderUsage>>();

function isRateLimitedUsage(usage: ServerProviderUsage): boolean {
  if (usage.status !== "error" || !usage.error) return false;
  return /rate[- ]?limit|429/i.test(usage.error);
}

function isDisplayableUsage(usage: ServerProviderUsage): boolean {
  return usage.status === "ok" && usage.windows.length > 0;
}

function ttlMsForUsage(usage: ServerProviderUsage, nowMs: number, defaultTtlMs: number): number {
  let ttlMs = defaultTtlMs;
  if (usage.status !== "ok") return ttlMs;
  for (const window of usage.windows) {
    const resetsAt = window.resetsAt;
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= nowMs) {
      continue;
    }
    const untilResetMs = resetsAt - nowMs + USAGE_RESET_CACHE_BUFFER_MS;
    if (untilResetMs < ttlMs) {
      ttlMs = Math.max(1_000, untilResetMs);
    }
  }
  return ttlMs;
}

/**
 * Cache provider usage fetches for a short TTL and coalesce concurrent callers.
 *
 * On fetch failure (rate-limit, network, 5xx, etc.), returns the last successful
 * snapshot when one exists so the sidebar keeps showing meters instead of blanking.
 */
export async function withUsageCache(
  key: string,
  fetch: () => Promise<ServerProviderUsage>,
  options?: {
    readonly nowMs?: number;
    readonly ttlMs?: number;
  },
): Promise<ServerProviderUsage> {
  const nowMs = options?.nowMs ?? Date.now();
  const defaultTtlMs = options?.ttlMs ?? USAGE_CACHE_TTL_MS;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > nowMs) {
    return cached.value;
  }

  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }

  const previousOk = lastGood.get(key) ?? null;

  const promise = (async () => {
    try {
      let value: ServerProviderUsage;
      try {
        value = await fetch();
      } catch (cause) {
        // A rejecting fetch (network throw, timeout, etc.) must fall back to the
        // last-good snapshot too — otherwise the rejection propagates to every
        // coalesced awaiter and blanks the meters, contradicting the docstring.
        if (previousOk) {
          const backoffMs = Math.min(USAGE_ERROR_BACKOFF_MS, defaultTtlMs);
          cache.set(key, { value: previousOk, expiresAt: nowMs + backoffMs });
          return previousOk;
        }
        throw cause;
      }
      if (value.status === "error" && previousOk) {
        // Keep serving the previous snapshot and back off before retrying.
        // Rate limits use the full TTL; other transient errors retry sooner.
        const backoffMs = isRateLimitedUsage(value)
          ? defaultTtlMs
          : Math.min(USAGE_ERROR_BACKOFF_MS, defaultTtlMs);
        cache.set(key, { value: previousOk, expiresAt: nowMs + backoffMs });
        return previousOk;
      }
      if (isDisplayableUsage(value)) {
        lastGood.set(key, value);
      }
      const ttlMs = ttlMsForUsage(value, nowMs, defaultTtlMs);
      cache.set(key, { value, expiresAt: nowMs + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Force the next `withUsageCache` call for every key to refetch.
 *
 * Does not wipe last-good snapshots — a failed refetch still falls back so the
 * UI does not blank on rate limits / transient errors.
 */
export function clearUsageCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Full wipe including last-good snapshots. Test helper only.
 */
export function resetUsageCache(): void {
  cache.clear();
  lastGood.clear();
  inflight.clear();
}
