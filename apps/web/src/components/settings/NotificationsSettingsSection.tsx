import { BellIcon, Volume2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

import {
  NOTIFICATION_SOUND_OPTIONS,
  type NotificationTriggerSettings,
} from "../AgentNotifier.logic";
import {
  type DesktopNotificationPermission,
  desktopNotificationsSupported,
  getDesktopNotificationPermission,
  requestDesktopNotificationPermission,
} from "../desktopNotifications";
import { playNotificationSound } from "../notificationSound";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const TRIGGER_ROWS: ReadonlyArray<{
  readonly key: keyof NotificationTriggerSettings;
  readonly label: string;
}> = [
  { key: "notifyOnCompletion", label: "Agent finishes" },
  { key: "notifyOnApproval", label: "Approval needed" },
  { key: "notifyOnInput", label: "Waiting for input" },
  { key: "notifyOnFailure", label: "Agent fails" },
];

const VOLUME_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 0.25, label: "Quiet" },
  { value: 0.5, label: "Medium" },
  { value: 1, label: "Loud" },
];

function volumeLabel(volume: number): string {
  // Nearest bucket, so a value persisted before this UI existed still renders.
  return VOLUME_OPTIONS.reduce((closest, option) =>
    Math.abs(option.value - volume) < Math.abs(closest.value - volume) ? option : closest,
  ).label;
}

export function NotificationsSettingsSection({
  settings,
  updateSettings,
}: {
  settings: UnifiedSettings;
  updateSettings: (patch: Partial<UnifiedSettings>) => void;
}) {
  const [permission, setPermission] = useState<DesktopNotificationPermission>(() =>
    getDesktopNotificationPermission(),
  );

  // Permission can change outside the app (browser site settings, macOS
  // notification settings), so re-read it when the tab regains focus.
  useEffect(() => {
    const sync = () => setPermission(getDesktopNotificationPermission());
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  const handleDesktopToggle = useCallback(
    async (checked: boolean) => {
      if (!checked) {
        updateSettings({ desktopNotificationsEnabled: false });
        return;
      }

      // Enabling is the user gesture the browser requires for the prompt, so
      // request here rather than behind a separate button.
      const next = await requestDesktopNotificationPermission();
      setPermission(next);
      updateSettings({ desktopNotificationsEnabled: next === "granted" });
    },
    [updateSettings],
  );

  const anyChannelEnabled =
    settings.notificationSoundEnabled || settings.desktopNotificationsEnabled;

  return (
    <SettingsSection title="Notifications" icon={<BellIcon className="size-3.5" />}>
      <SettingsRow
        title="Notification sound"
        description="Play a sound when an agent needs you and the app is not focused."
        control={
          <Switch
            checked={settings.notificationSoundEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ notificationSoundEnabled: Boolean(checked) })
            }
            aria-label="Play a sound when an agent needs attention"
          />
        }
      />

      {settings.notificationSoundEnabled ? (
        <SettingsRow
          title="Sound"
          description="Pick the alert tone, then preview it at the current volume."
          resetAction={
            settings.notificationSound !== DEFAULT_UNIFIED_SETTINGS.notificationSound ||
            settings.notificationVolume !== DEFAULT_UNIFIED_SETTINGS.notificationVolume ? (
              <SettingResetButton
                label="notification sound"
                onClick={() =>
                  updateSettings({
                    notificationSound: DEFAULT_UNIFIED_SETTINGS.notificationSound,
                    notificationVolume: DEFAULT_UNIFIED_SETTINGS.notificationVolume,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Select
                value={volumeLabel(settings.notificationVolume)}
                onValueChange={(value) => {
                  const option = VOLUME_OPTIONS.find((entry) => entry.label === value);
                  if (!option) return;
                  updateSettings({ notificationVolume: option.value });
                  void playNotificationSound({
                    sound: settings.notificationSound,
                    volume: option.value,
                  });
                }}
              >
                <SelectTrigger className="w-full sm:w-28" aria-label="Notification volume">
                  <SelectValue>{volumeLabel(settings.notificationVolume)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {VOLUME_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.label} value={option.label}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={settings.notificationSound}
                onValueChange={(value) => {
                  const option = NOTIFICATION_SOUND_OPTIONS.find((entry) => entry.value === value);
                  if (!option) return;
                  updateSettings({ notificationSound: option.value });
                  void playNotificationSound({
                    sound: option.value,
                    volume: settings.notificationVolume,
                  });
                }}
              >
                <SelectTrigger className="w-full sm:w-32" aria-label="Notification sound">
                  <SelectValue>
                    {
                      NOTIFICATION_SOUND_OPTIONS.find(
                        (option) => option.value === settings.notificationSound,
                      )?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {NOTIFICATION_SOUND_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Preview notification sound"
                onClick={() =>
                  void playNotificationSound({
                    sound: settings.notificationSound,
                    volume: settings.notificationVolume,
                  })
                }
              >
                <Volume2Icon className="size-4" />
              </Button>
            </div>
          }
        />
      ) : null}

      <SettingsRow
        title="Desktop notifications"
        description={
          permission === "unsupported"
            ? "This browser does not support desktop notifications."
            : permission === "denied"
              ? "Notifications are blocked. Allow them in your browser or system settings, then re-enable here."
              : "Show an OS notification when an agent needs you and the app is not focused."
        }
        control={
          <Switch
            checked={settings.desktopNotificationsEnabled && permission === "granted"}
            disabled={permission === "unsupported" || permission === "denied"}
            onCheckedChange={(checked) => {
              void handleDesktopToggle(Boolean(checked));
            }}
            aria-label="Show desktop notifications when an agent needs attention"
          />
        }
      />

      {anyChannelEnabled ? (
        <SettingsRow
          title="Notify me when"
          description="Choose which agent events are worth interrupting you for."
          control={
            <div className="flex flex-col gap-2 sm:items-end">
              {TRIGGER_ROWS.map((row) => (
                <label
                  key={row.key}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <span className="w-32 text-right">{row.label}</span>
                  <Switch
                    checked={settings[row.key]}
                    onCheckedChange={(checked) => updateSettings({ [row.key]: Boolean(checked) })}
                    aria-label={`Notify when ${row.label.toLowerCase()}`}
                  />
                </label>
              ))}
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

export { desktopNotificationsSupported };
