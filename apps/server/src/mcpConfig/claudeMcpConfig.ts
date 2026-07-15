// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Reader for the user's *configured* MCP servers.
 *
 * NOTE: this is unrelated to `apps/server/src/mcp/`, which is t3code acting as
 * an MCP *server* (the preview-automation broker it injects into agents).
 * This module is about the MCP servers the user connects Claude to.
 *
 * Source of truth is `<homePath>/.claude.json`:
 *
 *   { "mcpServers": { … },                      // user scope (all projects)
 *     "projects": { "<abs path>": { "mcpServers": { … } } } }  // project scope
 *
 * Writes are NOT done here — they go through the `claude mcp` CLI (see
 * `claudeMcpCli.ts`) so Claude Code owns the file format and we can never
 * corrupt a config we don't own.
 */

export type McpTransport = "stdio" | "http" | "sse";
export type McpScope = "user" | "project";

/**
 * A configured server, with all secret material already redacted.
 *
 * Header and env *values* are deliberately dropped server-side rather than
 * redacted in the UI: `.claude.json` routinely holds bearer tokens in
 * `headers.Authorization`, and they have no business crossing the wire to a
 * browser. Only the key names survive, so the UI can still show that a server
 * carries auth without leaking what it is.
 */
export type McpServerRow = {
  readonly name: string;
  readonly transport: McpTransport;
  readonly scope: McpScope;
  /** Absolute project path when `scope === "project"`. */
  readonly projectPath?: string;
  /** `http`/`sse` only. */
  readonly url?: string;
  /** `stdio` only. */
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  /** Names only — values are never sent. */
  readonly envKeys?: ReadonlyArray<string>;
  /** Names only — values are never sent. */
  readonly headerKeys?: ReadonlyArray<string>;
};

export type McpConfigResult = {
  readonly status: "ok" | "missing" | "error";
  readonly error?: string;
  readonly servers: ReadonlyArray<McpServerRow>;
  readonly sourcePath: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function readKeyNames(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const nested = asRecord(record[key]);
  return nested === null ? [] : Object.keys(nested);
}

/**
 * Infer the transport. `type` is authoritative when present; otherwise fall
 * back to shape (a `command` means stdio, a `url` means http). Older configs
 * written before `type` existed omit it.
 */
function resolveTransport(entry: Record<string, unknown>): McpTransport {
  const declared = readTrimmedString(entry, "type");
  if (declared === "stdio" || declared === "http" || declared === "sse") {
    return declared;
  }
  if (readTrimmedString(entry, "command") !== undefined) return "stdio";
  return "http";
}

export function parseMcpServerEntry(input: {
  readonly name: string;
  readonly entry: unknown;
  readonly scope: McpScope;
  readonly projectPath?: string;
}): McpServerRow | null {
  const entry = asRecord(input.entry);
  if (entry === null) return null;

  const transport = resolveTransport(entry);

  const row: {
    name: string;
    transport: McpTransport;
    scope: McpScope;
    projectPath?: string;
    url?: string;
    command?: string;
    args?: ReadonlyArray<string>;
    envKeys?: ReadonlyArray<string>;
    headerKeys?: ReadonlyArray<string>;
  } = {
    name: input.name,
    transport,
    scope: input.scope,
  };

  if (input.projectPath !== undefined) row.projectPath = input.projectPath;

  if (transport === "stdio") {
    const command = readTrimmedString(entry, "command");
    if (command !== undefined) row.command = command;
    const args = readStringArray(entry, "args");
    if (args.length > 0) row.args = args;
  } else {
    const url = readTrimmedString(entry, "url");
    if (url !== undefined) row.url = url;
  }

  const envKeys = readKeyNames(entry, "env");
  if (envKeys.length > 0) row.envKeys = envKeys;

  const headerKeys = readKeyNames(entry, "headers");
  if (headerKeys.length > 0) row.headerKeys = headerKeys;

  return row;
}

function collectServers(input: {
  readonly source: unknown;
  readonly scope: McpScope;
  readonly projectPath?: string;
  readonly out: Array<McpServerRow>;
}): void {
  const servers = asRecord(input.source);
  if (servers === null) return;

  for (const [name, entry] of Object.entries(servers)) {
    const row = parseMcpServerEntry({
      name,
      entry,
      scope: input.scope,
      ...(input.projectPath !== undefined ? { projectPath: input.projectPath } : {}),
    });
    if (row !== null) input.out.push(row);
  }
}

/**
 * Parse a `.claude.json` document into rows. Exported for tests so the parsing
 * can be exercised without touching the real filesystem.
 */
export function parseMcpConfigDocument(document: unknown): ReadonlyArray<McpServerRow> {
  const root = asRecord(document);
  if (root === null) return [];

  const servers: Array<McpServerRow> = [];

  collectServers({ source: root["mcpServers"], scope: "user", out: servers });

  const projects = asRecord(root["projects"]);
  if (projects !== null) {
    for (const [projectPath, projectValue] of Object.entries(projects)) {
      const project = asRecord(projectValue);
      if (project === null) continue;
      collectServers({
        source: project["mcpServers"],
        scope: "project",
        projectPath,
        out: servers,
      });
    }
  }

  servers.sort(
    (left, right) => left.scope.localeCompare(right.scope) || left.name.localeCompare(right.name),
  );
  return servers;
}

/** Path of the config for the instance rooted at `homePath`. */
export function claudeConfigPath(homePath: string): string {
  return NodePath.join(homePath, ".claude.json");
}

/**
 * Read the MCP servers configured for the instance rooted at `homePath`.
 *
 * `homePath` is the instance HOME (what `resolveClaudeHomePath` returns) — the
 * per-instance `homePath` setting exists precisely to keep `.claude.json`
 * separate between instances, so resolving from `os.homedir()` here would read
 * the wrong file.
 */
export function readClaudeMcpConfig(homePath: string): McpConfigResult {
  const sourcePath = claudeConfigPath(homePath);

  if (!NodeFS.existsSync(sourcePath)) {
    return { status: "missing", servers: [], sourcePath };
  }

  let document: unknown;
  try {
    document = JSON.parse(NodeFS.readFileSync(sourcePath, "utf8"));
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      servers: [],
      sourcePath,
    };
  }

  return { status: "ok", servers: parseMcpConfigDocument(document), sourcePath };
}
