import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, type OrchestrationContextUsageThread } from "@t3tools/contracts";

import {
  formatFillPercent,
  groupContextUsageByProject,
  sharePercent,
  shortenUsageSourceLabel,
  summarizeHistoryWindows,
  summarizeMachineUsageByProvider,
  usedFillPercent,
} from "./UsageSettings.logic";

function makeThread(
  overrides: Partial<OrchestrationContextUsageThread> &
    Pick<OrchestrationContextUsageThread, "threadId" | "projectId" | "projectTitle" | "title">,
): OrchestrationContextUsageThread {
  return {
    archivedAt: null,
    updatedAt: "2026-07-10T12:00:00.000Z",
    usedTokens: 10_000,
    maxTokens: 100_000,
    totalProcessedTokens: 20_000,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    ...overrides,
  };
}

describe("UsageSettings.logic", () => {
  it("computes fill percent from used/max tokens", () => {
    expect(usedFillPercent(25_000, 100_000)).toBe(25);
    expect(usedFillPercent(10, null)).toBeNull();
    expect(formatFillPercent(9.4)).toBe("9.4%");
    expect(formatFillPercent(42.2)).toBe("42%");
  });

  it("groups threads by project, sorts by recent activity, and rolls up totals", () => {
    const groups = groupContextUsageByProject([
      makeThread({
        threadId: ThreadId.make("t1"),
        projectId: ProjectId.make("p1"),
        projectTitle: "Alpha",
        title: "Thread A",
        updatedAt: "2026-07-09T12:00:00.000Z",
        usedTokens: 40_000,
        maxTokens: 100_000,
        totalProcessedTokens: 80_000,
      }),
      makeThread({
        threadId: ThreadId.make("t2"),
        projectId: ProjectId.make("p1"),
        projectTitle: "Alpha",
        title: "Thread B",
        updatedAt: "2026-07-11T12:00:00.000Z",
        usedTokens: 10_000,
        maxTokens: 200_000,
        totalProcessedTokens: 12_000,
      }),
      makeThread({
        threadId: ThreadId.make("t3"),
        projectId: ProjectId.make("p2"),
        projectTitle: "Beta",
        title: "Thread C",
        updatedAt: "2026-07-10T12:00:00.000Z",
        usedTokens: 90_000,
        maxTokens: 100_000,
        totalProcessedTokens: null,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.projectTitle).toBe("Alpha");
    expect(groups[0]?.lastUpdatedAt).toBe("2026-07-11T12:00:00.000Z");
    expect(groups[0]?.threads.map((thread) => thread.threadId)).toEqual([
      ThreadId.make("t2"),
      ThreadId.make("t1"),
    ]);
    expect(groups[0]?.threadCount).toBe(2);
    expect(groups[0]?.totalUsedTokens).toBe(50_000);
    expect(groups[0]?.totalProcessedTokens).toBe(92_000);
    expect(groups[0]?.maxFillPercent).toBe(40);
    expect(groups[1]?.projectTitle).toBe("Beta");
    expect(groups[1]?.maxFillPercent).toBe(90);
  });

  it("summarizes today/yesterday/7d/30d windows on local calendar days", () => {
    // Local noon on July 10 — independent of UTC offset.
    const nowMs = new Date(2026, 6, 10, 12, 0, 0).getTime();
    const summary = summarizeHistoryWindows(
      [
        { day: "2026-07-10", totalTokens: 100, estimatedCostUsd: 1 },
        { day: "2026-07-09", totalTokens: 200, estimatedCostUsd: 2 },
        { day: "2026-07-05", totalTokens: 50, estimatedCostUsd: 0.5 },
        { day: "2026-06-01", totalTokens: 999, estimatedCostUsd: 9 },
      ],
      nowMs,
    );
    expect(summary.today.tokens).toBe(100);
    expect(summary.yesterday.tokens).toBe(200);
    expect(summary.last7Days.tokens).toBe(350);
    expect(summary.last30Days.tokens).toBe(350);
  });

  it("rolls up machine usage per provider", () => {
    const nowMs = new Date(2026, 6, 10, 12, 0, 0).getTime();
    const summaries = summarizeMachineUsageByProvider(
      [
        {
          provider: "claude",
          status: "ok",
          daily: [
            { day: "2026-07-10", totalTokens: 100, estimatedCostUsd: 1 },
            { day: "2026-07-09", totalTokens: 50, estimatedCostUsd: 0.5 },
          ],
        },
        {
          provider: "codex",
          status: "ok",
          daily: [{ day: "2026-07-10", totalTokens: 20, estimatedCostUsd: 0.2 }],
        },
      ],
      nowMs,
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.label).toBe("Claude");
    expect(summaries[0]?.windows.today.tokens).toBe(100);
    expect(summaries[0]?.windows.last7Days.tokens).toBe(150);
    expect(summaries[1]?.windows.today.tokens).toBe(20);
  });

  it("shortens source paths and urls for display", () => {
    expect(shortenUsageSourceLabel("/Users/travis/.claude/stats-cache.json")).toBe(
      "…/.claude/stats-cache.json",
    );
    expect(
      shortenUsageSourceLabel(
        "https://cursor.com/api/dashboard/export-usage-events-csv?startDate=1",
      ),
    ).toBe("cursor.com/export-usage-events-csv");
    expect(sharePercent(25, 100)).toBe(25);
    expect(sharePercent(0, 100)).toBe(0);
  });
});
