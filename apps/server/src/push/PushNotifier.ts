import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ApnsConfig, type ApnsCredentials } from "./ApnsConfig.ts";
import { ApnsClient, type ApnsNotificationPayload } from "./ApnsClient.ts";
import { DeviceTokenStore, type PushDevice } from "./DeviceTokenStore.ts";

// Completions/failures republished long after the fact (e.g. server restart
// replays every recently-finished thread) must not ring the device again.
// Mirrors TERMINAL_NOTIFICATION_FRESHNESS_MS in the relay's ApnsDeliveries.
const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;

// APNs reasons / statuses that mean the token is permanently dead and the row
// should be pruned so we stop trying it.
const DEAD_TOKEN_STATUSES = new Set([410]);
const DEAD_TOKEN_REASONS = new Set(["Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic"]);

export class PushNotifier extends Context.Service<
  PushNotifier,
  {
    // Whether the self-hosted APNs path is configured. When false, notify() is a
    // no-op; callers use this to decide whether push is worth reconciling for.
    readonly enabled: boolean;
    readonly notify: (state: RelayAgentActivityState) => Effect.Effect<void>;
  }
>()("t3/push/PushNotifier") {}

// Decides whether a device should be notified for this state and, if so, builds
// the alert payload. Ported from notificationForAggregate in the relay
// (ApnsDeliveries.ts): only terminal/waiting phases notify, gated per-device by
// preferences, and stale terminal states are dropped.
export function notificationForDevice(input: {
  readonly device: PushDevice;
  readonly state: RelayAgentActivityState;
  readonly nowMs: number;
}): ApnsNotificationPayload | null {
  const { device, state } = input;
  if (!device.notificationsEnabled) {
    return null;
  }

  if (state.phase === "completed" || state.phase === "failed") {
    const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
      onNone: () => null,
      onSome: (dt) => dt.epochMilliseconds,
    });
    if (updatedAtMs === null || input.nowMs - updatedAtMs > TERMINAL_NOTIFICATION_FRESHNESS_MS) {
      return null;
    }
  }

  const enabled =
    (state.phase === "waiting_for_approval" && device.notifyOnApproval) ||
    (state.phase === "waiting_for_input" && device.notifyOnInput) ||
    (state.phase === "completed" && device.notifyOnCompletion) ||
    (state.phase === "failed" && device.notifyOnFailure);
  if (!enabled) {
    return null;
  }

  return {
    title: state.threadTitle,
    body: `${state.headline}: ${state.projectTitle}`,
    environmentId: state.environmentId,
    threadId: state.threadId,
    deepLink: state.deepLink,
  };
}

function isDeadToken(result: { readonly status: number; readonly reason?: string }): boolean {
  return (
    DEAD_TOKEN_STATUSES.has(result.status) ||
    (result.reason !== undefined && DEAD_TOKEN_REASONS.has(result.reason))
  );
}

export const make = Effect.gen(function* () {
  const config = yield* ApnsConfig;
  const apns = yield* ApnsClient;
  const store = yield* DeviceTokenStore;

  const notify: PushNotifier["Service"]["notify"] = (state) =>
    Effect.gen(function* () {
      // Push is opt-in: no APNs credentials means the self-hosted path is off.
      if (Option.isNone(config.credentials)) {
        return;
      }
      const credentials: ApnsCredentials = config.credentials.value;

      const devices: ReadonlyArray<PushDevice> = yield* store.list().pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("push device list failed; skipping notification", { cause }),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<PushDevice>),
      );
      if (devices.length === 0) {
        return;
      }

      const nowMs = (yield* DateTime.now).epochMilliseconds;
      const issuedAtUnixSeconds = Math.floor(nowMs / 1_000);

      yield* Effect.forEach(
        devices,
        (device) =>
          Effect.gen(function* () {
            // Only deliver to devices whose registered APNs environment matches
            // the server's configured host; a sandbox token sent to production
            // (or vice versa) always fails with BadDeviceToken.
            if (device.apsEnvironment !== credentials.environment) {
              return;
            }
            const notification = notificationForDevice({ device, state, nowMs });
            if (notification === null) {
              return;
            }
            // The device may register its own bundle id (dev/preview/prod
            // variants differ); the APNs topic must match it.
            const deviceCredentials: ApnsCredentials = device.bundleId
              ? { ...credentials, bundleId: device.bundleId }
              : credentials;
            const request = apns.makePushNotificationRequest({
              token: device.pushToken,
              notification,
            });
            const result = yield* apns
              .sendPushNotificationRequest({
                credentials: deviceCredentials,
                request,
                issuedAtUnixSeconds,
              })
              .pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("push notification delivery errored", {
                    deviceId: device.deviceId,
                    cause,
                  }),
                ),
                Effect.option,
              );
            if (Option.isNone(result)) {
              return;
            }
            if (!result.value.ok) {
              yield* Effect.logWarning("push notification rejected by APNs", {
                deviceId: device.deviceId,
                status: result.value.status,
                reason: result.value.reason ?? null,
              });
              if (isDeadToken(result.value)) {
                yield* store.remove(device.deviceId).pipe(Effect.ignore);
                yield* Effect.logInfo("pruned dead push device token", {
                  deviceId: device.deviceId,
                });
              }
            }
          }),
        { concurrency: 4, discard: true },
      );
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("push notification failed", { cause })));

  return PushNotifier.of({ enabled: Option.isSome(config.credentials), notify });
});

export const layer = Layer.effect(PushNotifier, make);

// A disabled notifier for tests and for consumers that don't wire APNs: notify
// is a no-op and enabled is false.
export const layerDisabled = Layer.succeed(
  PushNotifier,
  PushNotifier.of({ enabled: false, notify: () => Effect.void }),
);
