import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  apnsProviderTokenCacheKey,
  makeApnsJwt,
  type ApnsJwtError,
  type ApnsJwtSigningInput,
} from "./apnsJwt.ts";

// APNs requires REUSING the provider token: refreshing it more than roughly
// once per 20 minutes returns 429 TooManyProviderTokenUpdates and drops the
// push. Reuse each signed JWT for most of its 60-minute validity.
export const APNS_JWT_REUSE_SECONDS = 45 * 60;

export class ApnsProviderTokens extends Context.Service<
  ApnsProviderTokens,
  {
    readonly getJwt: (input: ApnsJwtSigningInput) => Effect.Effect<string, ApnsJwtError>;
  }
>()("t3/push/ApnsProviderTokens") {}

interface CachedProviderToken {
  readonly jwt: string;
  readonly issuedAtUnixSeconds: number;
}

const tokenCache = new Map<string, CachedProviderToken>();

export function __resetApnsProviderTokenCacheForTest(): void {
  tokenCache.clear();
}

// Quantize iat to the reuse window so the token's age stays under APNs'
// 60-minute limit and we mint exactly one provider token per window.
export function quantizedApnsJwtIssuedAt(nowUnixSeconds: number): number {
  return Math.floor(nowUnixSeconds / APNS_JWT_REUSE_SECONDS) * APNS_JWT_REUSE_SECONDS;
}

export const make = () =>
  ApnsProviderTokens.of({
    getJwt: Effect.fnUntraced(function* (input) {
      const issuedAtUnixSeconds = quantizedApnsJwtIssuedAt(input.issuedAtUnixSeconds);
      const cacheKey = apnsProviderTokenCacheKey(input);
      const cached = tokenCache.get(cacheKey);
      if (cached && cached.issuedAtUnixSeconds === issuedAtUnixSeconds) {
        return cached.jwt;
      }
      const jwt = yield* makeApnsJwt({ ...input, issuedAtUnixSeconds });
      tokenCache.set(cacheKey, { jwt, issuedAtUnixSeconds });
      return jwt;
    }),
  });

export const layer = Layer.succeed(ApnsProviderTokens, make());
