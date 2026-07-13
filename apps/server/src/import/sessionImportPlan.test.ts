import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildResumeCursor,
  driverKindForProvider,
  planBackfillMessages,
} from "./sessionImportPlan.ts";
import type { ImportedMessage } from "./sessionTranscript.ts";

const CLAUDE_SESSION = "11111111-2222-3333-4444-555555555555";

describe("buildResumeCursor", () => {
  it("builds a Claude cursor the adapter will accept", () => {
    expect(buildResumeCursor("claude", CLAUDE_SESSION)).toEqual({
      resume: CLAUDE_SESSION,
      turnCount: 0,
    });
  });

  it("rejects a non-UUID Claude session id, which the adapter would silently discard", () => {
    expect(buildResumeCursor("claude", "not-a-uuid")).toBeNull();
  });

  it("builds a Codex cursor keyed by thread id", () => {
    expect(buildResumeCursor("codex", "019efc85-b7b4-7ff0-ad84-58233e60475f")).toEqual({
      threadId: "019efc85-b7b4-7ff0-ad84-58233e60475f",
    });
  });

  it("rejects a blank session id for either provider", () => {
    expect(buildResumeCursor("codex", "   ")).toBeNull();
    expect(buildResumeCursor("claude", "")).toBeNull();
  });
});

describe("driverKindForProvider", () => {
  it("maps claude sessions to the claudeAgent driver slug", () => {
    expect(driverKindForProvider("claude")).toBe("claudeAgent");
  });

  it("maps codex sessions to the codex driver slug", () => {
    expect(driverKindForProvider("codex")).toBe("codex");
  });
});

const message = (
  role: ImportedMessage["role"],
  text: string,
  timestamp: string | null,
): ImportedMessage => ({ role, text, timestamp });

describe("planBackfillMessages", () => {
  it("preserves original timestamps and transcript order", () => {
    const planned = planBackfillMessages(
      [
        message("user", "one", "2026-07-01T00:00:00.000Z"),
        message("assistant", "two", "2026-07-01T00:00:05.000Z"),
      ],
      0,
    );

    expect(planned).toEqual([
      {
        messageId: "import-00000",
        role: "user",
        text: "one",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        messageId: "import-00001",
        role: "assistant",
        text: "two",
        createdAt: "2026-07-01T00:00:05.000Z",
      },
    ]);
  });

  it("forces strictly increasing timestamps when the transcript repeats or regresses", () => {
    const planned = planBackfillMessages(
      [
        message("user", "a", "2026-07-01T00:00:00.000Z"),
        message("assistant", "b", "2026-07-01T00:00:00.000Z"),
        message("user", "c", "2025-01-01T00:00:00.000Z"),
      ],
      0,
    );

    const times = planned.map((entry) => entry.createdAt);
    expect(times[0]).toBe("2026-07-01T00:00:00.000Z");
    expect(times[1]).toBe("2026-07-01T00:00:00.001Z");
    expect(times[2]).toBe("2026-07-01T00:00:00.002Z");
    // The timeline sorts on createdAt with no tie-break, so equal stamps would scramble history.
    expect(new Set(times).size).toBe(3);
  });

  it("falls back to synthetic timestamps when the transcript has none", () => {
    const planned = planBackfillMessages(
      [message("user", "a", null), message("assistant", "b", null)],
      1_000,
    );

    expect(planned[0]?.createdAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_000)));
    expect(planned[1]?.createdAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(1_001)));
  });

  it("zero-pads message ids so id order matches transcript order", () => {
    const planned = planBackfillMessages(
      Array.from({ length: 11 }, (_, index) => message("user", `m${index}`, null)),
      0,
    );

    expect(planned[9]?.messageId).toBe("import-00009");
    expect(planned[10]?.messageId).toBe("import-00010");
    expect(planned.map((entry) => entry.messageId).sort()).toEqual(
      planned.map((entry) => entry.messageId),
    );
  });

  it("returns an empty plan for an empty transcript", () => {
    expect(planBackfillMessages([], 0)).toEqual([]);
  });
});
