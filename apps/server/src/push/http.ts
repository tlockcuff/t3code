import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { DeviceTokenStore, toUpsertInput } from "./DeviceTokenStore.ts";

// Self-hosted push registration handlers. A device is only persisted if it
// supplied a push token — a token-less registration (notifications disabled or
// permission denied) removes any existing row so we stop pushing to it.
export const pushHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "push",
  Effect.fnUntraced(function* (handlers) {
    const store = yield* DeviceTokenStore;

    return handlers
      .handle(
        "registerDevice",
        Effect.fn("environment.push.registerDevice")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const request = args.payload;

          if (!request.pushToken) {
            yield* Effect.logInfo("push device registration removed (no token)", {
              deviceId: request.deviceId,
            });
            yield* store
              .remove(request.deviceId)
              .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
            return { registered: false };
          }

          const now = yield* DateTime.now;
          yield* store
            .upsert(
              toUpsertInput({
                request,
                pushToken: request.pushToken,
                updatedAt: DateTime.formatIso(now),
              }),
            )
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          yield* Effect.logInfo("push device registered", {
            deviceId: request.deviceId,
            bundleId: request.bundleId ?? null,
            apsEnvironment: request.apsEnvironment ?? null,
          });
          return { registered: true };
        }),
      )
      .handle(
        "unregisterDevice",
        Effect.fn("environment.push.unregisterDevice")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (!args.params.deviceId) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          yield* store
            .remove(args.params.deviceId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          return { unregistered: true };
        }),
      );
  }),
);
