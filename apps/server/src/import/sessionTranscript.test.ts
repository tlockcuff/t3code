import { describe, expect, it } from "vite-plus/test";

import { deriveTitle, parseClaudeSession, parseCodexSession } from "./sessionTranscript.ts";

const toLines = (records: ReadonlyArray<unknown>): Array<string> =>
  records.map((record) => JSON.stringify(record));

const claudeUser = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd: "/repo",
  gitBranch: "main",
  timestamp: "2026-07-01T00:00:00.000Z",
  message: { role: "user", content: text },
  ...extra,
});

const claudeAssistant = (parts: ReadonlyArray<unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  sessionId: "11111111-2222-3333-4444-555555555555",
  cwd: "/repo",
  timestamp: "2026-07-01T00:00:01.000Z",
  message: { role: "assistant", content: parts },
  ...extra,
});

const codexMessage = (role: string, text: string, partType = "input_text") => ({
  type: "response_item",
  timestamp: "2026-07-01T00:00:02.000Z",
  payload: { type: "message", role, content: [{ type: partType, text }] },
});

const codexMeta = {
  type: "session_meta",
  timestamp: "2026-07-01T00:00:00.000Z",
  payload: {
    session_id: "019efc85-b7b4-7ff0-ad84-58233e60475f",
    cwd: "/repo",
    timestamp: "2026-07-01T00:00:00.000Z",
  },
};

describe("deriveTitle", () => {
  it("collapses whitespace", () => {
    expect(deriveTitle("  fix   the\n build ")).toBe("fix the build");
  });

  it("truncates long text on a word boundary", () => {
    const title = deriveTitle("a".repeat(20) + " " + "b".repeat(120));
    expect(title?.endsWith("…")).toBe(true);
    expect((title ?? "").length).toBeLessThanOrEqual(81);
  });

  it("returns null for blank text", () => {
    expect(deriveTitle("   ")).toBeNull();
  });
});

describe("parseClaudeSession", () => {
  it("extracts metadata and text messages", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([claudeUser("Add dark mode"), claudeAssistant([{ type: "text", text: "On it." }])]),
    );

    expect(parsed?.summary).toMatchObject({
      provider: "claude",
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: "/repo",
      branch: "main",
      title: "Add dark mode",
      messageCount: 2,
    });
    expect(parsed?.messages).toEqual([
      { role: "user", text: "Add dark mode", timestamp: "2026-07-01T00:00:00.000Z" },
      { role: "assistant", text: "On it.", timestamp: "2026-07-01T00:00:01.000Z" },
    ]);
  });

  it("drops tool_result records, which Claude records with role user", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([
        claudeUser("Run the tests"),
        claudeAssistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
        claudeUser("ignored", {
          message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
        }),
      ]),
    );

    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.messages[0]?.text).toBe("Run the tests");
  });

  it("ignores sidechain (subagent) records", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([
        claudeUser("Real prompt"),
        claudeUser("Subagent chatter", { isSidechain: true }),
        claudeAssistant([{ type: "text", text: "Done." }], { isSidechain: true }),
      ]),
    );

    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.messages[0]?.text).toBe("Real prompt");
  });

  it("rejects sessions whose only prompt is Claude's title generator", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([
        claudeUser("You write concise thread titles for coding conversations.\nReturn JSON."),
        claudeAssistant([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      ]),
    );

    expect(parsed).toBeNull();
  });

  it("returns null when no session id is present", () => {
    const parsed = parseClaudeSession("/s.jsonl", toLines([{ type: "user", message: {} }]));
    expect(parsed).toBeNull();
  });

  it("titles the session from the first human turn, not an injected one", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([
        claudeUser("<command-name>/compact</command-name>"),
        claudeUser("<local-command-caveat>Caveat: …</local-command-caveat>"),
        claudeUser("Actually fix the flaky test"),
        claudeAssistant([{ type: "text", text: "Sure." }]),
      ]),
    );

    expect(parsed?.summary.title).toBe("Actually fix the flaky test");
    // Injected turns stay in the transcript — the agent saw them — they just cannot be the title.
    expect(parsed?.messages).toHaveLength(4);
  });

  it("rejects a session whose every user turn was injected by the harness", () => {
    const parsed = parseClaudeSession(
      "/s.jsonl",
      toLines([
        claudeUser("[structured-output-enforce] You MUST call the StructuredOutput tool."),
        claudeAssistant([{ type: "text", text: "ok" }]),
      ]),
    );

    expect(parsed).toBeNull();
  });

  it("tolerates a torn trailing line from a live-appended file", () => {
    const parsed = parseClaudeSession("/s.jsonl", [
      ...toLines([claudeUser("Hello")]),
      '{"type":"assistant","mess',
    ]);

    expect(parsed?.messages).toHaveLength(1);
  });
});

describe("parseCodexSession", () => {
  it("extracts metadata and messages from response_item records", () => {
    const parsed = parseCodexSession(
      "/rollout.jsonl",
      toLines([
        codexMeta,
        codexMessage("user", "Upgrade the checkout"),
        codexMessage("assistant", "Sure.", "output_text"),
      ]),
    );

    expect(parsed?.summary).toMatchObject({
      provider: "codex",
      sessionId: "019efc85-b7b4-7ff0-ad84-58233e60475f",
      cwd: "/repo",
      title: "Upgrade the checkout",
      messageCount: 2,
    });
  });

  it("skips the injected AGENTS.md and environment_context preambles", () => {
    const parsed = parseCodexSession(
      "/rollout.jsonl",
      toLines([
        codexMeta,
        codexMessage(
          "user",
          "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>x</INSTRUCTIONS>",
        ),
        codexMessage("user", "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"),
        codexMessage("user", "Actually fix the bug"),
      ]),
    );

    expect(parsed?.summary.title).toBe("Actually fix the bug");
    expect(parsed?.messages).toHaveLength(1);
  });

  it("drops external agent tool echoes", () => {
    const parsed = parseCodexSession(
      "/rollout.jsonl",
      toLines([
        codexMeta,
        codexMessage("user", "Run it"),
        codexMessage("assistant", "[external_agent_tool_call: Bash]\ncommand: ls", "output_text"),
        codexMessage("assistant", "[external_agent_tool_result]\nfiles", "output_text"),
        codexMessage("assistant", "All set.", "output_text"),
      ]),
    );

    expect(parsed?.messages.map((message) => message.text)).toEqual(["Run it", "All set."]);
  });

  it("ignores event_msg records, which duplicate the durable transcript", () => {
    const parsed = parseCodexSession(
      "/rollout.jsonl",
      toLines([
        codexMeta,
        codexMessage("user", "Hello"),
        { type: "event_msg", timestamp: "t", payload: { type: "agent_message", message: "dupe" } },
      ]),
    );

    expect(parsed?.messages).toHaveLength(1);
  });

  it("returns null when the session contains only preamble", () => {
    const parsed = parseCodexSession(
      "/rollout.jsonl",
      toLines([codexMeta, codexMessage("user", "<environment_context>x</environment_context>")]),
    );

    expect(parsed).toBeNull();
  });
});
