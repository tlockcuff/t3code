/**
 * OS desktop notifications via the web Notification API.
 *
 * Works in both the browser and the Electron renderer — Electron routes the
 * same API to native notifications, so no bridge is needed.
 */
export type DesktopNotificationPermission = "default" | "granted" | "denied" | "unsupported";

export function desktopNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!desktopNotificationsSupported()) {
    return "unsupported";
  }
  return Notification.permission;
}

/** Must be called from a user gesture — browsers reject otherwise. */
export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!desktopNotificationsSupported()) {
    return "unsupported";
  }
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function showDesktopNotification(input: {
  readonly title: string;
  readonly body: string;
  /** Collapses repeat notifications for the same thread instead of stacking them. */
  readonly tag: string;
  readonly onClick?: () => void;
}): void {
  if (getDesktopNotificationPermission() !== "granted") {
    return;
  }
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      icon: "/apple-touch-icon.png",
    });
    notification.addEventListener("click", () => {
      window.focus();
      notification.close();
      input.onClick?.();
    });
  } catch {
    // Some environments throw when constructing notifications (e.g. a browser
    // that requires a service worker registration). Never break the app for it.
  }
}

/**
 * True when the app is visible *and* focused. `document.hidden` alone is not
 * enough: a visible-but-unfocused window (side-by-side with an editor) is
 * exactly the case where an attention signal is wanted.
 */
export function isAppFocused(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return !document.hidden && document.hasFocus();
}

export function subscribeAppFocus(onChange: (focused: boolean) => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handler = () => onChange(isAppFocused());
  window.addEventListener("focus", handler);
  window.addEventListener("blur", handler);
  document.addEventListener("visibilitychange", handler);
  return () => {
    window.removeEventListener("focus", handler);
    window.removeEventListener("blur", handler);
    document.removeEventListener("visibilitychange", handler);
  };
}
