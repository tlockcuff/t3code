import * as Http2 from "node:http2";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ApnsEnvironment as ApnsEnvironmentSchema, type ApnsCredentials } from "./ApnsConfig.ts";
import { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

export { ApnsJwtEncodingError, ApnsJwtSigningError } from "./apnsJwt.ts";

// The alert-push notification payload. Custom routing keys (environmentId,
// threadId, deepLink) sit at the top level alongside `aps`, which is how iOS
// surfaces them as notification `content.data` for the tap handler.
export interface ApnsNotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
}

interface ApnsPushNotificationRequest {
  readonly token: string;
  readonly priority: "10";
  readonly payload: unknown;
}

export interface ApnsDeliveryResult {
  readonly ok: boolean;
  readonly status: number;
  readonly reason?: string;
  readonly apnsId: string | null;
}

export class ApnsHttpRequestError extends Schema.TaggedErrorClass<ApnsHttpRequestError>()(
  "ApnsHttpRequestError",
  {
    environment: ApnsEnvironmentSchema,
    bundleId: Schema.String,
    tokenSuffix: Schema.String,
    stage: Schema.Literals(["send", "read-response"]),
    status: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs push-notification request failed during ${this.stage} in ${this.environment}.`;
  }
}

export const ApnsError = Schema.Union([
  ApnsJwtEncodingError,
  ApnsJwtSigningError,
  ApnsHttpRequestError,
]);
export type ApnsError = typeof ApnsError.Type;

const decodeApnsErrorResponseJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      reason: Schema.optional(Schema.String),
    }),
  ),
);

function makePushNotificationRequest(input: {
  readonly token: string;
  readonly notification: ApnsNotificationPayload;
}): ApnsPushNotificationRequest {
  return {
    token: input.token,
    priority: "10",
    payload: {
      aps: {
        alert: {
          title: input.notification.title,
          body: input.notification.body,
        },
        sound: "default",
      },
      environmentId: input.notification.environmentId,
      threadId: input.notification.threadId,
      deepLink: input.notification.deepLink,
    },
  };
}

function apnsReasonFromBody(body: string): string | undefined {
  if (body.trim().length === 0) {
    return undefined;
  }
  return Option.match(decodeApnsErrorResponseJson(body), {
    onNone: () => body,
    onSome: (parsed) => parsed.reason ?? body,
  });
}

interface RawApnsResponse {
  readonly status: number;
  readonly apnsId: string | null;
  readonly body: string;
}

// APNs speaks HTTP/2 ONLY, so a fetch-based client (Node's fetch is HTTP/1.1)
// fails at connect with a transport TypeError. Use node:http2 directly. A short-
// lived session per request is fine at agent-notification volume; connection
// reuse would be a future optimization, not a correctness requirement.
function sendViaHttp2(input: {
  readonly host: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}): Promise<RawApnsResponse> {
  return new Promise((resolve, reject) => {
    const session = Http2.connect(input.host);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      session.close();
      fn();
    };

    session.on("error", (err) => finish(() => reject(err)));

    const req = session.request({
      ":method": "POST",
      ":path": input.path,
      ...input.headers,
      "content-length": Buffer.byteLength(input.body).toString(),
    });

    let status = 0;
    let apnsId: string | null = null;
    let responseBody = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
      const id = headers["apns-id"];
      apnsId = typeof id === "string" ? id : null;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      responseBody += chunk;
    });
    req.on("error", (err) => finish(() => reject(err)));
    req.on("end", () => finish(() => resolve({ status, apnsId, body: responseBody })));
    req.write(input.body);
    req.end();
  });
}

export class ApnsClient extends Context.Service<
  ApnsClient,
  {
    readonly makePushNotificationRequest: typeof makePushNotificationRequest;
    readonly sendPushNotificationRequest: (input: {
      readonly credentials: ApnsCredentials;
      readonly request: ApnsPushNotificationRequest;
      readonly issuedAtUnixSeconds: number;
    }) => Effect.Effect<ApnsDeliveryResult, ApnsError>;
  }
>()("t3/push/ApnsClient") {}

export const make = Effect.gen(function* () {
  const providerTokens = yield* ApnsProviderTokens.ApnsProviderTokens;

  const sendPushNotificationRequest: ApnsClient["Service"]["sendPushNotificationRequest"] =
    Effect.fn("push.apns.send_push_notification_request")(function* (input) {
      const jwt = yield* providerTokens.getJwt({
        ...input.credentials,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
      });
      const host =
        input.credentials.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com";
      const response = yield* Effect.tryPromise({
        try: () =>
          sendViaHttp2({
            host,
            path: `/3/device/${input.request.token}`,
            headers: {
              authorization: `bearer ${jwt}`,
              "apns-priority": input.request.priority,
              "apns-push-type": "alert",
              "apns-topic": input.credentials.bundleId,
              "content-type": "application/json",
            },
            body: JSON.stringify(input.request.payload),
          }),
        catch: (cause) =>
          new ApnsHttpRequestError({
            environment: input.credentials.environment,
            bundleId: input.credentials.bundleId,
            tokenSuffix: input.request.token.slice(-8),
            stage: "send",
            status: null,
            cause,
          }),
      });
      const reason = apnsReasonFromBody(response.body);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        ...(reason === undefined ? {} : { reason }),
        apnsId: response.apnsId,
      };
    });

  return ApnsClient.of({
    makePushNotificationRequest,
    sendPushNotificationRequest,
  });
});

export const layer = Layer.effect(ApnsClient, make);
