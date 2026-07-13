import type { ModelSelection, ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildResumeCursor,
  driverKindForProvider,
  planBackfillMessages,
  resolveImportModelSelection,
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

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isCustom?: boolean }>;
  readonly enabled?: boolean;
  readonly availability?: "available" | "unavailable";
}): ServerProvider =>
  ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: {},
    checkedAt: "2026-07-01T00:00:00.000Z",
    availability: input.availability ?? "available",
    models: input.models.map((model) => ({
      slug: model.slug,
      name: model.slug,
      isCustom: model.isCustom ?? false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

const selection = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId, model }) as unknown as ModelSelection;

const CLAUDE_AGENT = "claudeAgent" as ProviderDriverKind;
const CODEX = "codex" as ProviderDriverKind;

const CLAUDE_INSTANCE = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  models: [{ slug: "claude-opus-4-8" }],
});
const CODEX_INSTANCE = provider({
  instanceId: "codex",
  driver: "codex",
  models: [{ slug: "gpt-5.4" }],
});

describe("resolveImportModelSelection", () => {
  it("ignores a selection pointing at another provider, which would lock the thread to a driver that cannot resume it", () => {
    // The regression: the web client sends the project's default selection, so importing a Claude
    // session into a Codex-default project used to bind a Claude cursor to the Codex adapter.
    expect(
      resolveImportModelSelection({
        driverKind: CLAUDE_AGENT,
        providers: [CODEX_INSTANCE, CLAUDE_INSTANCE],
        requested: selection("codex", "gpt-5.4"),
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
  });

  it("keeps a selection that already names an instance of the session's own driver", () => {
    const custom = provider({
      instanceId: "claude_personal",
      driver: "claudeAgent",
      models: [{ slug: "claude-sonnet-5" }],
    });
    expect(
      resolveImportModelSelection({
        driverKind: CLAUDE_AGENT,
        providers: [CLAUDE_INSTANCE, custom],
        requested: selection("claude_personal", "claude-sonnet-5"),
      }),
    ).toEqual(selection("claude_personal", "claude-sonnet-5"));
  });

  it("falls back to a custom instance when the driver's default instance is disabled", () => {
    const disabledDefault = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: [{ slug: "claude-opus-4-8" }],
      enabled: false,
    });
    const custom = provider({
      instanceId: "claude_personal",
      driver: "claudeAgent",
      models: [{ slug: "claude-sonnet-5" }],
    });
    expect(
      resolveImportModelSelection({
        driverKind: CLAUDE_AGENT,
        providers: [disabledDefault, custom, CODEX_INSTANCE],
        requested: selection("codex", "gpt-5.4"),
      }),
    ).toEqual({ instanceId: "claude_personal", model: "claude-sonnet-5" });
  });

  it("prefers a stock model over a user-authored custom alias", () => {
    const withCustomFirst = provider({
      instanceId: "codex",
      driver: "codex",
      models: [{ slug: "my-alias", isCustom: true }, { slug: "gpt-5.4" }],
    });
    expect(
      resolveImportModelSelection({
        driverKind: CODEX,
        providers: [withCustomFirst],
        requested: selection("claudeAgent", "claude-opus-4-8"),
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  });

  it("returns null when the session's driver has no enabled instance, so the import fails loudly", () => {
    expect(
      resolveImportModelSelection({
        driverKind: CLAUDE_AGENT,
        providers: [CODEX_INSTANCE],
        requested: selection("codex", "gpt-5.4"),
      }),
    ).toBeNull();
  });

  it("returns null when the only instance of the driver is unavailable", () => {
    const unavailable = provider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      models: [{ slug: "claude-opus-4-8" }],
      availability: "unavailable",
    });
    expect(
      resolveImportModelSelection({
        driverKind: CLAUDE_AGENT,
        providers: [unavailable, CODEX_INSTANCE],
        requested: selection("claudeAgent", "claude-opus-4-8"),
      }),
    ).toBeNull();
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
