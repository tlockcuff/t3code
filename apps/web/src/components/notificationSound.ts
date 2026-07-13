/**
 * Notification sound playback.
 *
 * One cached `Audio` element per sound, so repeated notifications don't
 * allocate. `play()` is deliberately not awaited by callers, but rejections
 * are swallowed here: autoplay policy rejects playback until the page has seen
 * a user gesture, and an unhandled rejection for a missed ding is noise.
 */
import type { NotificationSound } from "@t3tools/contracts/settings";

import { notificationSoundUrl } from "./AgentNotifier.logic";

const audioBySound = new Map<NotificationSound, HTMLAudioElement>();

function getAudio(sound: NotificationSound): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }
  const cached = audioBySound.get(sound);
  if (cached) {
    return cached;
  }
  const audio = new Audio(notificationSoundUrl(sound));
  audio.preload = "auto";
  audioBySound.set(sound, audio);
  return audio;
}

export async function playNotificationSound(input: {
  readonly sound: NotificationSound;
  readonly volume: number;
}): Promise<void> {
  const audio = getAudio(input.sound);
  if (!audio) {
    return;
  }
  audio.volume = Math.min(1, Math.max(0, input.volume));
  // Rewind so a burst of notifications retriggers instead of no-oping on an
  // already-playing element.
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch {
    // Autoplay blocked, or the element was interrupted. Nothing actionable.
  }
}
