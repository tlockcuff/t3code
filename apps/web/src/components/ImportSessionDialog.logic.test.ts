import type { ImportableSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSessionSubtitle,
  formatWorkspaceLabel,
  groupImportableSessions,
  listSessionProviders,
  listSessionWorkspaces,
} from "./ImportSessionDialog.logic.ts";

const session = (
  overrides: Partial<ImportableSession> & Pick<ImportableSession, "provider" | "sessionId">,
): ImportableSession => ({
  filePath: `/tmp/${overrides.sessionId}.jsonl`,
  cwd: "/repo",
  branch: null,
  title: "A session",
  startedAt: null,
  updatedAt: null,
  messageCount: 2,
  ...overrides,
});

describe("groupImportableSessions", () => {
  it("groups by provider and then by workspace", () => {
    const groups = groupImportableSessions([
      session({ provider: "claude", sessionId: "a", cwd: "/one" }),
      session({ provider: "claude", sessionId: "b", cwd: "/one" }),
      session({ provider: "claude", sessionId: "c", cwd: "/two" }),
      session({ provider: "codex", sessionId: "d", cwd: "/one" }),
    ]);

    expect(groups.map((group) => group.provider)).toEqual(["claude", "codex"]);
    const claude = groups[0]!;
    expect(claude.sessionCount).toBe(3);
    expect(claude.workspaces.map((workspace) => workspace.cwd)).toEqual(["/one", "/two"]);
    expect(claude.workspaces[0]?.sessions).toHaveLength(2);
  });

  it("sorts the active project's workspace first", () => {
    const groups = groupImportableSessions(
      [
        session({ provider: "claude", sessionId: "a", cwd: "/aaa" }),
        session({ provider: "claude", sessionId: "b", cwd: "/zzz" }),
      ],
      { preferredCwd: "/zzz" },
    );

    expect(groups[0]?.workspaces.map((workspace) => workspace.cwd)).toEqual(["/zzz", "/aaa"]);
  });

  it("filters on title and workspace, case-insensitively", () => {
    const sessions = [
      session({ provider: "claude", sessionId: "a", title: "Fix the login bug", cwd: "/one" }),
      session({ provider: "claude", sessionId: "b", title: "Add dark mode", cwd: "/two" }),
    ];

    expect(groupImportableSessions(sessions, { query: "LOGIN" })[0]?.sessionCount).toBe(1);
    expect(groupImportableSessions(sessions, { query: "/two" })[0]?.sessionCount).toBe(1);
    expect(groupImportableSessions(sessions, { query: "nothing" })).toEqual([]);
  });

  it("buckets sessions with no recorded workspace", () => {
    const groups = groupImportableSessions([
      session({ provider: "codex", sessionId: "a", cwd: null }),
    ]);

    expect(groups[0]?.workspaces[0]?.cwd).toBe("Unknown workspace");
  });
});

describe("provider and workspace filters", () => {
  const sessions = [
    session({ provider: "claude", sessionId: "a", cwd: "/one" }),
    session({ provider: "claude", sessionId: "b", cwd: "/one" }),
    session({ provider: "claude", sessionId: "c", cwd: "/two" }),
    session({ provider: "codex", sessionId: "d", cwd: "/three" }),
  ];

  it("lists the providers present in the session list", () => {
    expect(listSessionProviders(sessions)).toEqual(["claude", "codex"]);
  });

  it("lists workspaces for the chosen provider, busiest first", () => {
    expect(listSessionWorkspaces(sessions, "claude")).toEqual([
      { cwd: "/one", count: 2 },
      { cwd: "/two", count: 1 },
    ]);
    expect(listSessionWorkspaces(sessions, "codex")).toEqual([{ cwd: "/three", count: 1 }]);
  });

  it("lists every workspace when no provider is chosen", () => {
    expect(listSessionWorkspaces(sessions, null).map((entry) => entry.cwd)).toEqual([
      "/one",
      "/three",
      "/two",
    ]);
  });

  it("narrows the grouped list by provider", () => {
    const groups = groupImportableSessions(sessions, { provider: "codex" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.provider).toBe("codex");
    expect(groups[0]?.sessionCount).toBe(1);
  });

  it("narrows the grouped list by workspace", () => {
    const groups = groupImportableSessions(sessions, { provider: "claude", cwd: "/two" });
    expect(groups[0]?.sessionCount).toBe(1);
    expect(groups[0]?.workspaces.map((workspace) => workspace.cwd)).toEqual(["/two"]);
  });

  it("combines the dropdown filters with the text query", () => {
    const groups = groupImportableSessions(
      [
        session({ provider: "claude", sessionId: "a", cwd: "/one", title: "Fix login" }),
        session({ provider: "claude", sessionId: "b", cwd: "/one", title: "Add dark mode" }),
      ],
      { provider: "claude", cwd: "/one", query: "login" },
    );

    expect(groups[0]?.sessionCount).toBe(1);
  });
});

describe("formatWorkspaceLabel", () => {
  it("keeps short paths intact and shortens deep ones", () => {
    expect(formatWorkspaceLabel("/Users/travis")).toBe("/Users/travis");
    expect(formatWorkspaceLabel("/Users/travis/GitRepos/t3code")).toBe("…/GitRepos/t3code");
  });
});

describe("formatSessionSubtitle", () => {
  it("pluralizes and appends the date when present", () => {
    expect(
      formatSessionSubtitle(session({ provider: "claude", sessionId: "a", messageCount: 1 })),
    ).toBe("1 message");
    expect(
      formatSessionSubtitle(
        session({
          provider: "claude",
          sessionId: "a",
          messageCount: 12,
          updatedAt: "2026-07-01T10:00:00.000Z",
        }),
      ),
    ).toBe("12 messages · 2026-07-01");
  });
});
