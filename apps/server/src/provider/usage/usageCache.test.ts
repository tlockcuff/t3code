// @effect-diagnostics globalDate:off
import type { ServerProviderUsage } from "@t3tools/contracts";
import { describe, expect, it, beforeEach } from "vite-plus/test";

import {
  clearUsageCache,
  resetUsageCache,
  USAGE_CACHE_TTL_MS,
  withUsageCache,
} from "./usageCache.ts";

const ok = (label: string): ServerProviderUsage => ({
  status: "ok",
  windows: [{ id: "primary", label, usedPercent: 10 }],
  updatedAt: "2026-07-10T00:00:00.000Z",
  source: "test",
});

const rateLimited = (): ServerProviderUsage => ({
  status: "error",
  windows: [],
  updatedAt: "2026-07-10T00:00:00.000Z",
  error: "Claude usage API rate-limited — try again shortly",
  source: "test",
});

const networkError = (): ServerProviderUsage => ({
  status: "error",
  windows: [],
  updatedAt: "2026-07-10T00:00:00.000Z",
  error: "fetch failed",
  source: "test",
});

describe("withUsageCache", () => {
  beforeEach(() => {
    resetUsageCache();
  });

  it("returns cached value within TTL without refetching", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return ok(`call-${calls}`);
    };

    const first = await withUsageCache("claude", fetch, { nowMs: 1_000 });
    const second = await withUsageCache("claude", fetch, { nowMs: 1_000 + USAGE_CACHE_TTL_MS - 1 });

    expect(first.windows[0]?.label).toBe("call-1");
    expect(second.windows[0]?.label).toBe("call-1");
    expect(calls).toBe(1);
  });

  it("refetches after TTL expires", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return ok(`call-${calls}`);
    };

    await withUsageCache("grok", fetch, { nowMs: 1_000 });
    const next = await withUsageCache("grok", fetch, { nowMs: 1_000 + USAGE_CACHE_TTL_MS + 1 });

    expect(next.windows[0]?.label).toBe("call-2");
    expect(calls).toBe(2);
  });

  it("coalesces concurrent fetches for the same key", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = async () => {
      calls += 1;
      await gate;
      return ok(`call-${calls}`);
    };

    const first = withUsageCache("cursor", fetch, { nowMs: 1_000 });
    const second = withUsageCache("cursor", fetch, { nowMs: 1_000 });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a.windows[0]?.label).toBe("call-1");
    expect(b.windows[0]?.label).toBe("call-1");
    expect(calls).toBe(1);
  });

  it("serves the previous snapshot when a refresh is rate-limited", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1 ? ok("fresh") : rateLimited();
    };

    await withUsageCache("claude", fetch, { nowMs: 1_000 });
    const afterLimit = await withUsageCache("claude", fetch, {
      nowMs: 1_000 + USAGE_CACHE_TTL_MS + 1,
    });

    expect(afterLimit.status).toBe("ok");
    expect(afterLimit.windows[0]?.label).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("serves the previous snapshot when a refresh fails for any error", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1 ? ok("fresh") : networkError();
    };

    await withUsageCache("claude", fetch, { nowMs: 1_000 });
    const afterError = await withUsageCache("claude", fetch, {
      nowMs: 1_000 + USAGE_CACHE_TTL_MS + 1,
    });

    expect(afterError.status).toBe("ok");
    expect(afterError.windows[0]?.label).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("keeps previous snapshot after clearUsageCache when the refetch is rate-limited", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return calls === 1 ? ok("fresh") : rateLimited();
    };

    await withUsageCache("claude", fetch, { nowMs: 1_000 });
    // Simulates force refresh: expire TTL without deleting last-good.
    clearUsageCache();
    const afterLimit = await withUsageCache("claude", fetch, { nowMs: 2_000 });

    expect(afterLimit.status).toBe("ok");
    expect(afterLimit.windows[0]?.label).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("serves the previous snapshot when a refresh throws (rejecting fetch)", async () => {
    let calls = 0;
    const fetch = async (): Promise<ServerProviderUsage> => {
      calls += 1;
      if (calls === 1) return ok("fresh");
      throw new Error("network down");
    };

    await withUsageCache("claude", fetch, { nowMs: 1_000 });
    const afterThrow = await withUsageCache("claude", fetch, {
      nowMs: 1_000 + USAGE_CACHE_TTL_MS + 1,
    });

    expect(afterThrow.status).toBe("ok");
    expect(afterThrow.windows[0]?.label).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("coalesced awaiters all get the previous snapshot when the fetch throws", async () => {
    let calls = 0;
    const fetch = async (): Promise<ServerProviderUsage> => {
      calls += 1;
      if (calls === 1) return ok("fresh");
      throw new Error("network down");
    };

    await withUsageCache("claude-coalesce", fetch, { nowMs: 1_000 });
    const nowMs = 1_000 + USAGE_CACHE_TTL_MS + 1;
    const [a, b] = await Promise.all([
      withUsageCache("claude-coalesce", fetch, { nowMs }),
      withUsageCache("claude-coalesce", fetch, { nowMs }),
    ]);

    expect(a.status).toBe("ok");
    expect(a.windows[0]?.label).toBe("fresh");
    expect(b.windows[0]?.label).toBe("fresh");
    expect(calls).toBe(2);
  });

  it("rethrows when the fetch throws and there is no previous snapshot", async () => {
    const fetch = async (): Promise<ServerProviderUsage> => {
      throw new Error("network down");
    };

    await expect(withUsageCache("claude-cold-throw", fetch, { nowMs: 1_000 })).rejects.toThrow(
      "network down",
    );
  });

  it("returns the error when there is no previous successful snapshot", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return rateLimited();
    };

    const result = await withUsageCache("claude-cold", fetch, { nowMs: 1_000 });

    expect(result.status).toBe("error");
    expect(result.windows).toEqual([]);
    expect(calls).toBe(1);
  });

  it("expires the cache shortly after a usage window resets", async () => {
    let calls = 0;
    const fetch = async (): Promise<ServerProviderUsage> => {
      calls += 1;
      return {
        status: "ok",
        windows: [
          {
            id: "five_hour",
            label: `call-${calls}`,
            usedPercent: 10,
            resetsAt: 1_000 + 60_000,
          },
        ],
        updatedAt: "2026-07-10T00:00:00.000Z",
        source: "test",
      };
    };

    await withUsageCache("claude-reset", fetch, { nowMs: 1_000 });
    const stillCached = await withUsageCache("claude-reset", fetch, { nowMs: 1_000 + 30_000 });
    const afterReset = await withUsageCache("claude-reset", fetch, { nowMs: 1_000 + 61_500 });

    expect(stillCached.windows[0]?.label).toBe("call-1");
    expect(afterReset.windows[0]?.label).toBe("call-2");
    expect(calls).toBe(2);
  });
});
