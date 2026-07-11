import type {
  EnvironmentPushRegisterResult,
  EnvironmentPushUnregisterResult,
} from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_PUSH_REGISTRATION_TIMEOUT_MS = 8_000;

/**
 * Registers a device's APNs push token directly with its paired environment
 * server (self-hosted push), using the same authenticated-HTTP path as the
 * other environment endpoints. No managed relay / Clerk handshake is involved —
 * the device's existing environment session authorizes the request.
 */
export const registerPushDeviceOverHttp = Effect.fn(
  "clientRuntime.state.registerPushDeviceOverHttp",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: RelayDeviceRegistrationRequest;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/push/devices");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PUSH_REGISTRATION_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.push.registerDevice({ payload: input.payload, headers }),
    ),
  );
});

export const unregisterPushDeviceOverHttp = Effect.fn(
  "clientRuntime.state.unregisterPushDeviceOverHttp",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly deviceId: string;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/push/devices/${input.deviceId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "DELETE",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PUSH_REGISTRATION_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.push.unregisterDevice({ params: { deviceId: input.deviceId }, headers }),
    ),
  );
});

export type RegisterPushDeviceError = RemoteEnvironmentRequestError;
export type { EnvironmentPushRegisterResult, EnvironmentPushUnregisterResult };
