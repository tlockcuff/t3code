import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";

import { ProcessRunner } from "../processRunner.ts";

/**
 * Thin wrapper over the `claude mcp` CLI.
 *
 * Reads come from `.claude.json` directly (see `claudeMcpConfig.ts`), but every
 * *write* is delegated here so that Claude Code — which owns the file format —
 * performs it. We never rewrite a config file we don't own.
 *
 * The CLI has no `--json` output for `list`, so health is scraped from its
 * human-readable lines. That is a real coupling to a text format, hence the
 * deliberately forgiving parser and the `unknown` fallback: a format change
 * degrades health to "unknown", it does not break the screen.
 */

export type McpHealth = "connected" | "needs_auth" | "failed" | "pending" | "unknown";

export type McpHealthRow = {
  readonly name: string;
  readonly health: McpHealth;
  /** The CLI's own status text, kept verbatim for tooltips/diagnostics. */
  readonly detail?: string;
};

/** Health-checking every server hits the network; keep it bounded. */
const LIST_TIMEOUT = Duration.seconds(30);
const WRITE_TIMEOUT = Duration.seconds(30);

function classifyStatus(status: string): McpHealth {
  const normalized = status.toLowerCase();
  if (normalized.includes("needs authentication")) return "needs_auth";
  if (normalized.includes("pending approval")) return "pending";
  if (normalized.includes("connected")) return "connected";
  if (normalized.includes("failed") || normalized.includes("error")) return "failed";
  return "unknown";
}

/**
 * Parse `claude mcp list` output.
 *
 * Each server is one line of the form:
 *   `<name>: <command-or-url> - <status>`
 * where status is e.g. `✔ Connected`, `! Needs authentication`, `⏸ Pending approval`.
 * Header/blank lines ("Checking MCP server health…") have no ` - ` and are skipped.
 */
export function parseMcpListOutput(stdout: string): ReadonlyArray<McpHealthRow> {
  const rows: Array<McpHealthRow> = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;

    // Split on the LAST " - " so URLs containing a dash stay intact.
    const separatorIndex = line.lastIndexOf(" - ");
    if (separatorIndex <= colonIndex) continue;

    const name = line.slice(0, colonIndex).trim();
    const status = line.slice(separatorIndex + 3).trim();
    if (name.length === 0 || status.length === 0) continue;

    rows.push({ name, health: classifyStatus(status), detail: status });
  }

  return rows;
}

export type McpCliEnv = {
  readonly binaryPath: string;
  /** Instance HOME, so the CLI reads/writes the same `.claude.json` we read. */
  readonly homePath: string;
};

function cliEnv(env: McpCliEnv): NodeJS.ProcessEnv {
  return { ...process.env, HOME: env.homePath };
}

/**
 * Health for every configured server. Returns an empty list rather than
 * failing: health is decoration over the config read, and a missing or slow
 * CLI must not take the whole screen down.
 */
export const listMcpHealth = Effect.fn("listMcpHealth")(function* (env: McpCliEnv) {
  const runner = yield* ProcessRunner;

  const result = yield* runner
    .run({
      command: env.binaryPath,
      args: ["mcp", "list"],
      env: cliEnv(env),
      timeout: LIST_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.orElseSucceed(() => null));

  if (result === null || result.timedOut) {
    return [] as ReadonlyArray<McpHealthRow>;
  }

  // The CLI exits non-zero when some server is unhealthy, but still prints the
  // rows we want — so parse stdout regardless of exit code.
  return parseMcpListOutput(result.stdout);
});

export type AddMcpServerInput = {
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly scope: "local" | "user" | "project";
  /** URL for http/sse; executable for stdio. */
  readonly target: string;
  /** stdio only. */
  readonly args?: ReadonlyArray<string>;
  /** stdio only, `KEY=value`. */
  readonly env?: ReadonlyArray<string>;
  /** http/sse only, `Name: value`. */
  readonly headers?: ReadonlyArray<string>;
};

/**
 * Reject values that would be parsed as flags rather than as data.
 *
 * Without this, a server named `--help` (or any other flag) is smuggled into
 * `claude`'s own argv — verified against the real CLI, which happily created a
 * server literally named `--help`. A hostile value could instead select a flag
 * that changes where config is written. Names and targets are attacker-shaped
 * input (they come straight from the Add dialog), so they are validated before
 * they ever reach a process boundary.
 */
export function assertNotFlagLike(input: AddMcpServerInput): string | null {
  if (input.name.startsWith("-")) {
    return "Server name cannot start with '-'.";
  }
  if (input.target.startsWith("-")) {
    return "Command or URL cannot start with '-'.";
  }
  return null;
}

/**
 * Build the argv for `claude mcp add`.
 *
 * A `--` sentinel precedes the positional values in EVERY transport, not just
 * stdio: it stops a leading-dash name or target from being read as a flag by
 * the `claude` parser. (Confirmed the CLI accepts `--` for http/sse too.) For
 * stdio it additionally separates the child command's own flags from
 * `claude`'s. `assertNotFlagLike` is the belt to this suspenders — either alone
 * would do, and both are cheap.
 */
export function buildAddArgs(input: AddMcpServerInput): ReadonlyArray<string> {
  const args: Array<string> = ["mcp", "add", "--scope", input.scope];

  args.push("--transport", input.transport);

  for (const entry of input.env ?? []) {
    args.push("--env", entry);
  }
  for (const header of input.headers ?? []) {
    args.push("--header", header);
  }

  // Everything after `--` is positional, never a flag.
  args.push("--", input.name, input.target);

  if (input.transport === "stdio") {
    args.push(...(input.args ?? []));
  }

  return args;
}

export class McpCliError extends Error {
  readonly _tag = "McpCliError";
  constructor(message: string) {
    super(message);
    this.name = "McpCliError";
  }
}

function failureMessage(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}): string {
  if (result.timedOut) {
    return "The `claude mcp` command timed out. Remote servers that require OAuth must be authorized by running `/mcp` in a Claude session.";
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length > 0 ? detail : "The `claude mcp` command failed.";
}

export const addMcpServer = Effect.fn("addMcpServer")(function* (
  env: McpCliEnv,
  input: AddMcpServerInput,
) {
  const runner = yield* ProcessRunner;

  const invalid = assertNotFlagLike(input);
  if (invalid !== null) {
    return yield* Effect.fail(new McpCliError(invalid));
  }

  const result = yield* runner.run({
    command: env.binaryPath,
    args: buildAddArgs(input),
    env: cliEnv(env),
    timeout: WRITE_TIMEOUT,
    timeoutBehavior: "timedOutResult",
  });

  if (result.timedOut || (result.code !== null && result.code !== 0)) {
    return yield* Effect.fail(new McpCliError(failureMessage(result)));
  }
});

export const removeMcpServer = Effect.fn("removeMcpServer")(function* (
  env: McpCliEnv,
  input: { readonly name: string; readonly scope?: "local" | "user" | "project" },
) {
  const runner = yield* ProcessRunner;

  // Same flag-smuggling hazard as `add`: a server named `--scope` would
  // otherwise be parsed as a flag rather than as the name to remove.
  if (input.name.startsWith("-")) {
    return yield* Effect.fail(new McpCliError("Server name cannot start with '-'."));
  }

  const args = ["mcp", "remove"];
  if (input.scope !== undefined) {
    args.push("--scope", input.scope);
  }
  args.push("--", input.name);

  const result = yield* runner.run({
    command: env.binaryPath,
    args,
    env: cliEnv(env),
    timeout: WRITE_TIMEOUT,
    timeoutBehavior: "timedOutResult",
  });

  if (result.timedOut || (result.code !== null && result.code !== 0)) {
    return yield* Effect.fail(new McpCliError(failureMessage(result)));
  }
});
