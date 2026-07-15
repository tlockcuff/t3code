// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  deletePersonalSkill,
  isPathInside,
  parseSkillMarkdown,
  splitFrontmatter,
} from "./claudeSkills.ts";

describe("splitFrontmatter", () => {
  it("splits a fenced yaml block from the markdown body", () => {
    const { yaml, body } = splitFrontmatter(
      [
        "---",
        "name: visual-plan",
        "description: Turn plans into diagrams",
        "---",
        "",
        "# Body",
      ].join("\n"),
    );

    expect(yaml).toBe("name: visual-plan\ndescription: Turn plans into diagrams");
    expect(body.trim()).toBe("# Body");
  });

  it("handles CRLF line endings", () => {
    const { yaml } = splitFrontmatter("---\r\nname: crlf-skill\r\n---\r\n# Body");
    expect(yaml).toBe("name: crlf-skill");
  });

  it("returns the whole file as body when there is no frontmatter", () => {
    const { yaml, body } = splitFrontmatter("# Just markdown");
    expect(yaml).toBeNull();
    expect(body).toBe("# Just markdown");
  });
});

describe("parseSkillMarkdown", () => {
  it("reads name and a folded multi-line description", () => {
    const row = parseSkillMarkdown({
      // The real visual-plan skill uses a folded `>-` scalar.
      source: [
        "---",
        "name: visual-plan",
        "description: >-",
        "  Turn ordinary text plans into rich interactive visual plans",
        "  with diagrams and file maps.",
        "metadata:",
        "  visibility: exported",
        "---",
        "# Visual Plan",
      ].join("\n"),
      path: "/home/u/.claude/skills/visual-plan/SKILL.md",
      directoryName: "visual-plan",
      scope: "personal",
    });

    expect(row.name).toBe("visual-plan");
    expect(row.description).toBe(
      "Turn ordinary text plans into rich interactive visual plans with diagrams and file maps.",
    );
    expect(row.scope).toBe("personal");
  });

  it("falls back to the directory name when frontmatter is malformed", () => {
    const row = parseSkillMarkdown({
      source: ["---", "name: [unclosed", "---", "# Body"].join("\n"),
      path: "/home/u/.claude/skills/broken/SKILL.md",
      directoryName: "broken",
      scope: "personal",
    });

    // A skill with bad frontmatter still exists on disk — report it, don't drop it.
    expect(row.name).toBe("broken");
    expect(row.description).toBeUndefined();
  });

  it("falls back to the directory name when frontmatter is absent entirely", () => {
    const row = parseSkillMarkdown({
      source: "# No frontmatter here",
      path: "/home/u/.claude/skills/bare/SKILL.md",
      directoryName: "bare",
      scope: "personal",
    });

    expect(row.name).toBe("bare");
  });

  it("records the owning plugin for plugin-scoped skills", () => {
    const row = parseSkillMarkdown({
      source: ["---", "name: explain-error", "---", "body"].join("\n"),
      path: "/home/u/.claude/plugins/cache/stripe/skills/explain-error/SKILL.md",
      directoryName: "explain-error",
      scope: "plugin",
      pluginName: "stripe",
    });

    expect(row.scope).toBe("plugin");
    expect(row.pluginName).toBe("stripe");
  });
});

describe("deletePersonalSkill", () => {
  // A real temp HOME, because this function actually removes directories and
  // the guards are the whole point of the test.
  let homePath: string;

  const skillsRoot = () => NodePath.join(homePath, ".claude", "skills");

  const writeSkill = (name: string, root = skillsRoot()): string => {
    const dir = NodePath.join(root, name);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "SKILL.md"), "---\nname: x\n---\nbody");
    return NodePath.join(dir, "SKILL.md");
  };

  beforeEach(() => {
    homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skills-"));
  });

  afterEach(() => {
    NodeFS.rmSync(homePath, { recursive: true, force: true });
  });

  it("removes the whole skill directory, not just SKILL.md", () => {
    const skillPath = writeSkill("doomed");
    const skillDir = NodePath.dirname(skillPath);
    // Skills carry sibling files (README.md, agents/) — all must go.
    NodeFS.writeFileSync(NodePath.join(skillDir, "README.md"), "readme");

    const result = deletePersonalSkill({ homePath, skillPath });

    expect(result.ok).toBe(true);
    expect(NodeFS.existsSync(skillDir)).toBe(false);
  });

  it("refuses to delete a plugin skill", () => {
    const pluginSkill = writeSkill(
      "access",
      NodePath.join(homePath, ".claude", "plugins", "cache", "discord", "skills"),
    );

    const result = deletePersonalSkill({ homePath, skillPath: pluginSkill });

    expect(result.ok).toBe(false);
    // The plugin's files must survive — the plugin manager owns them.
    expect(NodeFS.existsSync(pluginSkill)).toBe(true);
  });

  it("refuses a traversal path that escapes the skills root", () => {
    const outside = NodePath.join(homePath, "secrets");
    NodeFS.mkdirSync(outside, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(outside, "SKILL.md"), "not a skill");

    const result = deletePersonalSkill({
      homePath,
      skillPath: NodePath.join(skillsRoot(), "..", "..", "secrets", "SKILL.md"),
    });

    expect(result.ok).toBe(false);
    expect(NodeFS.existsSync(outside)).toBe(true);
  });

  it("refuses a path that is not a SKILL.md", () => {
    writeSkill("real");
    const result = deletePersonalSkill({
      homePath,
      skillPath: NodePath.join(skillsRoot(), "real", "README.md"),
    });

    expect(result.ok).toBe(false);
  });

  it("reports a missing skill instead of throwing", () => {
    const result = deletePersonalSkill({
      homePath,
      skillPath: NodePath.join(skillsRoot(), "ghost", "SKILL.md"),
    });

    expect(result.ok).toBe(false);
  });
});

describe("isPathInside (traversal guard)", () => {
  let root: string;

  beforeEach(() => {
    root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-inside-"));
  });

  afterEach(() => {
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("rejects a sibling directory that merely shares a string prefix", () => {
    // Regression: a bare `resolved.startsWith(claudeDir)` accepts
    // `/home/u/.claude-evil` because it string-prefixes `/home/u/.claude`.
    const claude = NodePath.join(root, ".claude");
    const evil = NodePath.join(root, ".claude-evil");
    NodeFS.mkdirSync(claude, { recursive: true });
    NodeFS.mkdirSync(evil, { recursive: true });
    const evilFile = NodePath.join(evil, "SKILL.md");
    NodeFS.writeFileSync(evilFile, "pwned");

    expect(evilFile.startsWith(claude)).toBe(true); // the naive check passes...
    expect(isPathInside(claude, evilFile)).toBe(false); // ...ours does not.
  });

  it("rejects a symlink that escapes the tree", () => {
    const claude = NodePath.join(root, ".claude");
    const secrets = NodePath.join(root, "secrets");
    NodeFS.mkdirSync(claude, { recursive: true });
    NodeFS.mkdirSync(secrets, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(secrets, "SKILL.md"), "id_rsa");

    const link = NodePath.join(claude, "escape");
    NodeFS.symlinkSync(secrets, link);

    expect(isPathInside(claude, NodePath.join(link, "SKILL.md"))).toBe(false);
  });

  it("accepts a genuine file inside the tree", () => {
    const claude = NodePath.join(root, ".claude", "skills", "real");
    NodeFS.mkdirSync(claude, { recursive: true });
    const file = NodePath.join(claude, "SKILL.md");
    NodeFS.writeFileSync(file, "ok");

    expect(isPathInside(NodePath.join(root, ".claude"), file)).toBe(true);
  });

  it("rejects a path that does not exist", () => {
    expect(isPathInside(root, NodePath.join(root, "ghost"))).toBe(false);
  });
});

describe("deletePersonalSkill symlink hardening", () => {
  it("refuses a symlinked skill dir pointing outside the skills root", () => {
    const homePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-symdel-"));
    try {
      const skillsRoot = NodePath.join(homePath, ".claude", "skills");
      NodeFS.mkdirSync(skillsRoot, { recursive: true });

      // A directory we must never recursively delete.
      const precious = NodePath.join(homePath, "precious");
      NodeFS.mkdirSync(precious, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(precious, "SKILL.md"), "do not delete me");

      // ...symlinked into the skills root so it looks like a direct child.
      NodeFS.symlinkSync(precious, NodePath.join(skillsRoot, "trojan"));

      const result = deletePersonalSkill({
        homePath,
        skillPath: NodePath.join(skillsRoot, "trojan", "SKILL.md"),
      });

      expect(result.ok).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(precious, "SKILL.md"))).toBe(true);
    } finally {
      NodeFS.rmSync(homePath, { recursive: true, force: true });
    }
  });
});
