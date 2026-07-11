import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export const ApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type ApnsEnvironment = typeof ApnsEnvironment.Type;

// Mirrors the relay's ApnsCredentials so the copied signing/client code needs
// no shape changes.
export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: Redacted.Redacted<string>;
  readonly bundleId: string;
  readonly environment: ApnsEnvironment;
}

// The self-hosted push path is opt-in: when neither env vars nor the config
// file provide credentials the service resolves to None and the notifier
// no-ops, leaving the managed relay path (if any) untouched.
export class ApnsConfig extends Context.Service<
  ApnsConfig,
  {
    readonly credentials: Option.Option<ApnsCredentials>;
  }
>()("t3/push/ApnsConfig") {}

// File name (in the server state dir) for the JSON fallback config. Used when
// the process env is unset — e.g. the desktop app is launched from Finder and
// doesn't inherit a shell's exported APNS_* vars.
export const APNS_CONFIG_FILE_NAME = "push-config.json";

// Resolved settings, before the .p8 file is loaded. Both the env and file paths
// produce this shape.
interface ApnsSettings {
  readonly teamId: string;
  readonly keyId: string;
  readonly bundleId: string;
  readonly privateKeyPath: string;
  readonly environment: ApnsEnvironment;
}

const ApnsConfigFile = Schema.Struct({
  teamId: Schema.String,
  keyId: Schema.String,
  bundleId: Schema.String,
  privateKeyPath: Schema.String,
  environment: ApnsEnvironment,
});
const decodeApnsConfigFile = Schema.decodeUnknownEffect(Schema.fromJsonString(ApnsConfigFile));

// Prefer APNS_* env vars (dev-runner / CLI launches export these).
const readSettingsFromEnv: Effect.Effect<Option.Option<ApnsSettings>> = Config.all({
  teamId: Config.string("APNS_TEAM_ID"),
  keyId: Config.string("APNS_KEY_ID"),
  bundleId: Config.string("APNS_BUNDLE_ID"),
  privateKeyPath: Config.string("APNS_PRIVATE_KEY_PATH"),
  environment: Config.schema(ApnsEnvironment, "APNS_ENVIRONMENT"),
}).pipe(Effect.option);

// Fallback: <stateDir>/push-config.json. Works regardless of how the app is
// launched (GUI or terminal), so the desktop app never needs shell env.
const readSettingsFromFile: Effect.Effect<
  Option.Option<ApnsSettings>,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const configPath = path.join(config.stateDir, APNS_CONFIG_FILE_NAME);

  const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none<ApnsSettings>();
  }

  const settings = yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeApnsConfigFile),
    Effect.tapError((cause) =>
      Effect.logWarning("APNs config file could not be read; push notifications disabled", {
        path: configPath,
        cause,
      }),
    ),
    Effect.option,
  );
  return settings;
});

const readCredentials = Effect.gen(function* () {
  const fromEnv = yield* readSettingsFromEnv;
  const settings = Option.isSome(fromEnv) ? fromEnv : yield* readSettingsFromFile;
  if (Option.isNone(settings)) {
    return Option.none<ApnsCredentials>();
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const privateKey = yield* fileSystem.readFileString(settings.value.privateKeyPath).pipe(
    Effect.map((contents) => contents.trim()),
    Effect.tapError((cause) =>
      Effect.logWarning("APNs private key could not be read; push notifications disabled", {
        path: settings.value.privateKeyPath,
        cause,
      }),
    ),
    Effect.option,
  );
  if (Option.isNone(privateKey) || privateKey.value.length === 0) {
    return Option.none<ApnsCredentials>();
  }

  return Option.some<ApnsCredentials>({
    teamId: settings.value.teamId,
    keyId: settings.value.keyId,
    bundleId: settings.value.bundleId,
    environment: settings.value.environment,
    privateKey: Redacted.make(privateKey.value),
  });
});

export const layer = Layer.effect(
  ApnsConfig,
  readCredentials.pipe(Effect.map((credentials) => ApnsConfig.of({ credentials }))),
);
