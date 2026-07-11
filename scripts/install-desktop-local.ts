#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { resolveDesktopProductName } from "./build-desktop-artifact.ts";

const DEFAULT_INSTALL_DIR = "/Applications";
const QUIT_POLL_ATTEMPTS = 20;
const QUIT_POLL_INTERVAL_MS = 250;
const COMMAND_OUTPUT_TAIL_LENGTH = 20_000;

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export class DesktopInstallUnsupportedPlatformError extends Schema.TaggedErrorClass<DesktopInstallUnsupportedPlatformError>()(
  "DesktopInstallUnsupportedPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Local desktop install is only supported on macOS (received '${this.hostPlatform}').`;
  }
}

export class DesktopInstallBuiltAppMissingError extends Schema.TaggedErrorClass<DesktopInstallBuiltAppMissingError>()(
  "DesktopInstallBuiltAppMissingError",
  {
    expectedPath: Schema.String,
    outputDir: Schema.String,
  },
) {
  override get message(): string {
    return `Built app bundle not found at ${this.expectedPath}. Expected a dir-target artifact in ${this.outputDir}.`;
  }
}

export class DesktopInstallCommandFailedError extends Schema.TaggedErrorClass<DesktopInstallCommandFailedError>()(
  "DesktopInstallCommandFailedError",
  {
    label: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const sections = [
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);
    const suffix = sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
    return `${this.label} failed with exit code ${this.exitCode}.${suffix}`;
  }
}

export function resolveInstalledAppPath(
  joinPath: (...parts: string[]) => string,
  installDir: string,
  productName: string,
): string {
  return joinPath(installDir, `${productName}.app`);
}

export function resolveBuiltAppPath(
  joinPath: (...parts: string[]) => string,
  outputDir: string,
  productName: string,
): string {
  return joinPath(outputDir, `${productName}.app`);
}

export function macQuitAppAppleScript(productName: string): string {
  const escaped = productName.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `tell application "${escaped}" to quit`;
}

function appendOutputTail(acc: string, chunk: string): string {
  const next = acc + chunk;
  return next.length > COMMAND_OUTPUT_TAIL_LENGTH ? next.slice(-COMMAND_OUTPUT_TAIL_LENGTH) : next;
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  return `${label} tail:\n${trimmed}`;
}

const collectCommandStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  output: NodeJS.WriteStream,
  verbose: boolean,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(
      () => "",
      (acc, chunk) =>
        Effect.as(
          verbose ? Effect.sync(() => output.write(chunk)) : Effect.void,
          appendOutputTail(acc, chunk),
        ),
    ),
  );

const runLabeledCommand = Effect.fn("runLabeledCommand")(function* (
  command: ChildProcess.Command,
  label: string,
  options?: {
    readonly allowNonZeroExit?: boolean;
    readonly verbose?: boolean;
  },
) {
  const verbose = options?.verbose ?? false;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectCommandStream(child.stdout, process.stdout, verbose),
      collectCommandStream(child.stderr, process.stderr, verbose),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  if (exitCode !== 0 && !options?.allowNonZeroExit) {
    return yield* new DesktopInstallCommandFailedError({
      label,
      exitCode,
      ...(stdout.trim() ? { stdoutTail: stdout } : {}),
      ...(stderr.trim() ? { stderrTail: stderr } : {}),
    });
  }

  return { stdout, stderr, exitCode } as const;
});

const isAppProcessRunning = Effect.fn("isAppProcessRunning")(function* (productName: string) {
  const result = yield* runLabeledCommand(
    ChildProcess.make("pgrep", ["-x", productName]),
    `pgrep ${productName}`,
    { allowNonZeroExit: true },
  );
  return result.exitCode === 0;
});

const quitRunningDesktopApp = Effect.fn("quitRunningDesktopApp")(function* (
  productName: string,
  verbose: boolean,
) {
  if (!(yield* isAppProcessRunning(productName))) {
    yield* Effect.log(`[desktop-install] ${productName} is not running.`);
    return;
  }

  yield* Effect.log(`[desktop-install] Quitting ${productName}...`);
  yield* runLabeledCommand(
    ChildProcess.make("osascript", ["-e", macQuitAppAppleScript(productName)]),
    `osascript quit ${productName}`,
    { allowNonZeroExit: true, verbose },
  );

  for (let attempt = 0; attempt < QUIT_POLL_ATTEMPTS; attempt++) {
    if (!(yield* isAppProcessRunning(productName))) {
      yield* Effect.log(`[desktop-install] ${productName} quit.`);
      return;
    }
    yield* Effect.sleep(`${QUIT_POLL_INTERVAL_MS} millis`);
  }

  yield* Effect.log(`[desktop-install] Force-killing ${productName}...`);
  yield* runLabeledCommand(
    ChildProcess.make("killall", ["-9", productName]),
    `killall ${productName}`,
    {
      allowNonZeroExit: true,
      verbose,
    },
  );
});

const installDesktopAppBundle = Effect.fn("installDesktopAppBundle")(function* (input: {
  readonly builtAppPath: string;
  readonly installedAppPath: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;

  yield* Effect.log(`[desktop-install] Installing to ${input.installedAppPath}...`);

  if (yield* fs.exists(input.installedAppPath)) {
    yield* fs.remove(input.installedAppPath, { recursive: true });
  }

  yield* runLabeledCommand(
    ChildProcess.make("ditto", [input.builtAppPath, input.installedAppPath]),
    `ditto ${input.builtAppPath}`,
    { verbose: input.verbose },
  );

  yield* runLabeledCommand(
    ChildProcess.make("xattr", ["-cr", input.installedAppPath]),
    `xattr ${input.installedAppPath}`,
    { allowNonZeroExit: true, verbose: input.verbose },
  );
});

const buildDesktopDirArtifact = Effect.fn("buildDesktopDirArtifact")(function* (input: {
  readonly repoRoot: string;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
  readonly outputDir: string | undefined;
  readonly arch: string | undefined;
  readonly buildVersion: string | undefined;
}) {
  const args = ["scripts/build-desktop-artifact.ts", "--platform", "mac", "--target", "dir"];
  if (input.skipBuild) {
    args.push("--skip-build");
  }
  if (input.verbose) {
    args.push("--verbose");
  }
  if (input.outputDir) {
    args.push("--output-dir", input.outputDir);
  }
  if (input.arch) {
    args.push("--arch", input.arch);
  }
  if (input.buildVersion) {
    args.push("--build-version", input.buildVersion);
  }

  yield* Effect.log("[desktop-install] Building mac dir artifact...");
  const spawnCommand = yield* resolveSpawnCommand("node", args);
  yield* runLabeledCommand(
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: input.repoRoot,
      shell: spawnCommand.shell,
    }),
    "build-desktop-artifact --target dir",
    { verbose: input.verbose },
  );
});

export const installDesktopLocal = Effect.fn("installDesktopLocal")(function* (input: {
  readonly skipBuild: boolean;
  readonly open: boolean;
  readonly verbose: boolean;
  readonly installDir: string;
  readonly outputDir: string | undefined;
  readonly arch: string | undefined;
  readonly buildVersion: string | undefined;
}) {
  const hostPlatform = yield* HostProcessPlatform;
  if (hostPlatform !== "darwin") {
    return yield* new DesktopInstallUnsupportedPlatformError({ hostPlatform });
  }

  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const version = input.buildVersion ?? serverPackageJson.version;
  const productName = resolveDesktopProductName(version);
  const outputDir = path.resolve(repoRoot, input.outputDir ?? "release");
  const builtAppPath = resolveBuiltAppPath(
    (...parts) => path.join(...parts),
    outputDir,
    productName,
  );
  const installedAppPath = resolveInstalledAppPath(
    (...parts) => path.join(...parts),
    input.installDir,
    productName,
  );

  yield* buildDesktopDirArtifact({
    repoRoot,
    skipBuild: input.skipBuild,
    verbose: input.verbose,
    outputDir: input.outputDir,
    arch: input.arch,
    buildVersion: input.buildVersion,
  });

  if (!(yield* fs.exists(builtAppPath))) {
    return yield* new DesktopInstallBuiltAppMissingError({
      expectedPath: builtAppPath,
      outputDir,
    });
  }

  yield* quitRunningDesktopApp(productName, input.verbose);

  yield* installDesktopAppBundle({
    builtAppPath,
    installedAppPath,
    verbose: input.verbose,
  });

  if (input.open) {
    yield* Effect.log(`[desktop-install] Opening ${installedAppPath}...`);
    yield* runLabeledCommand(ChildProcess.make("open", [installedAppPath]), `open ${productName}`, {
      verbose: input.verbose,
    });
  }

  yield* Effect.log(`[desktop-install] Done. Installed ${productName} to ${installedAppPath}.`);
});

const installDesktopLocalCli = Command.make("install-desktop-local", {
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription("Skip `vp run build:desktop` and package existing dist artifacts."),
    Flag.optional,
  ),
  noOpen: Flag.boolean("no-open").pipe(
    Flag.withDescription("Install without launching the app afterward."),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout/stderr."),
    Flag.optional,
  ),
  installDir: Flag.string("install-dir").pipe(
    Flag.withDescription(`Install destination directory (default: ${DEFAULT_INSTALL_DIR}).`),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription(
      "Artifact output directory passed to the desktop builder (default: release).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", ["arm64", "x64", "universal"] as const).pipe(
    Flag.withDescription("Build arch passed to the desktop builder."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata passed to the desktop builder."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Build the macOS desktop app and replace the copy in /Applications (local install).",
  ),
  Command.withHandler((flags) =>
    installDesktopLocal({
      skipBuild: Option.getOrElse(flags.skipBuild, () => false),
      open: !Option.getOrElse(flags.noOpen, () => false),
      verbose: Option.getOrElse(flags.verbose, () => false),
      installDir: Option.getOrElse(flags.installDir, () => DEFAULT_INSTALL_DIR),
      outputDir: Option.getOrUndefined(flags.outputDir),
      arch: Option.getOrUndefined(flags.arch),
      buildVersion: Option.getOrUndefined(flags.buildVersion),
    }),
  ),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(installDesktopLocalCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
