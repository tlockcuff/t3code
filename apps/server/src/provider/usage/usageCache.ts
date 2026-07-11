// @effect-diagnostics globalDate:off
import type { ServerProviderUsage } from "@t3tools/contracts";

/** Aligns with provider snapshot refresh (~5 minutes). */
export const USAGE_CACHE_TTL_MS = 5 * 60 * 1_000;

/** Keep a little headroom after a window reset before serving a cached meter. */
const USAGE_RESET_CACHE_BUFFER_MS = 1_000;

type UsageCacheEntry = {
  readonly value: ServerProviderUsage;
  readonly expiresAt: number;
};

const cache = new Map<string, UsageCacheEntry>();
const inflight = new Map<string, Promise<ServerProviderUsage>>();

function isRateLimitedUsage(usage: ServerProviderUsage): boolean {
  if (usage.status !== "error" || !usage.error) return false;
  return /rate[- ]?limit|429/i.test(usage.error);
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
 * On a rate-limit error, returns the last successful (or previous) snapshot when
 * one exists so the UI keeps showing numbers instead of a hard failure.
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

  const promise = (async () => {
    try {
      const value = await fetch();
      if (isRateLimitedUsage(value) && cached) {
        // Keep serving the previous snapshot and extend its TTL so we back off.
        cache.set(key, { value: cached.value, expiresAt: nowMs + defaultTtlMs });
        return cached.value;
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

/** Test helper — clears cached snapshots and in-flight fetches. */
export function clearUsageCache(): void {
  cache.clear();
  inflight.clear();
}
