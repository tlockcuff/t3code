/**
 * Decides when an agent deserves the user's attention, and on which channels.
 *
 * The shell stream re-emits a whole thread on every orchestration event, so
 * the same phase arrives many times. Notifications must fire on the *edge*
 * into a notify-worthy phase, never on the re-delivery — hence the phase map
 * threaded through `resolveAgentNotifications`, which returns the next map
 * alongside the notifications to fire.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ClientSettings, NotificationSound } from "@t3tools/contracts/settings";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type AgentAwarenessPhase, projectThreadAwareness } from "@t3tools/shared/agentAwareness";

/** Phases worth pulling the user back to the app for. */
export type NotifiablePhase = "completed" | "failed" | "waiting_for_approval" | "waiting_for_input";

const NOTIFIABLE_PHASES: ReadonlySet<AgentAwarenessPhase> = new Set<AgentAwarenessPhase>([
  "completed",
  "failed",
  "waiting_for_approval",
  "waiting_for_input",
]);

export function isNotifiablePhase(phase: AgentAwarenessPhase): phase is NotifiablePhase {
  return NOTIFIABLE_PHASES.has(phase);
}

export interface AgentNotification {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly phase: NotifiablePhase;
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
}

/** Phase snapshot per thread, keyed by `${environmentId}::${threadId}`. */
export type ThreadPhaseMap = ReadonlyMap<string, AgentAwarenessPhase>;

export function threadPhaseKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}::${threadId}`;
}

export type NotificationTriggerSettings = Pick<
  ClientSettings,
  "notifyOnCompletion" | "notifyOnApproval" | "notifyOnInput" | "notifyOnFailure"
>;

export function isPhaseEnabled(
  phase: NotifiablePhase,
  settings: NotificationTriggerSettings,
): boolean {
  switch (phase) {
    case "completed":
      return settings.notifyOnCompletion;
    case "failed":
      return settings.notifyOnFailure;
    case "waiting_for_approval":
      return settings.notifyOnApproval;
    case "waiting_for_input":
      return settings.notifyOnInput;
  }
}

export interface ResolveAgentNotificationsInput {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectTitlesByRef: ReadonlyMap<string, string>;
  readonly previousPhases: ThreadPhaseMap;
  readonly settings: NotificationTriggerSettings;
  /**
   * Notifications only fire when the app is out of focus — the whole point is
   * to draw attention back, and a visible window needs no drawing back to.
   * The sidebar pill and toast already cover the in-app case.
   */
  readonly appFocused: boolean;
  /**
   * First pass after mount has no prior phases to diff against, so every
   * already-finished thread would look like a fresh completion. Seed the map
   * and stay silent.
   */
  readonly seeded: boolean;
}

export interface ResolveAgentNotificationsResult {
  readonly notifications: ReadonlyArray<AgentNotification>;
  readonly nextPhases: ThreadPhaseMap;
}

export function projectRefKey(environmentId: EnvironmentId, projectId: string): string {
  return `${environmentId}::${projectId}`;
}

export function buildProjectTitleMap(
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyMap<string, string> {
  return new Map(
    projects.map((project) => [projectRefKey(project.environmentId, project.id), project.title]),
  );
}

export function resolveAgentNotifications(
  input: ResolveAgentNotificationsInput,
): ResolveAgentNotificationsResult {
  const nextPhases = new Map<string, AgentAwarenessPhase>();
  const notifications: AgentNotification[] = [];

  for (const thread of input.threads) {
    const projectTitle =
      input.projectTitlesByRef.get(projectRefKey(thread.environmentId, thread.projectId)) ?? "";
    const awareness = projectThreadAwareness({
      environmentId: thread.environmentId,
      project: { title: projectTitle },
      thread,
    });
    if (!awareness) {
      continue;
    }

    const key = threadPhaseKey(thread.environmentId, thread.id);
    nextPhases.set(key, awareness.phase);

    if (!input.seeded) {
      continue;
    }
    if (input.appFocused) {
      continue;
    }
    if (!isNotifiablePhase(awareness.phase)) {
      continue;
    }
    if (input.previousPhases.get(key) === awareness.phase) {
      continue;
    }
    if (!isPhaseEnabled(awareness.phase, input.settings)) {
      continue;
    }

    notifications.push({
      environmentId: thread.environmentId,
      threadId: thread.id,
      phase: awareness.phase,
      title: awareness.headline,
      body: buildNotificationBody({
        threadTitle: awareness.threadTitle,
        projectTitle,
      }),
      deepLink: awareness.deepLink,
    });
  }

  return { notifications, nextPhases };
}

function buildNotificationBody(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): string {
  const threadTitle = input.threadTitle.trim() || "Untitled thread";
  const projectTitle = input.projectTitle.trim();
  return projectTitle ? `${threadTitle} · ${projectTitle}` : threadTitle;
}

export const NOTIFICATION_SOUND_OPTIONS: ReadonlyArray<{
  readonly value: NotificationSound;
  readonly label: string;
}> = [
  { value: "chime", label: "Chime" },
  { value: "ping", label: "Ping" },
  { value: "knock", label: "Knock" },
];

export function notificationSoundUrl(sound: NotificationSound): string {
  return `/sounds/${sound}.wav`;
}
