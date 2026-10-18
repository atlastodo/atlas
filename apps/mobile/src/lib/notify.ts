import { setNotificationHandler } from "expo-notifications/build/NotificationsHandler";
import { setNotificationChannelAsync } from "expo-notifications/build/setNotificationChannelAsync";
import { setNotificationCategoryAsync } from "expo-notifications/build/setNotificationCategoryAsync";
import {
  getPermissionsAsync,
  requestPermissionsAsync,
} from "expo-notifications/build/NotificationPermissions";
import { scheduleNotificationAsync } from "expo-notifications/build/scheduleNotificationAsync";
import { cancelScheduledNotificationAsync } from "expo-notifications/build/cancelScheduledNotificationAsync";
import { cancelAllScheduledNotificationsAsync } from "expo-notifications/build/cancelAllScheduledNotificationsAsync";
import { dismissAllNotificationsAsync } from "expo-notifications/build/dismissAllNotificationsAsync";
import { getAllScheduledNotificationsAsync } from "expo-notifications/build/getAllScheduledNotificationsAsync";
import { AndroidImportance } from "expo-notifications/build/NotificationChannelManager.types";
import {
  SchedulableTriggerInputTypes,
  type NotificationRequest,
  type NotificationResponse,
} from "expo-notifications/build/Notifications.types";
import {
  addNotificationResponseReceivedListener,
  getLastNotificationResponse,
  clearLastNotificationResponse,
} from "expo-notifications/build/NotificationsEmitter";
import { AppState, Platform } from "react-native";
import i18n from "../i18n";
import type { ScheduleIO } from "@atlastodo/shared";
import { ExactAlarm } from "../../modules/atlas-exact-alarm";
import {
  REMINDER_CATEGORY_ID,
  REMINDER_COMPLETE_ACTION,
  REMINDER_SNOOZE_ACTION,
  type NotifyPermission,
  type ReminderResponse,
} from "./reminderActions";

/**
 * Notifications for native mobile through `expo-notifications`: a reminder handed to the OS fires
 * even when the app is closed. Notification ids are the reminder's own id. Every function is
 * best-effort and never throws, so a failure cannot break the reminder loop or a render.
 */

/** The Android channel reminders post to. Android 8+ drops notifications posted to no channel. */
const CHANNEL_ID = "reminders";

/**
 * The single identifier the focus timer schedules its phase-end alert under, so a reschedule
 * replaces the pending alert, and the foreground handler below can recognise it.
 */
export const FOCUS_PHASE_ID = "atlas.focus.phase";

/**
 * Show notifications in the foreground too: without a handler the OS suppresses them. Registered at
 * module load so it is set before any notification can arrive.
 */
setNotificationHandler({
  handleNotification: async (notification) => ({
    shouldShowBanner: true,
    shouldShowList: true,
    // The focus timer plays its own chime when a phase ends, so its banner is silent.
    shouldPlaySound: notification.request.identifier !== FOCUS_PHASE_ID,
    shouldSetBadge: false,
  }),
});

const permissionListeners = new Set<() => void>();

/** The UI language the channel and category were last registered in; null before the first time. */
let setupLanguage: string | null = null;

/**
 * Register the Android channel and the Complete / Snooze category, once per UI language: both carry
 * localized text the OS renders verbatim. Every path that books or asks goes through here first. A
 * failed registration is retried by the next call.
 */
export async function ensureNotificationSetup(): Promise<void> {
  const language = i18n.language;
  if (setupLanguage === language) return;
  // Claimed before the awaits, so concurrent callers do not register twice.
  setupLanguage = language;
  let ok = true;
  if (Platform.OS === "android") {
    try {
      await setNotificationChannelAsync(CHANNEL_ID, {
        name: i18n.t("notify.channelName"),
        importance: AndroidImportance.DEFAULT,
      });
    } catch {
      ok = false;
    }
  }
  if (!(await registerReminderCategory())) ok = false;
  if (!ok && setupLanguage === language) setupLanguage = null;
}

// Re-register on a language change so the next banner's buttons are in the new language.
try {
  i18n.on("languageChanged", () => {
    if (setupLanguage !== null) void ensureNotificationSetup();
  });
} catch {
  // Best-effort: the next booking re-registers anyway.
}

/**
 * Ask for notification permission (idempotent). Prompts, so call it from explicit UI only; the
 * schedulers just read it ({@link readNotifyPermission}).
 */
export async function ensureNotifyPermission(): Promise<boolean> {
  let granted = false;
  try {
    // Android 13+ shows the permission prompt only once a channel exists.
    await ensureNotificationSetup();
    const current = await getPermissionsAsync();
    if (current.granted) return true;
    // Denied for good: asking again would no-op.
    if (!current.canAskAgain) return false;
    granted = (await requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
  for (const listener of [...permissionListeners]) listener();
  return granted;
}

/** Where notification permission stands now. Never prompts. */
export async function readNotifyPermission(): Promise<NotifyPermission> {
  try {
    const current = await getPermissionsAsync();
    if (current.granted) return "granted";
    return current.status === "undetermined" ? "default" : "denied";
  } catch {
    return "unsupported";
  }
}

/**
 * Call `listener` whenever the permission may have changed: answered through
 * {@link ensureNotifyPermission}, or changed in OS settings (seen when the app returns to the
 * foreground). Returns an unsubscribe.
 */
export function onNotifyPermissionChange(listener: () => void): () => void {
  permissionListeners.add(listener);
  let subscription: { remove: () => void } | null = null;
  try {
    subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") listener();
    });
  } catch {
    // Best-effort: prompts answered in-app still come through the set above.
  }
  return () => {
    permissionListeners.delete(listener);
    subscription?.remove();
  };
}

/**
 * Whether the OS fires a booked reminder on time. Android 12+ needs exact-alarm access for that;
 * without it expo-notifications books an inexact alarm that Doze can hold back by ~10 minutes.
 * `unsupported` where the question does not arise (iOS, Android before 12, no native module).
 */
export function readExactAlarms(): "granted" | "denied" | "unsupported" {
  if (!ExactAlarm) return "unsupported";
  try {
    return ExactAlarm.canScheduleExactAlarms() ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

/** Open this app's "Alarms & reminders" settings page. Resolves to whether it opened. */
export async function openExactAlarmSettings(): Promise<boolean> {
  try {
    return (await ExactAlarm?.openExactAlarmSettingsAsync()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Register the Complete / Snooze category with localized button titles. A failure only costs the
 * banner its buttons. Resolves to whether it registered.
 */
async function registerReminderCategory(): Promise<boolean> {
  try {
    await setNotificationCategoryAsync(REMINDER_CATEGORY_ID, [
      {
        identifier: REMINDER_COMPLETE_ACTION,
        buttonTitle: i18n.t("reminder.actionComplete"),
        // `false` would mean the OS never wakes the app for the press.
        options: { opensAppToForeground: true },
      },
      {
        identifier: REMINDER_SNOOZE_ACTION,
        buttonTitle: i18n.t("reminder.actionSnooze"),
        options: { opensAppToForeground: true },
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Show a notification now. `tag` is ignored here; native dedup rides the reminder's fired stamp. */
export async function notify(title: string, body?: string, _tag?: string): Promise<void> {
  try {
    await scheduleNotificationAsync({
      content: { title, ...(body ? { body } : {}) },
      trigger: null,
    });
  } catch {
    // Best-effort.
  }
}

/**
 * Schedule a local notification at an absolute instant (Unix ms), even if the app is closed.
 * Re-scheduling the same `id` replaces the old one. `options` carries what only task reminders use
 * (the Complete / Snooze category and a `data` payload), so the focus alert stays non-interactive.
 */
export async function scheduleNotification(
  title: string,
  body: string,
  at: number,
  id: string,
  options?: { categoryIdentifier?: string; data?: Record<string, string> },
): Promise<void> {
  try {
    await scheduleNotificationAsync({
      identifier: id,
      content: {
        title,
        ...(body ? { body } : {}),
        ...(options?.categoryIdentifier ? { categoryIdentifier: options.categoryIdentifier } : {}),
        ...(options?.data ? { data: options.data } : {}),
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: at,
        ...(Platform.OS === "android" ? { channelId: CHANNEL_ID } : {}),
      },
    });
  } catch {
    // Best-effort: must never break the reminder reconcile loop.
  }
}

/** Cancel a previously {@link scheduleNotification}-ed local notification. */
export async function cancelScheduled(id: string): Promise<void> {
  try {
    await cancelScheduledNotificationAsync(id);
  } catch {
    // Best-effort: an id the OS no longer knows is not an error.
  }
}

/** The id prefix of habit nudges (`habitReminderId` in `@atlastodo/shared`). */
const HABIT_ID_PREFIX = "habit:";

/** Which of this app's schedulers booked a pending notification, or null for anything else. */
function bookedKind(request: NotificationRequest): "reminder" | "habit" | null {
  const id = request.identifier;
  if (id === FOCUS_PHASE_ID) return null;
  if (id.startsWith(HABIT_ID_PREFIX)) return "habit";
  const data = request.content.data as { reminderId?: unknown } | null | undefined;
  if (
    request.content.categoryIdentifier === REMINDER_CATEGORY_ID ||
    typeof data?.reminderId === "string"
  ) {
    return "reminder";
  }
  return null;
}

/**
 * Ids of the notifications of one kind still pending with the OS, including those an earlier launch
 * booked. Empty when the OS cannot be asked.
 */
export async function bookedNotificationIds(kind: "reminder" | "habit"): Promise<string[]> {
  try {
    const pending = await getAllScheduledNotificationsAsync();
    return pending.filter((r) => bookedKind(r) === kind).map((r) => r.identifier);
  } catch {
    return [];
  }
}

let generation = 0;
const resetListeners = new Set<() => void>();

/**
 * A counter that changes whenever every notification is cancelled. A reconcile captures it before
 * its awaits and books nothing if it moved: its session has ended.
 */
export function notificationGeneration(): number {
  return generation;
}

/** Subscribe to {@link cancelAllAppNotifications}, for state tied to the notifications it cancels. */
export function onNotificationsReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/**
 * Cancel everything this app has booked with the OS and clear what it already posted. Called when
 * the session ends: they carry the signed-out user's plaintext and must not surface for whoever
 * signs in next.
 */
export async function cancelAllAppNotifications(): Promise<void> {
  generation++;
  for (const listener of [...resetListeners]) {
    try {
      listener();
    } catch {
      // One subscriber failing must not keep the notifications alive.
    }
  }
  try {
    await cancelAllScheduledNotificationsAsync();
  } catch {
    // Best-effort, like every call here.
  }
  try {
    await dismissAllNotificationsAsync();
  } catch {
    // Best-effort.
  }
}

/**
 * The {@link ScheduleIO} sink for `reconcileNotifications` (`@atlastodo/shared`). The reconciler is
 * sync and the expo API async, so calls are not awaited; both operations are idempotent.
 */
export const scheduleIO: ScheduleIO = {
  schedule: (title, body, at, id) => void scheduleNotification(title, body, at, id),
  cancel: (id) => void cancelScheduled(id),
};

/**
 * The {@link ScheduleIO} sink for task reminders: like {@link scheduleIO}, but each notification
 * carries {@link REMINDER_CATEGORY_ID} (the Complete / Snooze buttons) and a `data` payload naming
 * the reminder. Habit nudges stay on the plain sink: a habit has no task to complete.
 */
export const reminderScheduleIO: ScheduleIO = {
  schedule: (title, body, at, id) =>
    void scheduleNotification(title, body, at, id, {
      categoryIdentifier: REMINDER_CATEGORY_ID,
      data: { reminderId: id },
    }),
  cancel: (id) => void cancelScheduled(id),
};

/**
 * Reduce a raw notification response to a {@link ReminderResponse}, or null when it is not ours:
 * only the category's two actions pass, so a plain banner tap is dropped. The reminder comes from
 * `data`, falling back to the request identifier when the data did not round-trip the OS.
 */
function toReminderResponse(response: NotificationResponse): ReminderResponse | null {
  if (
    response.actionIdentifier !== REMINDER_COMPLETE_ACTION &&
    response.actionIdentifier !== REMINDER_SNOOZE_ACTION
  ) {
    return null;
  }
  const data = response.notification.request.content.data as { reminderId?: unknown } | undefined;
  const reminderId =
    typeof data?.reminderId === "string"
      ? data.reminderId
      : response.notification.request.identifier;
  if (!reminderId) return null;
  return {
    reminderId,
    actionIdentifier: response.actionIdentifier,
    notificationDate: response.notification.date,
  };
}

/** Subscribe to reminder action presses while the app is alive. Returns an unsubscribe. */
export function onReminderResponse(handler: (response: ReminderResponse) => void): () => void {
  try {
    const subscription = addNotificationResponseReceivedListener((response) => {
      const parsed = toReminderResponse(response);
      if (parsed) handler(parsed);
    });
    return () => subscription.remove();
  } catch {
    return () => {};
  }
}

/**
 * The reminder response the app was launched from, if any: the cold-start case, where no listener
 * was alive to catch the press. Read once at startup, then cleared
 * ({@link clearLaunchReminderResponse}).
 */
export function launchReminderResponse(): ReminderResponse | null {
  try {
    const response = getLastNotificationResponse();
    return response ? toReminderResponse(response) : null;
  } catch {
    return null;
  }
}

/** Forget the cached launch response so it is never acted on twice. Best-effort. */
export function clearLaunchReminderResponse(): void {
  try {
    clearLastNotificationResponse();
  } catch {
    // Best-effort.
  }
}
