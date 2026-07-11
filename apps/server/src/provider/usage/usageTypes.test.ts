import { describe, expect, it } from "vite-plus/test";

import { mapCodexRateLimitsToUsage } from "./codexUsage.ts";
import { remainingPercent, usageWindow } from "./usageTypes.ts";

describe("provider usage helpers", () => {
  it("maps Codex rate-limit windows", () => {
    const usage = mapCodexRateLimitsToUsage(
      {
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_783_684_811 },
          secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_783_784_811 },
        },
      },
      "2026-07-10T00:00:00.000Z",
    );

    expect(usage.status).toBe("ok");
    expect(usage.planLabel).toBe("Pro");
    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[0]?.id).toBe("primary");
    expect(usage.windows[0]?.resetsAt).toBe(1_783_684_811_000);
  });

  it("clamps remaining percent", () => {
    expect(remainingPercent(110)).toBe(0);
    expect(usageWindow({ id: "x", label: "X", usedPercent: -5 }).usedPercent).toBe(0);
  });
});
