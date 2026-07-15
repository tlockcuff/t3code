import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

/**
 * - `application-active`: short foreground flicker or brief background. Probe the
 *   live session and republish it so durable subscriptions catch up.
 * - `application-resume`: longer background (common on mobile + Tailscale/VPN).
 *   Force a full reconnect — half-open sockets often look alive until they hang.
 * - `credentials-changed`: cloud/session credentials rotated; restart paths that
 *   depend on them (managed relay).
 */
export type ConnectionWakeup = "application-active" | "application-resume" | "credentials-changed";

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
