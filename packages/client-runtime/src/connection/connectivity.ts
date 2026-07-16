import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

/**
 * Opaque identifier for the active network interface (e.g. "wifi", "cellular").
 *
 * Providers that can observe the underlying link type (mobile) emit this so the
 * supervisor can detect a same-`status` interface switch — a foreground
 * wifi->cellular handoff stays `"online"` yet silently kills the live socket.
 * Kept as a plain string so this package stays free of any platform SDK.
 */
export type NetworkInterfaceType = string;

export class Connectivity extends Context.Service<
  Connectivity,
  {
    readonly status: Effect.Effect<NetworkStatus>;
    readonly changes: Stream.Stream<NetworkStatus>;
    /**
     * Optional stream of active network interface type changes, distinct from
     * connectivity `status`. Providers that cannot observe the link type omit
     * it and their supervisors behave exactly as before.
     */
    readonly interfaceChanges?: Stream.Stream<NetworkInterfaceType | undefined>;
  }
>()("@t3tools/client-runtime/connection/connectivity") {}

export const make = (service: Connectivity["Service"]) => Connectivity.of(service);

export const layer = (service: Connectivity["Service"]) =>
  Layer.succeed(Connectivity, make(service));
