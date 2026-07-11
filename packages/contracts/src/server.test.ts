import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider, ServerUpstreamSyncState } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerUpstreamSyncState = Schema.decodeUnknownSync(ServerUpstreamSyncState);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
    expect(parsed.usage).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional usage snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "claude",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-07-10T00:00:00.000Z",
      models: [],
      usage: {
        status: "ok",
        planLabel: "Max",
        windows: [
          {
            id: "five_hour",
            label: "5-hour",
            usedPercent: 23,
            windowMinutes: 300,
            resetsAt: 1_783_684_811_000,
          },
        ],
        updatedAt: "2026-07-10T00:00:00.000Z",
        source: "oauth",
      },
    });

    expect(parsed.usage?.status).toBe("ok");
    expect(parsed.usage?.windows[0]?.usedPercent).toBe(23);
  });
});

describe("ServerUpstreamSyncState", () => {
  it("decodes a behind-upstream install sync snapshot", () => {
    const parsed = decodeServerUpstreamSyncState({
      status: "behind",
      checkedAt: "2026-07-11T00:00:00.000Z",
      behindBy: 4,
      aheadBy: 0,
      installRoot: "/Users/travis/GitRepos/t3code",
      upstreamRemote: "upstream",
      upstreamUrl: "git@github.com:pingdotgg/t3code.git",
      upstreamRef: "upstream/main",
      localSha: "abc123",
      upstreamSha: "def456",
      suggestedCommand: "git fetch upstream && git merge upstream/main",
      message: "4 commits available from upstream/main.",
    });

    expect(parsed.status).toBe("behind");
    expect(parsed.behindBy).toBe(4);
    expect(parsed.suggestedCommand).toContain("git merge upstream/main");
  });
});
