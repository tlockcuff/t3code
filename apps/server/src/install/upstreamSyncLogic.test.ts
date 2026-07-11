import { describe, expect, it } from "vite-plus/test";

import {
  buildSuggestedUpstreamCommand,
  classifyUpstreamDivergence,
  formatUpstreamSyncBadgeDescription,
  formatUpstreamSyncBadgeTitle,
  isCanonicalUpstreamUrl,
  normalizeGitRemoteUrl,
  parseLeftRightCount,
  parseRemoteNames,
  resolveUpstreamBranchFromSymbolicRef,
  resolveUpstreamRemoteName,
  shouldShowUpstreamSyncBadge,
} from "./upstreamSyncLogic.ts";

describe("upstreamSyncLogic", () => {
  it("classifies ahead/behind divergence", () => {
    expect(classifyUpstreamDivergence(0, 0)).toBe("current");
    expect(classifyUpstreamDivergence(0, 3)).toBe("behind");
    expect(classifyUpstreamDivergence(2, 0)).toBe("ahead");
    expect(classifyUpstreamDivergence(1, 4)).toBe("diverged");
  });

  it("parses left-right rev-list counts", () => {
    expect(parseLeftRightCount("2\t5\n")).toEqual({ aheadBy: 2, behindBy: 5 });
    expect(parseLeftRightCount("0 0")).toEqual({ aheadBy: 0, behindBy: 0 });
    expect(parseLeftRightCount("bogus")).toBeNull();
  });

  it("selects the preferred upstream remote name", () => {
    expect(resolveUpstreamRemoteName({ remotes: ["origin", "upstream"] })).toBe("upstream");
    expect(resolveUpstreamRemoteName({ remotes: ["origin"] })).toBeNull();
    expect(
      resolveUpstreamRemoteName({
        remotes: ["origin", "t3-upstream"],
        preferredRemoteName: "t3-upstream",
      }),
    ).toBe("t3-upstream");
  });

  it("parses remote names and symbolic-ref branches", () => {
    expect(parseRemoteNames("origin\nupstream\n")).toEqual(["origin", "upstream"]);
    expect(resolveUpstreamBranchFromSymbolicRef("refs/remotes/upstream/main\n", "upstream")).toBe(
      "main",
    );
    expect(resolveUpstreamBranchFromSymbolicRef("", "upstream")).toBe("main");
  });

  it("normalizes and recognizes canonical upstream URLs", () => {
    expect(normalizeGitRemoteUrl("git@github.com:pingdotgg/t3code.git")).toBe(
      "github.com/pingdotgg/t3code",
    );
    expect(isCanonicalUpstreamUrl("https://github.com/pingdotgg/t3code.git")).toBe(true);
    expect(isCanonicalUpstreamUrl("git@github.com:tlockcuff/t3code.git")).toBe(false);
  });

  it("builds merge guidance and badge copy", () => {
    expect(buildSuggestedUpstreamCommand("upstream", "main")).toBe(
      "git fetch upstream && git merge upstream/main",
    );

    const behind = {
      status: "behind" as const,
      checkedAt: "2026-07-11T00:00:00.000Z",
      behindBy: 3,
      aheadBy: 0,
      installRoot: "/repo",
      upstreamRemote: "upstream",
      upstreamUrl: "git@github.com:pingdotgg/t3code.git",
      upstreamRef: "upstream/main",
      localSha: "abc",
      upstreamSha: "def",
      suggestedCommand: "git fetch upstream && git merge upstream/main",
      message: "3 commits available from upstream/main.",
    };

    expect(shouldShowUpstreamSyncBadge(behind)).toBe(true);
    expect(shouldShowUpstreamSyncBadge({ ...behind, status: "current", behindBy: 0 })).toBe(false);
    expect(formatUpstreamSyncBadgeTitle(behind)).toBe("3 upstream commits");
    expect(formatUpstreamSyncBadgeTitle({ ...behind, behindBy: 1 })).toBe("1 upstream commit");
    expect(formatUpstreamSyncBadgeDescription(behind)).toContain("git fetch upstream");
  });
});
