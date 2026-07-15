import type { McpServerEntry, SkillEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupMcpServers,
  groupSkills,
  mcpServerKey,
  mcpTargetLabel,
  parseKeyValueLines,
  skillMatchesQuery,
  stripFrontmatter,
} from "./SkillsSettings.logic";

const skill = (overrides: Partial<SkillEntry> & Pick<SkillEntry, "name" | "path">): SkillEntry => ({
  scope: "personal",
  provider: "claude",
  ...overrides,
});

const server = (
  overrides: Partial<McpServerEntry> & Pick<McpServerEntry, "name">,
): McpServerEntry => ({
  transport: "http",
  scope: "user",
  ...overrides,
});

describe("groupSkills", () => {
  it("separates each plugin into its own group and puts personal first", () => {
    const groups = groupSkills([
      skill({ name: "b-plugin-skill", path: "/p/b", scope: "plugin", pluginName: "stripe" }),
      skill({ name: "a-personal", path: "/p/a", scope: "personal" }),
      skill({ name: "c-plugin-skill", path: "/p/c", scope: "plugin", pluginName: "context7" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Personal", "context7", "stripe"]);
  });

  it("keeps same-named skills from different plugins distinct", () => {
    // Real case: three `access` skills ship across the official plugins.
    const groups = groupSkills([
      skill({
        name: "access",
        path: "/p/discord/SKILL.md",
        scope: "plugin",
        pluginName: "discord",
      }),
      skill({
        name: "access",
        path: "/p/telegram/SKILL.md",
        scope: "plugin",
        pluginName: "telegram",
      }),
    ]);

    expect(groups).toHaveLength(2);
    // Keying on path, not name, is what keeps these from colliding.
    expect(groups.flatMap((group) => group.skills.map((entry) => entry.path))).toEqual([
      "/p/discord/SKILL.md",
      "/p/telegram/SKILL.md",
    ]);
  });
});

describe("skillMatchesQuery", () => {
  const target = skill({
    name: "visual-plan",
    path: "/p/visual-plan",
    description: "Turn plans into diagrams",
  });

  it("matches on name and on description", () => {
    expect(skillMatchesQuery(target, "visual")).toBe(true);
    expect(skillMatchesQuery(target, "diagrams")).toBe(true);
  });

  it("matches everything on an empty query and nothing on a miss", () => {
    expect(skillMatchesQuery(target, "  ")).toBe(true);
    expect(skillMatchesQuery(target, "kubernetes")).toBe(false);
  });
});

describe("stripFrontmatter", () => {
  it("removes the fenced block so it isn't shown twice", () => {
    expect(stripFrontmatter("---\nname: x\n---\n# Title").trim()).toBe("# Title");
  });

  it("leaves a body with no frontmatter untouched", () => {
    expect(stripFrontmatter("# Title")).toBe("# Title");
  });
});

describe("mcpServerKey", () => {
  it("disambiguates the same server name across two projects", () => {
    const left = server({ name: "linear-server", scope: "project", projectPath: "/a" });
    const right = server({ name: "linear-server", scope: "project", projectPath: "/b" });

    expect(mcpServerKey(left)).not.toBe(mcpServerKey(right));
  });
});

describe("groupMcpServers", () => {
  it("puts user scope first, then one group per project", () => {
    const groups = groupMcpServers([
      server({ name: "convex", scope: "project", projectPath: "/repo" }),
      server({ name: "posthog", scope: "user" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual(["All projects", "/repo"]);
  });
});

describe("mcpTargetLabel", () => {
  it("joins a stdio command with its args", () => {
    expect(
      mcpTargetLabel(
        server({ name: "convex", transport: "stdio", command: "npx", args: ["convex", "mcp"] }),
      ),
    ).toBe("npx convex mcp");
  });

  it("uses the url for http", () => {
    expect(mcpTargetLabel(server({ name: "posthog", url: "https://mcp.posthog.com/mcp" }))).toBe(
      "https://mcp.posthog.com/mcp",
    );
  });
});

describe("parseKeyValueLines", () => {
  it("parses env pairs and drops blank lines", () => {
    expect(parseKeyValueLines("API_KEY=xxx\n\nREGION=us-east-1\n", "=")).toEqual([
      "API_KEY=xxx",
      "REGION=us-east-1",
    ]);
  });

  it("parses a header whose value itself contains the separator", () => {
    expect(parseKeyValueLines("Authorization: Bearer a:b:c", ": ")).toEqual([
      "Authorization: Bearer a:b:c",
    ]);
  });

  it("ignores lines with no separator", () => {
    expect(parseKeyValueLines("garbage", "=")).toEqual([]);
  });
});
