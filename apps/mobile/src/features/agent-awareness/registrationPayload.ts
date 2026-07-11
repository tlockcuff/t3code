import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";

import type { Preferences } from "../../persistence/mobile-preferences";

// The APNs environment is determined by how the build is SIGNED, not by the
// app variant: a development-signed build (Xcode "Run" to a device) always gets
// a sandbox token, a distribution-signed build gets production. By default we
// infer it from the variant (development → sandbox, else production), but an
// explicit `override` (from EXPO_PUBLIC_APNS_ENVIRONMENT) wins — so you can run
// the production variant (black icon, prod bundle id) while still dev-signing to
// your own device and correctly report the sandbox environment.
export function resolveApsEnvironment(
  appVariant: unknown,
  override?: unknown,
): "sandbox" | "production" {
  if (override === "sandbox" || override === "production") {
    return override;
  }
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeRelayDeviceRegistrationRequest(input: {
  readonly deviceId: string;
  readonly label: string;
  readonly iosMajorVersion: number;
  readonly appVersion?: string;
  readonly bundleId?: string;
  readonly apsEnvironment?: "sandbox" | "production";
  readonly pushToken?: string;
  readonly pushToStartToken?: string;
  readonly notificationsEnabled: boolean;
  readonly preferences: Preferences;
}): RelayDeviceRegistrationRequest {
  const liveActivitiesEnabled = input.preferences.liveActivitiesEnabled !== false;
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: "ios",
    iosMajorVersion: input.iosMajorVersion,
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    ...(input.pushToStartToken ? { pushToStartToken: input.pushToStartToken } : {}),
    preferences: {
      liveActivitiesEnabled,
      notificationsEnabled: input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}
