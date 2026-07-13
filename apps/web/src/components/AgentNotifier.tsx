/**
 * Fires desktop notifications and a sound when an agent needs attention.
 *
 * Mounted once, globally. Watches every thread shell across environments and
 * reacts to phase edges (see AgentNotifier.logic.ts for the decision rules).
 */
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";

import { useClientSettings } from "../hooks/useSettings";
import { useProjects, useThreadShells } from "../state/entities";
import {
  type AgentNotification,
  buildProjectTitleMap,
  resolveAgentNotifications,
  type ThreadPhaseMap,
} from "./AgentNotifier.logic";
import { playNotificationSound } from "./notificationSound";
import { isAppFocused, showDesktopNotification, subscribeAppFocus } from "./desktopNotifications";

const EMPTY_PHASES: ThreadPhaseMap = new Map();

function selectNotificationSettings(settings: ClientSettings) {
  return {
    notificationSoundEnabled: settings.notificationSoundEnabled,
    notificationSound: settings.notificationSound,
    notificationVolume: settings.notificationVolume,
    desktopNotificationsEnabled: settings.desktopNotificationsEnabled,
    notifyOnCompletion: settings.notifyOnCompletion,
    notifyOnApproval: settings.notifyOnApproval,
    notifyOnInput: settings.notifyOnInput,
    notifyOnFailure: settings.notifyOnFailure,
  };
}

export function AgentNotifier() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const settings = useClientSettings(selectNotificationSettings);

  const phasesRef = useRef<ThreadPhaseMap>(EMPTY_PHASES);
  const seededRef = useRef(false);
  // Focus is read at notify time rather than subscribed as state: re-rendering
  // this component on every focus change would be pure overhead, and a stale
  // focus value would misfire notifications.
  const focusedRef = useRef(true);

  useEffect(() => {
    focusedRef.current = isAppFocused();
    return subscribeAppFocus((focused) => {
      focusedRef.current = focused;
    });
  }, []);

  const openThread = useCallback(
    (notification: AgentNotification) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: notification.environmentId,
          threadId: notification.threadId,
        },
      }).catch(() => undefined);
    },
    [navigate],
  );

  useEffect(() => {
    const anyChannelEnabled =
      settings.notificationSoundEnabled || settings.desktopNotificationsEnabled;

    const { notifications, nextPhases } = resolveAgentNotifications({
      threads,
      projectTitlesByRef: buildProjectTitleMap(projects),
      previousPhases: phasesRef.current,
      settings,
      appFocused: focusedRef.current,
      seeded: seededRef.current,
    });

    // Always advance the phase map, even while notifications are off. Otherwise
    // enabling the setting mid-session would replay every already-settled
    // thread as a fresh edge.
    phasesRef.current = nextPhases;
    seededRef.current = true;

    if (!anyChannelEnabled || notifications.length === 0) {
      return;
    }

    if (settings.notificationSoundEnabled) {
      void playNotificationSound({
        sound: settings.notificationSound,
        volume: settings.notificationVolume,
      });
    }

    if (settings.desktopNotificationsEnabled) {
      for (const notification of notifications) {
        showDesktopNotification({
          tag: `${notification.environmentId}::${notification.threadId}`,
          title: notification.title,
          body: notification.body,
          onClick: () => openThread(notification),
        });
      }
    }
  }, [openThread, projects, settings, threads]);

  return null;
}
