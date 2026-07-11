import { describe, expect, it } from "vite-plus/test";
import type { ServerUpstreamSyncState } from "@t3tools/contracts";

import {
  formatUpstreamSyncBadgeDescription,
  formatUpstreamSyncBadgeTitle,
  formatUpstreamSyncSettingsDescription,
  shouldShowUpstreamSyncBadge,
} from "./SidebarUpstreamSync.logic.ts";

const behind: ServerUpstreamSyncState = {
  status: "behind",
  checkedAt: "2026-07-11T00:00:00.000Z",
  behindBy: 2,
  aheadBy: 0,
  installRoot: "/repo",
  upstreamRemote: "upstream",
  upstreamUrl: "git@github.com:pingdotgg/t3code.git",
  upstreamRef: "upstream/main",
  localSha: "abc",
  upstreamSha: "def",
  suggestedCommand: "git fetch upstream && git merge upstream/main",
  message: "2 commits available from upstream/main.",
};

describe("SidebarUpstreamSync.logic", () => {
  it("shows a badge only when behind or diverged", () => {
    expect(shouldShowUpstreamSyncBadge(behind)).toBe(true);
    expect(shouldShowUpstreamSyncBadge({ ...behind, status: "diverged", aheadBy: 1 })).toBe(true);
    expect(shouldShowUpstreamSyncBadge({ ...behind, status: "current", behindBy: 0 })).toBe(false);
    expect(shouldShowUpstreamSyncBadge(null)).toBe(false);
  });

  it("formats badge and settings copy", () => {
    expect(formatUpstreamSyncBadgeTitle(behind)).toBe("2 upstream commits");
    expect(formatUpstreamSyncBadgeDescription(behind)).toContain("git fetch upstream");
    expect(formatUpstreamSyncSettingsDescription(behind)).toContain("2 commits");
    expect(formatUpstreamSyncSettingsDescription(undefined)).toContain("upstream remote");
  });
});
