import type {
  McpListOutput,
  McpServerEntry,
  SkillEntry,
  SkillsListOutput,
} from "@t3tools/contracts";
import { McpConfigError, SkillsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ProcessRunner } from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  addMcpServer,
  listMcpHealth,
  removeMcpServer,
  type AddMcpServerInput,
  type McpCliEnv,
} from "../mcpConfig/claudeMcpCli.ts";
import { readClaudeMcpConfig } from "../mcpConfig/claudeMcpConfig.ts";
import {
  deletePersonalSkill,
  isPathInside,
  readClaudeSkills,
  readSkillBody,
} from "./claudeSkills.ts";

/**
 * Backing service for the Skills and MCP settings screens.
 *
 * Both features read the *Claude instance's* config, so every path is resolved
 * through `resolveClaudeHomePath(claudeSettings)` rather than `os.homedir()` —
 * `homePath` is a per-instance setting that exists specifically to keep
 * `.claude` / `.claude.json` separate between instances.
 */
export class SkillsMcpService extends Context.Service<
  SkillsMcpService,
  {
    /** Every Claude skill installed on this machine. */
    readonly listSkills: Effect.Effect<SkillsListOutput, SkillsError>;

    /** Full SKILL.md source for the detail view. */
    readonly readSkill: (path: string) => Effect.Effect<string, SkillsError>;

    /** Delete a personal skill's directory. Plugin skills are rejected. */
    readonly deleteSkill: (path: string) => Effect.Effect<void, SkillsError>;

    /** Configured MCP servers, decorated with live health where available. */
    readonly listMcpServers: Effect.Effect<McpListOutput, McpConfigError>;

    readonly addMcp: (input: AddMcpServerInput) => Effect.Effect<void, McpConfigError>;

    readonly removeMcp: (input: {
      readonly name: string;
      readonly scope?: "local" | "user" | "project";
    }) => Effect.Effect<void, McpConfigError>;
  }
>()("t3/skills/SkillsMcpService") {}

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const processRunner = yield* ProcessRunner;
  const path = yield* Path.Path;

  /** Resolve the Claude instance's HOME + binary from settings. */
  const claudeEnv = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const claudeSettings = settings.providers.claudeAgent;
    const homePath = yield* resolveClaudeHomePath(claudeSettings);
    const binaryPath =
      claudeSettings.binaryPath.trim().length > 0 ? claudeSettings.binaryPath : "claude";
    return { homePath, binaryPath } satisfies McpCliEnv;
  }).pipe(
    Effect.provideService(Path.Path, path),
    Effect.mapError((cause) => new SkillsError({ message: String(cause) })),
  );

  const listSkills = Effect.gen(function* () {
    const env = yield* claudeEnv;
    const result = readClaudeSkills(env.homePath);

    const skills: ReadonlyArray<SkillEntry> = result.skills.map((skill) => ({
      path: skill.path,
      name: skill.name,
      scope: skill.scope,
      provider: "claude",
      ...(skill.displayName !== undefined ? { displayName: skill.displayName } : {}),
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      ...(skill.pluginName !== undefined ? { pluginName: skill.pluginName } : {}),
    }));

    return {
      status: result.status,
      skills,
      sourcePath: result.sourcePath,
      ...(result.error !== undefined ? { error: result.error } : {}),
    } satisfies SkillsListOutput;
  });

  const readSkill = (requestedPath: string) =>
    Effect.gen(function* () {
      const env = yield* claudeEnv;

      // Path-traversal guard. The client echoes back a path we handed it, but
      // that is not a reason to trust it: only files under the instance's
      // Claude directory are readable, so neither a crafted `../../.ssh/id_rsa`
      // nor a `.claude-evil` sibling nor a symlink out of the tree may escape.
      // `isPathInside` realpath-resolves both sides and compares with a
      // trailing separator — a bare `startsWith` would accept `.claude-evil`.
      const claudeDir = path.join(env.homePath, ".claude");
      const resolved = path.resolve(requestedPath);

      if (path.basename(resolved) !== "SKILL.md") {
        return yield* new SkillsError({ message: "Not a SKILL.md file." });
      }
      if (!isPathInside(claudeDir, resolved)) {
        return yield* new SkillsError({
          message: "Skill path is outside the Claude directory.",
        });
      }

      const content = readSkillBody(resolved);
      if (content === null) {
        return yield* new SkillsError({ message: "Skill could not be read." });
      }
      return content;
    });

  const deleteSkill = (requestedPath: string) =>
    Effect.gen(function* () {
      const env = yield* claudeEnv;
      // All path validation lives in `deletePersonalSkill` — it is the single
      // guard for a destructive operation, so it must not be bypassable here.
      const result = deletePersonalSkill({ homePath: env.homePath, skillPath: requestedPath });
      if (!result.ok) {
        return yield* new SkillsError({ message: result.reason });
      }
    });

  const mcpEnv = claudeEnv.pipe(
    Effect.mapError((cause) => new McpConfigError({ message: cause.message })),
  );

  const listMcpServers = Effect.gen(function* () {
    const env = yield* mcpEnv;
    const config = readClaudeMcpConfig(env.homePath);

    // Health is decoration over the config read: if the CLI is missing or slow
    // we still render the configured servers, just without a status badge.
    const health = yield* listMcpHealth(env).pipe(
      Effect.provideService(ProcessRunner, processRunner),
    );
    const healthByName = new Map(health.map((row) => [row.name, row]));
    const cliAvailable = health.length > 0;

    const servers: ReadonlyArray<McpServerEntry> = config.servers.map((server) => {
      const row = healthByName.get(server.name);
      return {
        name: server.name,
        transport: server.transport,
        scope: server.scope,
        ...(server.projectPath !== undefined ? { projectPath: server.projectPath } : {}),
        ...(server.url !== undefined ? { url: server.url } : {}),
        ...(server.command !== undefined ? { command: server.command } : {}),
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.envKeys !== undefined ? { envKeys: server.envKeys } : {}),
        ...(server.headerKeys !== undefined ? { headerKeys: server.headerKeys } : {}),
        ...(row !== undefined ? { health: row.health } : {}),
        ...(row?.detail !== undefined ? { healthDetail: row.detail } : {}),
      };
    });

    return {
      status: config.status,
      servers,
      sourcePath: config.sourcePath,
      cliAvailable,
      ...(config.error !== undefined ? { error: config.error } : {}),
    } satisfies McpListOutput;
  });

  const addMcp = (input: AddMcpServerInput) =>
    Effect.gen(function* () {
      const env = yield* mcpEnv;
      yield* addMcpServer(env, input).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.mapError((cause) => new McpConfigError({ message: cause.message })),
      );
    });

  const removeMcp = (input: {
    readonly name: string;
    readonly scope?: "local" | "user" | "project";
  }) =>
    Effect.gen(function* () {
      const env = yield* mcpEnv;
      yield* removeMcpServer(env, input).pipe(
        Effect.provideService(ProcessRunner, processRunner),
        Effect.mapError((cause) => new McpConfigError({ message: cause.message })),
      );
    });

  return { listSkills, readSkill, deleteSkill, listMcpServers, addMcp, removeMcp };
});

/**
 * `Path` is supplied ambiently by `NodeServices.layer` at the runtime root
 * (same as `ClaudeHome`), so it is declared as a requirement rather than
 * provided here.
 */
export const layer = Layer.effect(SkillsMcpService, make);

export type { AddMcpServerInput };
