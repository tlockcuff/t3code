// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parse as parseYaml } from "yaml";

/**
 * Discovery of Claude Agent Skills on the local machine.
 *
 * Claude has no equivalent of Codex's `skills/list` RPC, so skills are
 * read straight off disk. Two trees are scanned:
 *
 *  - `<claudeDir>/skills/<name>/SKILL.md`         — user-installed ("personal")
 *  - `<claudeDir>/plugins/**\/skills/<name>/SKILL.md` — shipped by a plugin
 *
 * `claudeDir` is derived from the *instance's* HOME (see
 * `resolveClaudeHomePath`), never `os.homedir()` directly: `homePath` is a
 * per-instance setting whose whole purpose is keeping `.claude` separate
 * between instances.
 */

export type ClaudeSkillScope = "personal" | "plugin";

export type ClaudeSkillRow = {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly path: string;
  readonly scope: ClaudeSkillScope;
  /** Owning plugin directory name, when `scope === "plugin"`. */
  readonly pluginName?: string;
};

export type ClaudeSkillsResult = {
  readonly status: "ok" | "missing" | "error";
  readonly error?: string;
  readonly skills: ReadonlyArray<ClaudeSkillRow>;
  readonly sourcePath: string;
};

/** Guard against a pathological plugins tree; real installs are far smaller. */
const MAX_SKILLS = 2_000;
const MAX_FRONTMATTER_BYTES = 16_384;

/**
 * Split a leading `---` fenced YAML frontmatter block off a SKILL.md.
 *
 * The repo has no frontmatter parser (no gray-matter), only the raw `yaml`
 * package, so the fence is split by hand. Returns the raw YAML text and the
 * remaining markdown body. A file with no frontmatter yields `null` YAML and
 * the whole file as the body.
 */
export function splitFrontmatter(source: string): {
  readonly yaml: string | null;
  readonly body: string;
} {
  // Tolerate a BOM and CRLF line endings.
  const text = source.replace(/^﻿/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { yaml: null, body: text };
  }
  return { yaml: match[1] ?? "", body: text.slice(match[0].length) };
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse a SKILL.md into a row. Frontmatter is advisory: a skill whose
 * frontmatter is missing or malformed still exists on disk and is still
 * loadable by Claude, so it is reported using its directory name rather
 * than dropped.
 */
export function parseSkillMarkdown(input: {
  readonly source: string;
  readonly path: string;
  readonly directoryName: string;
  readonly scope: ClaudeSkillScope;
  readonly pluginName?: string;
}): ClaudeSkillRow {
  const { yaml } = splitFrontmatter(input.source);

  let frontmatter: Record<string, unknown> = {};
  if (yaml !== null && yaml.length > 0) {
    try {
      const parsed: unknown = parseYaml(yaml);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed YAML — fall through to directory-name defaults.
    }
  }

  const row: {
    name: string;
    displayName?: string;
    description?: string;
    path: string;
    scope: ClaudeSkillScope;
    pluginName?: string;
  } = {
    name: readString(frontmatter, "name") ?? input.directoryName,
    path: input.path,
    scope: input.scope,
  };

  const description = readString(frontmatter, "description");
  if (description !== undefined) row.description = description;

  // Some skills carry a human title; fall back to nothing (the web layer
  // already title-cases the slug in `formatProviderSkillDisplayName`).
  const displayName = readString(frontmatter, "displayName") ?? readString(frontmatter, "title");
  if (displayName !== undefined) row.displayName = displayName;

  if (input.pluginName !== undefined) row.pluginName = input.pluginName;

  return row;
}

function readSkillDirectory(input: {
  readonly skillsDir: string;
  readonly scope: ClaudeSkillScope;
  readonly pluginName?: string;
  readonly out: Array<ClaudeSkillRow>;
}): void {
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(input.skillsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (input.out.length >= MAX_SKILLS) return;
    if (!entry.isDirectory()) continue;

    const skillPath = NodePath.join(input.skillsDir, entry.name, "SKILL.md");
    let source: string;
    try {
      source = NodeFS.readFileSync(skillPath, "utf8");
    } catch {
      // Not a skill dir (no SKILL.md), or unreadable — skip silently.
      continue;
    }

    const parsed = parseSkillMarkdown({
      source,
      path: skillPath,
      directoryName: entry.name,
      scope: input.scope,
      ...(input.pluginName !== undefined ? { pluginName: input.pluginName } : {}),
    });
    input.out.push(parsed);
  }
}

/**
 * Walk `<claudeDir>/plugins` looking for any nested `skills/` directory.
 *
 * The plugin cache layout is not contractual (it nests by marketplace and
 * plugin), so rather than hard-coding it this does a shallow bounded walk
 * and treats every `skills/` directory it meets as a skill root.
 */
function readPluginSkills(pluginsDir: string, out: Array<ClaudeSkillRow>): void {
  const MAX_DEPTH = 5;

  const walk = (dir: string, depth: number, pluginName: string | undefined): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return;

    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = NodePath.join(dir, entry.name);

      if (entry.name === "skills") {
        readSkillDirectory({
          skillsDir: child,
          scope: "plugin",
          ...(pluginName !== undefined ? { pluginName } : {}),
          out,
        });
        continue;
      }

      // The first directory level under a marketplace is the plugin itself;
      // remember it so rows can be grouped by plugin in the UI.
      walk(child, depth + 1, pluginName ?? (depth >= 1 ? entry.name : undefined));
    }
  };

  walk(pluginsDir, 0, undefined);
}

/**
 * Read every Claude skill visible to the instance rooted at `homePath`.
 *
 * `homePath` is the instance HOME (what `resolveClaudeHomePath` returns), so
 * the Claude directory is `<homePath>/.claude`. `CLAUDE_CONFIG_DIR` overrides
 * it, matching `getClaudeHome()` in `usage/claudeStatsCache.ts`.
 */
export function readClaudeSkills(homePath: string): ClaudeSkillsResult {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(homePath, ".claude");

  if (!NodeFS.existsSync(claudeDir)) {
    return { status: "missing", skills: [], sourcePath: claudeDir };
  }

  const skills: Array<ClaudeSkillRow> = [];
  try {
    readSkillDirectory({
      skillsDir: NodePath.join(claudeDir, "skills"),
      scope: "personal",
      out: skills,
    });
    readPluginSkills(NodePath.join(claudeDir, "plugins"), skills);
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      skills,
      sourcePath: claudeDir,
    };
  }

  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { status: "ok", skills, sourcePath: claudeDir };
}

/**
 * Is `candidate` really inside `root`?
 *
 * Two traps this closes, both of which a naive `resolved.startsWith(root)`
 * falls into:
 *
 *  1. **Sibling prefix.** `/home/u/.claude-evil/x` starts with `/home/u/.claude`
 *     as a *string* but is a different directory. Hence the trailing-separator
 *     comparison.
 *  2. **Symlinks.** A symlink inside the tree can point anywhere, so both sides
 *     are resolved through `realpath` before comparing.
 *
 * `realpathSync` throws on a non-existent path, so the caller must check
 * existence first; a missing file is not "contained".
 */
export function isPathInside(root: string, candidate: string): boolean {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = NodeFS.realpathSync(NodePath.resolve(root));
    realCandidate = NodeFS.realpathSync(NodePath.resolve(candidate));
  } catch {
    return false;
  }
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + NodePath.sep);
}

export type DeleteSkillResult =
  | { readonly ok: true; readonly deletedPath: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Delete a personal skill by removing its directory.
 *
 * There is no `claude skill` CLI to delegate to (unlike MCP), so this is a
 * genuine recursive delete of a user directory — hence the guards. The target
 * must be `<claudeDir>/skills/<name>/SKILL.md`, i.e. a *direct* child of the
 * personal skills root.
 *
 * Plugin skills are deliberately NOT deletable: they live under
 * `<claudeDir>/plugins/` and are owned by the plugin manager, so removing one
 * here would be silently restored on the next sync and would corrupt the
 * plugin's install. Uninstall the plugin instead.
 */
export function deletePersonalSkill(input: {
  readonly homePath: string;
  readonly skillPath: string;
}): DeleteSkillResult {
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(input.homePath, ".claude");
  const skillsRoot = NodePath.resolve(NodePath.join(claudeDir, "skills"));
  const resolved = NodePath.resolve(input.skillPath);

  if (NodePath.basename(resolved) !== "SKILL.md") {
    return { ok: false, reason: "Not a SKILL.md file." };
  }

  if (!NodeFS.existsSync(resolved)) {
    return { ok: false, reason: "Skill no longer exists." };
  }

  // Resolve symlinks before any containment reasoning: a symlinked SKILL.md
  // inside the skills root could otherwise point at an arbitrary directory,
  // which we would then recursively delete.
  let skillDir: string;
  let realSkillsRoot: string;
  try {
    skillDir = NodePath.dirname(NodeFS.realpathSync(resolved));
    realSkillsRoot = NodeFS.realpathSync(skillsRoot);
  } catch {
    return { ok: false, reason: "Skill no longer exists." };
  }

  // The skill directory must be a DIRECT child of the personal skills root.
  // This rejects traversal (`../../..`), symlink escapes, the `.claude-evil`
  // sibling-prefix trick, and every plugin-tree path (those sit under a
  // different parent).
  if (NodePath.dirname(skillDir) !== realSkillsRoot) {
    return {
      ok: false,
      reason:
        "Only personal skills can be deleted. Plugin skills are removed by uninstalling the plugin.",
    };
  }

  try {
    NodeFS.rmSync(skillDir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, deletedPath: skillDir };
}

/** Read one SKILL.md body for the detail view. Path is validated by the caller. */
export function readSkillBody(skillPath: string): string | null {
  try {
    const source = NodeFS.readFileSync(skillPath, "utf8");
    if (source.length > MAX_FRONTMATTER_BYTES * 64) {
      return source.slice(0, MAX_FRONTMATTER_BYTES * 64);
    }
    return source;
  } catch {
    return null;
  }
}
