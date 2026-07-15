import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Contracts for the Skills and MCP settings screens.
 *
 * Both are machine-scoped, read-mostly views of the agent CLIs' own on-disk
 * config, surfaced so the user can see what is installed without leaving the
 * app.
 */

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a skill came from.
 *
 *  - `personal` — installed by the user (`~/.claude/skills`)
 *  - `plugin`   — shipped by an installed plugin
 *  - `project`  — scoped to a repo
 *  - `system`   — built into the agent
 */
export const SkillScope = Schema.Literals(["personal", "plugin", "project", "system"]);
export type SkillScope = typeof SkillScope.Type;

export const SkillEntry = Schema.Struct({
  /**
   * Stable identity. Deliberately NOT the name: skill names collide in
   * practice (an install can carry three distinct `access` skills from
   * different plugins), so the absolute SKILL.md path is the only safe key.
   */
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  scope: SkillScope,
  /** Owning plugin, when `scope === "plugin"`. */
  pluginName: Schema.optional(TrimmedNonEmptyString),
  /** Driver that reported the skill, e.g. `claude` / `codex`. */
  provider: TrimmedNonEmptyString,
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillsListStatus = Schema.Literals(["ok", "missing", "error"]);
export type SkillsListStatus = typeof SkillsListStatus.Type;

export const SkillsListOutput = Schema.Struct({
  status: SkillsListStatus,
  skills: Schema.Array(SkillEntry),
  /** Directory scanned, shown in the UI so the user knows what was read. */
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type SkillsListOutput = typeof SkillsListOutput.Type;

export const SkillsReadInput = Schema.Struct({
  /** Absolute SKILL.md path, as returned by `skills.list`. */
  path: TrimmedNonEmptyString,
});
export type SkillsReadInput = typeof SkillsReadInput.Type;

export const SkillsReadOutput = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Full SKILL.md source, frontmatter included. */
  content: Schema.String,
});
export type SkillsReadOutput = typeof SkillsReadOutput.Type;

export const SkillsDeleteInput = Schema.Struct({
  /**
   * Absolute SKILL.md path, as returned by `skills.list`. The server deletes
   * the containing directory, and only ever for `personal` skills — plugin
   * skills are owned by the plugin manager and must be removed by uninstalling
   * the plugin.
   */
  path: TrimmedNonEmptyString,
});
export type SkillsDeleteInput = typeof SkillsDeleteInput.Type;

export const SkillsDeleteOutput = Schema.Struct({
  ok: Schema.Boolean,
});
export type SkillsDeleteOutput = typeof SkillsDeleteOutput.Type;

export class SkillsError extends Schema.TaggedErrorClass<SkillsError>()("SkillsError", {
  message: Schema.String,
}) {}

/* -------------------------------------------------------------------------- */
/* MCP                                                                         */
/* -------------------------------------------------------------------------- */

export const McpTransport = Schema.Literals(["stdio", "http", "sse"]);
export type McpTransport = typeof McpTransport.Type;

/**
 * Config scope. Mirrors the `claude mcp --scope` flag.
 *
 *  - `user`    — available in every project
 *  - `project` — bound to one repo (`.claude.json` `projects` map)
 *  - `local`   — CLI-only scope, accepted on write
 */
export const McpScope = Schema.Literals(["user", "project", "local"]);
export type McpScope = typeof McpScope.Type;

export const McpHealth = Schema.Literals([
  "connected",
  "needs_auth",
  "failed",
  "pending",
  "unknown",
]);
export type McpHealth = typeof McpHealth.Type;

export const McpServerEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: McpTransport,
  scope: McpScope,
  /** Absolute project path when `scope === "project"`. */
  projectPath: Schema.optional(TrimmedNonEmptyString),
  /** `http`/`sse` only. */
  url: Schema.optional(TrimmedNonEmptyString),
  /** `stdio` only. */
  command: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Key NAMES only. Values are dropped server-side and never cross the wire:
   * `.claude.json` routinely stores bearer tokens in `headers.Authorization`.
   */
  envKeys: Schema.optional(Schema.Array(Schema.String)),
  headerKeys: Schema.optional(Schema.Array(Schema.String)),
  /** Live health from `claude mcp list`; absent when the CLI is unavailable. */
  health: Schema.optional(McpHealth),
  healthDetail: Schema.optional(TrimmedNonEmptyString),
});
export type McpServerEntry = typeof McpServerEntry.Type;

export const McpListStatus = Schema.Literals(["ok", "missing", "error"]);
export type McpListStatus = typeof McpListStatus.Type;

export const McpListOutput = Schema.Struct({
  status: McpListStatus,
  servers: Schema.Array(McpServerEntry),
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
  /**
   * False when the `claude` CLI could not be run, so the UI can explain why
   * health is blank and why add/remove are disabled.
   */
  cliAvailable: Schema.Boolean,
});
export type McpListOutput = typeof McpListOutput.Type;

export const McpAddInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  transport: McpTransport,
  scope: McpScope,
  /** URL for `http`/`sse`; executable for `stdio`. */
  target: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
  /** `KEY=value` pairs, stdio only. */
  env: Schema.optional(Schema.Array(Schema.String)),
  /** `Name: value` pairs, http/sse only. */
  headers: Schema.optional(Schema.Array(Schema.String)),
});
export type McpAddInput = typeof McpAddInput.Type;

export const McpRemoveInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  scope: Schema.optional(McpScope),
});
export type McpRemoveInput = typeof McpRemoveInput.Type;

export const McpMutationOutput = Schema.Struct({
  ok: Schema.Boolean,
});
export type McpMutationOutput = typeof McpMutationOutput.Type;

export class McpConfigError extends Schema.TaggedErrorClass<McpConfigError>()("McpConfigError", {
  message: Schema.String,
}) {}
