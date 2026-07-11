import type { ServerUpstreamSyncState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import {
  buildSuggestedUpstreamCommand,
  classifyUpstreamDivergence,
  createUnavailableUpstreamSyncState,
  createUnknownUpstreamSyncState,
  DEFAULT_UPSTREAM_BRANCH,
  DEFAULT_UPSTREAM_REMOTE_NAME,
  parseLeftRightCount,
  parseRemoteNames,
  resolveUpstreamBranchFromSymbolicRef,
  resolveUpstreamRemoteName,
} from "./upstreamSyncLogic.ts";

const STARTUP_DELAY = Duration.seconds(20);
const POLL_INTERVAL = Duration.minutes(15);
const GIT_TIMEOUT = Duration.seconds(45);
const GIT_FETCH_ENV = Object.freeze({
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);

export class UpstreamSyncMonitor extends Context.Service<
  UpstreamSyncMonitor,
  {
    readonly getState: Effect.Effect<ServerUpstreamSyncState>;
    readonly refresh: Effect.Effect<ServerUpstreamSyncState>;
    readonly streamChanges: Stream.Stream<ServerUpstreamSyncState>;
  }
>()("t3/install/UpstreamSyncMonitor") {}

const runGit = Effect.fn("UpstreamSyncMonitor.runGit")(function* (input: {
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv | undefined;
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "git",
      args: input.args,
      cwd: input.cwd,
      timeout: GIT_TIMEOUT,
      env: input.env,
      maxOutputBytes: 64_000,
      outputMode: "truncate",
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          stdout: "",
          stderr: cause.message,
          code: 1,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      ),
    );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code ?? 1,
  };
});

export const resolveInstallGitRoot = Effect.fn("UpstreamSyncMonitor.resolveInstallGitRoot")(
  function* (startDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let current = path.resolve(startDir);

    for (;;) {
      const gitPath = path.join(current, ".git");
      const hasGit = yield* fs.exists(gitPath);
      if (hasGit) {
        const workspaceMarker = path.join(current, "pnpm-workspace.yaml");
        const packageJson = path.join(current, "package.json");
        const hasWorkspace = yield* fs.exists(workspaceMarker);
        const hasPackageJson = yield* fs.exists(packageJson);
        if (hasWorkspace || hasPackageJson) {
          return current;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  },
);

const readPreferredRemoteName = (): string => {
  const fromEnv = process.env.T3CODE_UPSTREAM_REMOTE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_UPSTREAM_REMOTE_NAME;
};

const checkUpstreamSync = Effect.fn("UpstreamSyncMonitor.checkUpstreamSync")(function* (
  startDir: string,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const installRoot = yield* resolveInstallGitRoot(startDir);

  if (installRoot === null) {
    return createUnavailableUpstreamSyncState({
      checkedAt,
      message: "This T3 Code install is not running from a git checkout.",
    });
  }

  const remotesResult = yield* runGit({
    cwd: installRoot,
    args: ["remote"],
  });

  if (remotesResult.code !== 0) {
    return createUnavailableUpstreamSyncState({
      checkedAt,
      installRoot,
      message: remotesResult.stderr.trim() || "Could not list git remotes for this install.",
    });
  }

  const remoteName = resolveUpstreamRemoteName({
    remotes: parseRemoteNames(remotesResult.stdout),
    preferredRemoteName: readPreferredRemoteName(),
  });

  if (remoteName === null) {
    return createUnavailableUpstreamSyncState({
      checkedAt,
      installRoot,
      message: `No '${readPreferredRemoteName()}' git remote configured. Add one pointing at pingdotgg/t3code to track upstream updates.`,
    });
  }

  const urlResult = yield* runGit({
    cwd: installRoot,
    args: ["remote", "get-url", remoteName],
  });
  const upstreamUrl = urlResult.code === 0 ? urlResult.stdout.trim() || null : null;

  const headRefResult = yield* runGit({
    cwd: installRoot,
    args: ["symbolic-ref", "--quiet", `refs/remotes/${remoteName}/HEAD`],
  });
  const branch =
    headRefResult.code === 0
      ? resolveUpstreamBranchFromSymbolicRef(headRefResult.stdout, remoteName)
      : DEFAULT_UPSTREAM_BRANCH;
  const upstreamRef = `${remoteName}/${branch}`;

  const fetchResult = yield* runGit({
    cwd: installRoot,
    args: ["fetch", "--quiet", remoteName, branch],
    env: { ...process.env, ...GIT_FETCH_ENV },
  });

  if (fetchResult.code !== 0) {
    return createUnknownUpstreamSyncState({
      checkedAt,
      installRoot,
      upstreamRemote: remoteName,
      upstreamUrl,
      upstreamRef,
      message:
        fetchResult.stderr.trim() ||
        `Failed to fetch ${upstreamRef}. Check network access and remote credentials.`,
    });
  }

  const divergenceResult = yield* runGit({
    cwd: installRoot,
    args: ["rev-list", "--left-right", "--count", `HEAD...${upstreamRef}`],
  });

  const counts = divergenceResult.code === 0 ? parseLeftRightCount(divergenceResult.stdout) : null;
  if (counts === null) {
    return createUnknownUpstreamSyncState({
      checkedAt,
      installRoot,
      upstreamRemote: remoteName,
      upstreamUrl,
      upstreamRef,
      message: divergenceResult.stderr.trim() || `Could not compare HEAD with ${upstreamRef}.`,
    });
  }

  const localShaResult = yield* runGit({
    cwd: installRoot,
    args: ["rev-parse", "HEAD"],
  });
  const upstreamShaResult = yield* runGit({
    cwd: installRoot,
    args: ["rev-parse", upstreamRef],
  });

  const status = classifyUpstreamDivergence(counts.aheadBy, counts.behindBy);
  const suggestedCommand = buildSuggestedUpstreamCommand(remoteName, branch);

  return {
    status,
    checkedAt,
    behindBy: counts.behindBy,
    aheadBy: counts.aheadBy,
    installRoot,
    upstreamRemote: remoteName,
    upstreamUrl,
    upstreamRef,
    localSha: localShaResult.code === 0 ? localShaResult.stdout.trim() || null : null,
    upstreamSha: upstreamShaResult.code === 0 ? upstreamShaResult.stdout.trim() || null : null,
    suggestedCommand,
    message:
      status === "behind"
        ? `${counts.behindBy} commit${counts.behindBy === 1 ? "" : "s"} available from ${upstreamRef}.`
        : status === "diverged"
          ? `Local and ${upstreamRef} have diverged (${counts.aheadBy} ahead, ${counts.behindBy} behind).`
          : status === "ahead"
            ? `Local checkout is ${counts.aheadBy} commit${counts.aheadBy === 1 ? "" : "s"} ahead of ${upstreamRef}.`
            : `In sync with ${upstreamRef}.`,
  } satisfies ServerUpstreamSyncState;
});

export const make = Effect.fn("UpstreamSyncMonitor.make")(function* (startDir?: string) {
  const probeStartDir = startDir ?? import.meta.dirname;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pubsub = yield* PubSub.unbounded<ServerUpstreamSyncState>();
  const state = yield* Ref.make<ServerUpstreamSyncState>(
    createUnavailableUpstreamSyncState({
      message: "Upstream sync has not been checked yet.",
    }),
  );

  const publish = (next: ServerUpstreamSyncState) =>
    Ref.set(state, next).pipe(Effect.andThen(PubSub.publish(pubsub, next)), Effect.as(next));

  const refresh = checkUpstreamSync(probeStartDir).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return createUnknownUpstreamSyncState({
          checkedAt,
          installRoot: null,
          upstreamRemote: null,
          upstreamUrl: null,
          upstreamRef: null,
          message: cause instanceof Error ? cause.message : "Upstream sync check failed.",
        });
      }),
    ),
    Effect.flatMap(publish),
    Effect.withSpan("UpstreamSyncMonitor.refresh"),
  );

  yield* Effect.gen(function* () {
    yield* Effect.sleep(STARTUP_DELAY);
    yield* refresh.pipe(Effect.ignoreCause({ log: true }));
    return yield* Effect.forever(
      Effect.sleep(POLL_INTERVAL).pipe(
        Effect.andThen(refresh.pipe(Effect.ignoreCause({ log: true }))),
      ),
    );
  }).pipe(Effect.forkScoped);

  return UpstreamSyncMonitor.of({
    getState: Ref.get(state),
    refresh,
    get streamChanges() {
      return Stream.fromPubSub(pubsub);
    },
  });
});

export const layer = Layer.effect(UpstreamSyncMonitor, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);

export const layerWithStartDir = (startDir: string) =>
  Layer.effect(UpstreamSyncMonitor, make(startDir)).pipe(Layer.provide(ProcessRunner.layer));
