import type { McpHealth, McpServerEntry, SkillEntry } from "@t3tools/contracts";

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

export type SkillGroup = {
  /** Stable group key: the scope, or `plugin:<name>` for plugin skills. */
  readonly key: string;
  readonly label: string;
  readonly skills: ReadonlyArray<SkillEntry>;
};

export function skillMatchesQuery(skill: SkillEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  return (
    skill.name.toLowerCase().includes(needle) ||
    (skill.displayName?.toLowerCase().includes(needle) ?? false) ||
    (skill.description?.toLowerCase().includes(needle) ?? false) ||
    (skill.pluginName?.toLowerCase().includes(needle) ?? false)
  );
}

const SCOPE_LABEL: Record<SkillEntry["scope"], string> = {
  personal: "Personal",
  plugin: "Plugins",
  project: "Project",
  system: "System",
};

/**
 * Group skills for display: personal first, then one group per plugin, then
 * anything else. Plugins get their own group because a single plugin can ship
 * many skills and lumping them together buries the personal ones.
 */
export function groupSkills(skills: ReadonlyArray<SkillEntry>): ReadonlyArray<SkillGroup> {
  const groups = new Map<string, { label: string; skills: Array<SkillEntry> }>();

  for (const skill of skills) {
    const key =
      skill.scope === "plugin" && skill.pluginName !== undefined
        ? `plugin:${skill.pluginName}`
        : skill.scope;
    const label =
      skill.scope === "plugin" && skill.pluginName !== undefined
        ? skill.pluginName
        : SCOPE_LABEL[skill.scope];

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { label, skills: [skill] });
    } else {
      existing.skills.push(skill);
    }
  }

  const rank = (key: string): number => {
    if (key === "personal") return 0;
    if (key === "project") return 1;
    if (key.startsWith("plugin:")) return 2;
    return 3;
  };

  return [...groups.entries()]
    .map(([key, value]) => ({ key, label: value.label, skills: value.skills }))
    .sort(
      (left, right) => rank(left.key) - rank(right.key) || left.label.localeCompare(right.label),
    );
}

/**
 * Strip YAML frontmatter for the detail view — the fields in it are already
 * rendered as structured UI above the body, so showing the raw block again is
 * noise.
 */
export function stripFrontmatter(source: string): string {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match === null ? source : source.slice(match[0].length);
}

/* -------------------------------------------------------------------------- */
/* MCP                                                                         */
/* -------------------------------------------------------------------------- */

export function mcpMatchesQuery(server: McpServerEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;

  return (
    server.name.toLowerCase().includes(needle) ||
    (server.url?.toLowerCase().includes(needle) ?? false) ||
    (server.command?.toLowerCase().includes(needle) ?? false) ||
    (server.projectPath?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Identity for an MCP row.
 *
 * NOT the name: the same server name legitimately appears more than once
 * across scopes and projects (e.g. a `linear-server` configured in two repos
 * with different transports), so name alone collides as a React key.
 */
export function mcpServerKey(server: McpServerEntry): string {
  return `${server.scope}:${server.projectPath ?? ""}:${server.name}`;
}

export const MCP_HEALTH_LABEL: Record<McpHealth, string> = {
  connected: "Connected",
  needs_auth: "Needs authentication",
  failed: "Failed",
  pending: "Pending approval",
  unknown: "Unknown",
};

/** Human summary of where a server points, for the row subtitle. */
export function mcpTargetLabel(server: McpServerEntry): string {
  if (server.transport === "stdio") {
    const args = server.args ?? [];
    return [server.command ?? "", ...args].join(" ").trim();
  }
  return server.url ?? "";
}

export type McpServerGroup = {
  readonly key: string;
  readonly label: string;
  readonly servers: ReadonlyArray<McpServerEntry>;
};

/**
 * Group by scope: user-scope servers (available everywhere) first, then one
 * group per project.
 */
export function groupMcpServers(
  servers: ReadonlyArray<McpServerEntry>,
): ReadonlyArray<McpServerGroup> {
  const groups = new Map<string, { label: string; servers: Array<McpServerEntry> }>();

  for (const server of servers) {
    const isProject = server.scope === "project" && server.projectPath !== undefined;
    const key = isProject ? `project:${server.projectPath}` : server.scope;
    const label = isProject
      ? (server.projectPath as string)
      : server.scope === "user"
        ? "All projects"
        : "Local";

    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { label, servers: [server] });
    } else {
      existing.servers.push(server);
    }
  }

  const rank = (key: string): number => {
    if (key === "user") return 0;
    if (key === "local") return 1;
    return 2;
  };

  return [...groups.entries()]
    .map(([key, value]) => ({ key, label: value.label, servers: value.servers }))
    .sort(
      (left, right) => rank(left.key) - rank(right.key) || left.label.localeCompare(right.label),
    );
}

/**
 * Turn the form's raw textarea/table input into the `KEY=value` and
 * `Name: value` shapes the `claude mcp` CLI expects. Blank lines are dropped
 * so a trailing newline doesn't produce an empty pair.
 */
export function parseKeyValueLines(raw: string, separator: "=" | ": "): ReadonlyArray<string> {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(separator.trim()))
    .map((line) => {
      const index = line.indexOf(separator.trim());
      const key = line.slice(0, index).trim();
      const value = line.slice(index + separator.trim().length).trim();
      return `${key}${separator}${value}`;
    });
}
