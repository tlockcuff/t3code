// @effect-diagnostics globalDate:off
import type { ServerProviderUsage } from "@t3tools/contracts";
import { describe, expect, it, beforeEach } from "vite-plus/test";

import { clearUsageCache, USAGE_CACHE_TTL_MS, withUsageCache } from "./usageCache.ts";

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

describe("withUsageCache", () => {
  beforeEach(() => {
    clearUsageCache();
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
