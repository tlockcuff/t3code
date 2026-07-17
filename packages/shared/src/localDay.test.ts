// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  localDayKeyFromDate,
  localDayKeyFromIso,
  localDayKeyFromMs,
  localDayOffset,
} from "./localDay.ts";

describe("localDay", () => {
  it("formats a Date as yyyy-MM-dd in local time", () => {
    const date = new Date(2026, 6, 16, 23, 30, 0); // July 16 local
    expect(localDayKeyFromDate(date)).toBe("2026-07-16");
  });

  it("maps ISO timestamps through the local calendar", () => {
    // Mid-day UTC stays the same calendar day for US + most EU zones.
    expect(localDayKeyFromIso("2026-07-16T15:00:00.000Z")).toBe(
      localDayKeyFromMs(Date.parse("2026-07-16T15:00:00.000Z")),
    );
  });

  it("rejects empty or invalid ISO strings", () => {
    expect(localDayKeyFromIso("")).toBeNull();
    expect(localDayKeyFromIso("not-a-date")).toBeNull();
  });

  it("offsets local calendar days from a fixed now", () => {
    const nowMs = new Date(2026, 6, 16, 15, 0, 0).getTime(); // July 16 local
    expect(localDayOffset(0, nowMs)).toBe("2026-07-16");
    expect(localDayOffset(1, nowMs)).toBe("2026-07-15");
    expect(localDayOffset(6, nowMs)).toBe("2026-07-10");
  });
});
