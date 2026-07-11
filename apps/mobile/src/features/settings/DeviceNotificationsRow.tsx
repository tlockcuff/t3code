import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, Linking } from "react-native";

import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { runtime } from "../../lib/runtime";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";

// Reflects whether this device's registration was actually accepted (relay or
// self-hosted server). The switch reads as enabled only when both iOS
// permission is granted AND registration succeeded, so it never claims to be on
// when nothing can be delivered.
function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

// Encapsulates the Device Notifications permission + registration flow so both
// the cloud-configured and local settings screens present an identical toggle.
// Depends only on expo-notifications + agent-awareness registration — no Clerk —
// so it works for self-hosted (non-cloud) setups.
export function useDeviceNotificationsToggle() {
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>("checking");
  const deviceRegistered = useDeviceRegistered();

  const refreshNotifications = useCallback(async () => {
    if (process.env.EXPO_OS !== "ios") {
      setNotificationStatus("unsupported");
      return;
    }
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      setNotificationStatus("disabled");
      return;
    }
    setNotificationStatus(result.value.granted ? "enabled" : "disabled");
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  const requestNotifications = useCallback(async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Notifications unavailable",
          error instanceof Error ? error.message : "Could not request notification permission.",
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (getAgentAwarenessRegistrationStatus() === "registered") {
        Alert.alert("Notifications enabled", "Notifications are enabled for this device.");
      } else {
        Alert.alert(
          "Couldn't finish enabling notifications",
          "Notification access was granted, but this device could not be registered yet. Notifications will start once registration succeeds.",
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Alert.alert("Notifications unavailable", "Notifications are only available on iOS.");
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Alert.alert("Notifications disabled", "Notifications were not enabled.");
      return;
    }
    Alert.alert(
      "Notifications disabled",
      "Notifications were denied for this app. Open Settings to enable them.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  }, []);

  const onValueChange = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void requestNotifications();
        return;
      }
      Alert.alert(
        "Disable notifications",
        "Notification permission is controlled by iOS. Open Settings to disable notifications for T3 Code.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Open Settings", onPress: () => void Linking.openSettings() },
        ],
      );
    },
    [requestNotifications],
  );

  return {
    notificationStatus,
    deviceRegistered,
    onValueChange,
  };
}

// The Device Notifications switch row. Reusable across settings screens.
export function DeviceNotificationsRow() {
  const { notificationStatus, deviceRegistered, onValueChange } = useDeviceNotificationsToggle();
  return (
    <SettingsSwitchRow
      icon="bell.badge"
      label="Device Notifications"
      disabled={notificationStatus === "checking" || notificationStatus === "unsupported"}
      value={notificationStatus === "enabled" && deviceRegistered}
      onValueChange={onValueChange}
    />
  );
}
