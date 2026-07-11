import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import type { ApnsCredentials } from "./ApnsConfig.ts";

// Adapted from infra/relay/src/agentActivity/apnsJwt.ts. The relay signs
// deterministically with @noble/curves so a multi-isolate fleet presents one
// stable provider token; a single server process has no such constraint, so we
// sign with node:crypto directly and avoid the extra dependency. The provider
// token is still reused via ApnsProviderTokens, which is what actually keeps
// APNs from returning 429 TooManyProviderTokenUpdates.

export class ApnsJwtEncodingError extends Schema.TaggedErrorClass<ApnsJwtEncodingError>()(
  "ApnsJwtEncodingError",
  {
    component: Schema.Literals(["header", "payload"]),
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode APNs JWT ${this.component} for key ${this.keyId}.`;
  }
}

export class ApnsJwtSigningError extends Schema.TaggedErrorClass<ApnsJwtSigningError>()(
  "ApnsJwtSigningError",
  {
    teamId: Schema.String,
    keyId: Schema.String,
    issuedAtUnixSeconds: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sign APNs JWT for key ${this.keyId}.`;
  }
}

export type ApnsJwtError = ApnsJwtEncodingError | ApnsJwtSigningError;

const encodeApnsJwtHeaderJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      alg: Schema.Literal("ES256"),
      kid: Schema.String,
    }),
  ),
);
const encodeApnsJwtPayloadJson = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      iss: Schema.String,
      iat: Schema.Number,
    }),
  ),
);

export interface ApnsJwtSigningInput {
  readonly teamId: ApnsCredentials["teamId"];
  readonly keyId: ApnsCredentials["keyId"];
  readonly privateKey: ApnsCredentials["privateKey"];
  readonly issuedAtUnixSeconds: number;
}

export const makeApnsJwt = Effect.fn("push.apns.make_jwt")(function* (input: ApnsJwtSigningInput) {
  const headerJson = yield* encodeApnsJwtHeaderJson({ alg: "ES256", kid: input.keyId }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "header",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );
  const payloadJson = yield* encodeApnsJwtPayloadJson({
    iss: input.teamId,
    iat: input.issuedAtUnixSeconds,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ApnsJwtEncodingError({
          component: "payload",
          teamId: input.teamId,
          keyId: input.keyId,
          issuedAtUnixSeconds: input.issuedAtUnixSeconds,
          cause,
        }),
    ),
  );

  const privateKeyPem = Redacted.value(input.privateKey);
  const header = Encoding.encodeBase64Url(headerJson);
  const payload = Encoding.encodeBase64Url(payloadJson);
  const signingInput = `${header}.${payload}`;

  return yield* Effect.try({
    try: () => {
      // dsaEncoding "ieee-p1363" produces the raw R||S signature APNs's ES256
      // requires (not the DER encoding node emits by default). The PEM may have
      // arrived through an env var with escaped newlines.
      const key = NodeCrypto.createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
      const signature = NodeCrypto.sign("SHA256", Buffer.from(signingInput, "utf8"), {
        key,
        dsaEncoding: "ieee-p1363",
      });
      return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
    },
    catch: (cause) =>
      new ApnsJwtSigningError({
        teamId: input.teamId,
        keyId: input.keyId,
        issuedAtUnixSeconds: input.issuedAtUnixSeconds,
        cause,
      }),
  });
});

// Fingerprint the key material so rotated credentials never reuse a JWT
// signed by the previous key.
export function apnsProviderTokenCacheKey(input: {
  readonly teamId: string;
  readonly keyId: string;
  readonly privateKey: ApnsCredentials["privateKey"];
}): string {
  const keyFingerprint = NodeCrypto.createHash("sha256")
    .update(Redacted.value(input.privateKey))
    .digest("hex")
    .slice(0, 16);
  return `${input.teamId}:${input.keyId}:${keyFingerprint}`;
}
