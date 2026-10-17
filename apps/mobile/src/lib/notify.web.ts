import type { ScheduleIO } from "@atlastodo/shared";
import type { NotifyPermission, ReminderResponse } from "./reminderActions";

/**
 * Web notifications through the browser `Notification` API; Metro resolves this in place of
 * `notify.ts`. A browser cannot schedule a notification for a closed tab, so {@link scheduleIO} is
 * inert and `useReminderScheduler`'s in-app interval fires reminders via {@link notify}. Everything
 * is best-effort and never throws. Exports without behaviour here exist for signature parity.
 */

const permissionListeners = new Set<() => void>();

/**
 * Ask for notification permission (idempotent). A browser only shows the prompt from a user
 * gesture, so call this from one: it is requested before the first `await`.
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  let granted = false;
  try {
    granted = (await Notification.requestPermission()) === "granted";
  } catch {
    // A browser that refuses to prompt leaves the permission where it was.
  }
  for (const listener of [...permissionListeners]) listener();
  return granted;
}

/** Nothing to register: browser notifications have no channels or action categories. */
export async function ensureNotificationSetup(): Promise<void> {}

/** Where notification permission stands now. Never prompts. */
export async function readNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  const permission = Notification.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

/**
 * Call `listener` whenever the permission may have changed: answered through
 * {@link ensureNotifyPermission}, or flipped in site settings (via the Permissions API, else on
 * returning to the tab). Returns an unsubscribe.
 */
export function onNotifyPermissionChange(listener: () => void): () => void {
  permissionListeners.add(listener);
  let stopped = false;
  let status: PermissionStatus | null = null;
  let fallbackOn = false;
  const onChange = () => {
    if (!stopped) listener();
  };
  const fallback = () => {
    if (stopped || fallbackOn || typeof window === "undefined") return;
    fallbackOn = true;
    window.addEventListener("focus", onChange);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange);
  };
  try {
    const permissions = typeof navigator === "undefined" ? undefined : navigator.permissions;
    if (!permissions?.query) {
      fallback();
    } else {
      permissions.query({ name: "notifications" as PermissionName }).then((result) => {
        if (stopped) return;
        status = result;
        result.onchange = onChange;
      }, fallback);
    }
  } catch {
    fallback();
  }
  return () => {
    stopped = true;
    permissionListeners.delete(listener);
    if (status) status.onchange = null;
    if (fallbackOn) {
      window.removeEventListener("focus", onChange);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", onChange);
    }
  };
}

/** Show a notification now. `tag` coalesces repeats for the same subject (a reminder id). */
export async function notify(title: string, body?: string, tag?: string): Promise<void> {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const notification = new Notification(title, { ...(body ? { body } : {}), tag });
      // In Electron the OS does not focus the app for renderer-created notifications, so the
      // desktop bridge does. A plain browser has no bridge.
      notification.onclick = () => {
        (
          window as unknown as { atlasDesktop?: { focusWindow?: () => void } }
        ).atlasDesktop?.focusWindow?.();
      };
    }
  } catch {
    // Best-effort: must never break the reminder loop.
  }
}

export const FOCUS_PHASE_ID = "atlas.focus.phase";

/** Inert: a browser cannot wake a closed tab, and the focus timer's own tick alerts in-app. */
export async function scheduleNotification(
  _title: string,
  _body: string,
  _at: number,
  _id: string,
): Promise<void> {}

export async function cancelScheduled(_id: string): Promise<void> {}

export function readExactAlarms(): "granted" | "denied" | "unsupported" {
  return "unsupported";
}

export async function openExactAlarmSettings(): Promise<boolean> {
  return false;
}

export async function bookedNotificationIds(_kind: "reminder" | "habit"): Promise<string[]> {
  return [];
}

let generation = 0;
const resetListeners = new Set<() => void>();

export function notificationGeneration(): number {
  return generation;
}

/** Subscribe to {@link cancelAllAppNotifications}. Returns an unsubscribe. */
export function onNotificationsReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/** Nothing is booked with an OS here, but subscribers still run so the focus run is dropped too. */
export async function cancelAllAppNotifications(): Promise<void> {
  generation++;
  for (const listener of [...resetListeners]) {
    try {
      listener();
    } catch {
      // One subscriber failing must not stop the others.
    }
  }
}

/** Inert: the in-app interval in `useReminderScheduler` does the firing. */
export const scheduleIO: ScheduleIO = {
  schedule: () => {},
  cancel: () => {},
};

// Browser notifications have no action buttons, so there are no responses to deliver; the
// scheduler checks the platform before reaching these.
export function onReminderResponse(_handler: (response: ReminderResponse) => void): () => void {
  return () => {};
}

export function launchReminderResponse(): ReminderResponse | null {
  return null;
}

export function clearLaunchReminderResponse(): void {}
