// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readClaudeStatsCacheUsage } from "./claudeStatsCache.ts";
import { readCodexSessionUsage } from "./codexSessionUsage.ts";
import { parseCursorUsageCsv } from "./cursorUsageHistory.ts";
import { readGrokLogUsage } from "./grokLogUsage.ts";

describe("machine usage readers", () => {
  it("reads Claude session transcript usage with priced buckets", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-usage-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "session.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T15:00:00.000Z",
          message: {
            id: "msg_1",
            model: "claude-sonnet-4-6",
            usage: {
              input_tokens: 1_000,
              cache_read_input_tokens: 10_000,
              cache_creation_input_tokens: 1_000,
              output_tokens: 500,
            },
          },
        }),
      );
      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.status).toBe("ok");
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0]?.totalTokens).toBe(12_500);
      expect(result.daily[0]?.cachedInputTokens).toBe(10_000);
      expect(result.daily[0]?.estimatedCostUsd).toBeGreaterThan(0);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers costUSD on Claude log lines when present", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-costusd-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "session.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T15:00:00.000Z",
          costUSD: 1.23,
          message: {
            id: "msg_cost",
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        }),
      );
      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.daily[0]?.estimatedCostUsd).toBe(1.23);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prices 1h cache writes separately from 5m writes", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cache1h-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "session.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T15:00:00.000Z",
          message: {
            id: "msg_1h",
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: {
                ephemeral_5m_input_tokens: 1_000_000,
                ephemeral_1h_input_tokens: 1_000_000,
              },
            },
          },
        }),
      );
      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      // Opus 4.8: 5m write 6.25 + 1h write 2×input(5)=10 → 16.25
      expect(result.daily[0]?.cacheWriteTokens).toBe(2_000_000);
      expect(result.daily[0]?.estimatedCostUsd).toBeCloseTo(16.25, 2);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("counts a resumed assistant message once across transcripts", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-dedupe-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });

      const assistantLine = (id: string, requestId: string) =>
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T15:00:00.000Z",
          requestId,
          message: {
            id,
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 1_000,
              cache_creation_input_tokens: 200,
              output_tokens: 50,
            },
          },
        });

      // Resuming a session copies prior messages into a new transcript, so the
      // same (message.id, requestId) shows up in both files.
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "original.jsonl"),
        assistantLine("msg_abc", "req_1"),
      );
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "resumed.jsonl"),
        [assistantLine("msg_abc", "req_1"), assistantLine("msg_def", "req_2")].join("\n"),
      );

      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      const row = result.daily.find((entry) => entry.day === "2026-07-10");
      // Two distinct messages × 1,350 tokens each — the copy is not re-counted.
      expect(row?.totalTokens).toBe(2_700);
      expect(row?.cachedInputTokens).toBe(2_000);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers non-sidechain parent over sidechain replay of the same message", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-sidechain-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "session.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-07-10T15:00:00.000Z",
            requestId: "req_a",
            isSidechain: true,
            message: {
              id: "msg_shared",
              model: "claude-opus-4-8",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-07-10T15:00:00.000Z",
            requestId: "req_b",
            isSidechain: false,
            message: {
              id: "msg_shared",
              model: "claude-opus-4-8",
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
        ].join("\n"),
      );

      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.daily[0]?.totalTokens).toBe(15);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("still counts legacy transcript rows that carry no message id", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-legacy-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      const line = JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-10T15:00:00.000Z",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      // Undeduplicatable rows must not be silently dropped — under-counting a
      // real call is worse than double-counting a legacy one.
      NodeFS.writeFileSync(NodePath.join(sessionDir, "legacy.jsonl"), [line, line].join("\n"));

      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      const row = result.daily.find((entry) => entry.day === "2026-07-10");
      expect(row?.totalTokens).toBe(30);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("counts advisor_message iterations under their own model", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-advisor-"));
    try {
      const sessionDir = NodePath.join(home, "projects", "demo");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "session.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-07-10T15:00:00.000Z",
          message: {
            id: "msg_parent",
            model: "claude-opus-4-8",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              iterations: [
                {
                  type: "advisor_message",
                  model: "claude-haiku-4-5-20251001",
                  input_tokens: 20,
                  output_tokens: 10,
                },
              ],
            },
          },
        }),
      );
      const result = readClaudeStatsCacheUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.daily).toHaveLength(2);
      const opus = result.daily.find((row) => row.model === "claude-opus-4-8");
      const haiku = result.daily.find((row) => row.model === "claude-haiku-4-5-20251001");
      expect(opus?.totalTokens).toBe(150);
      expect(haiku?.totalTokens).toBe(30);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports missing when Claude projects dir is absent", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-missing-"));
    try {
      const result = readClaudeStatsCacheUsage({ homePath: home });
      expect(result.status).toBe("missing");
      expect(result.daily).toEqual([]);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Codex rollout token_count totals", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-usage-"));
    try {
      const sessionDir = NodePath.join(home, "sessions", "2026", "07", "10");
      NodeFS.mkdirSync(sessionDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(sessionDir, "rollout-test.jsonl"),
        [
          JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.3-codex" } }),
          JSON.stringify({
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 8_000,
                  cached_input_tokens: 2_000,
                  output_tokens: 1_000,
                  reasoning_output_tokens: 500,
                  total_tokens: 9_500,
                },
              },
            },
          }),
        ].join("\n"),
      );
      const result = readCodexSessionUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.status).toBe("ok");
      expect(result.daily).toHaveLength(1);
      expect(result.daily[0]?.day).toBe("2026-07-10");
      expect(result.daily[0]?.model).toBe("gpt-5.3-codex");
      expect(result.daily[0]?.totalTokens).toBe(9_500);
      expect(result.daily[0]?.inputTokens).toBe(6_000);
      expect(result.daily[0]?.cachedInputTokens).toBe(2_000);
      expect(result.daily[0]?.outputTokens).toBe(1_500);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads Grok unified.jsonl inference_done rows with per-pid model", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-grok-usage-"));
    try {
      const logsDir = NodePath.join(home, "logs");
      NodeFS.mkdirSync(logsDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(logsDir, "unified.jsonl"),
        [
          JSON.stringify({
            ts: "2026-07-09T15:00:00.000Z",
            pid: 42,
            msg: "model catalog: notifying clients",
            ctx: { current_model_id: "grok-4.5" },
          }),
          JSON.stringify({
            ts: "2026-07-09T15:57:14.102Z",
            pid: 42,
            msg: "shell.turn.inference_done",
            ctx: {
              prompt_tokens: 1_000,
              cached_prompt_tokens: 800,
              completion_tokens: 50,
              reasoning_tokens: 20,
            },
          }),
          JSON.stringify({
            ts: "2026-07-10T15:00:00.000Z",
            pid: 42,
            msg: "shell.turn.inference_done",
            ctx: {
              prompt_tokens: 500,
              cached_prompt_tokens: 0,
              completion_tokens: 100,
              reasoning_tokens: 0,
            },
          }),
        ].join("\n"),
      );
      const result = await readGrokLogUsage({ homePath: home, fromDay: "2026-07-01" });
      expect(result.status).toBe("ok");
      expect(result.daily).toHaveLength(2);
      const day9 = result.daily.find((row) => row.day === "2026-07-09");
      expect(day9?.model).toBe("grok-4.5");
      expect(day9?.inputTokens).toBe(200);
      expect(day9?.cachedInputTokens).toBe(800);
      expect(day9?.outputTokens).toBe(70);
      expect(day9?.totalTokens).toBe(1_070);
      expect(day9?.estimatedCostUsd).toBeGreaterThan(0);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("parses Cursor usage CSV export into daily model rows", () => {
    const csv = [
      "Date,Model,Input (w/o Cache Write),Input (w/ Cache Write),Cache Read,Output Tokens",
      "2026-07-09 12:00:00,claude-sonnet-4-6,1000,1200,500,200",
      "2026-07-09 13:00:00,claude-sonnet-4-6,500,500,100,50",
    ].join("\n");

    const parsed = parseCursorUsageCsv(csv, { fromDay: "2026-07-01", toDay: "2026-07-10" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.daily).toHaveLength(1);
    expect(parsed.daily[0]?.day).toBe("2026-07-09");
    expect(parsed.daily[0]?.model).toBe("claude-sonnet-4-6");
    expect(parsed.daily[0]?.inputTokens).toBe(1_500);
    expect(parsed.daily[0]?.cacheWriteTokens).toBe(200);
    expect(parsed.daily[0]?.cachedInputTokens).toBe(600);
    expect(parsed.daily[0]?.outputTokens).toBe(250);
  });
});
