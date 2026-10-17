import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useTranslation } from "react-i18next";
import {
  reconcileNotifications,
  reminderBody,
  reminderTitle,
  splitDueReminders,
} from "@atlastodo/shared";
import {
  bookedNotificationIds,
  clearLaunchReminderResponse,
  ensureNotificationSetup,
  launchReminderResponse,
  notificationGeneration,
  notify,
  onReminderResponse,
  reminderScheduleIO,
} from "../lib/notify";
import { planReminderResponse, type ReminderResponse } from "../lib/reminderActions";
import { useStore } from "../data/StoreProvider";
import { useLocalTasks } from "./useLocalTasks";
import { usePreferences } from "./usePreferences";
import { useExactAlarms, useNotifyPermission, useReminders } from "./useReminders";

/** How often to check for due reminders while the tab is open (web in-app path). */
const WEB_INTERVAL_MS = 30_000;

/**
 * Delivers reminder notifications, gated on the `remindersEnabled` preference and the OS
 * permission, which it only reads (prompting belongs to explicit UI). Mount once at the app root.
 *
 * - Native: future reminders are handed to the OS as scheduled local notifications (no FCM or
 *   server push, so the app stays self-hostable), reconciled through `@atlastodo/shared`'s
 *   `reconcileNotifications` against a ref of what is scheduled. Switching reminders off cancels
 *   everything booked; a sign-out cancels app-wide and a run in flight then books nothing. Banners
 *   carry Complete / Snooze buttons, whose presses this hook handles.
 * - Web: a browser cannot schedule a closed-tab notification, so an in-app interval fires each
 *   reminder once while the tab is open (`markFired`). One over `REMINDER_STALE_AFTER_MS` late is
 *   stamped without a notification.
 *
 * @param actorId Current user id, so a Complete pressed from a notification is attributed like one
 *   pressed in a list.
 */
export function useReminderScheduler(actorId?: string): void {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { initialSyncDone } = useStore();
  const { remindersEnabled, timezone } = usePreferences();
  // "" follows the device; all-day reminders resolve their 09:00 in this zone.
  const timeZone = timezone || undefined;
  const { reminders, markFired, snoozeReminder } = useReminders();
  const { tasks, toggle } = useLocalTasks(actorId);
  // Native only: reminderId -> the fire instant scheduled with the OS.
  const scheduledRef = useRef<Map<string, number>>(new Map());
  // What an earlier launch left booked with the OS, read and adopted once per mount.
  const bookedRef = useRef<Promise<string[]> | null>(null);
  const adoptedRef = useRef(false);
  // Native only: the UI language the OS holds the bookings' text in.
  const bookedLanguageRef = useRef<string | null>(null);
  // Native only: whether the OS held exact-alarm access when the bookings were made.
  const bookedExactRef = useRef<boolean | null>(null);
  const isWeb = Platform.OS === "web";
  const { permission } = useNotifyPermission();
  const canNotify = permission === "granted";
  const exact = useExactAlarms().exactAlarms !== "denied";

  // Web interval scheduler. Permission is a dependency, so granting it starts delivery at once.
  useEffect(() => {
    if (!isWeb || !remindersEnabled || !canNotify || !initialSyncDone) return;
    const titles = {
      lockedTitle: t("notify.lockedTitle"),
      fallbackTitle: t("notify.reminderTitle"),
    };
    const tick = () => {
      const now = Date.now();
      const { fire, stale } = splitDueReminders(reminders, tasks, now, timeZone);
      for (const r of fire) {
        const task = tasks.find((x) => x.id === r.task_id);
        void notify(reminderTitle(task, titles), reminderBody(task), r.id);
        markFired(r.id, now);
      }
      // Too late to be news (a phone delivered it, or it passed with no tab open): stamp it only.
      for (const r of stale) markFired(r.id, now);
    };
    tick();
    const handle = setInterval(tick, WEB_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [
    isWeb,
    remindersEnabled,
    canNotify,
    initialSyncDone,
    reminders,
    tasks,
    markFired,
    timeZone,
    t,
  ]);

  // Native: reconcile OS-scheduled notifications so reminders fire when the app is closed.
  useEffect(() => {
    if (isWeb) return;
    const scheduled = scheduledRef.current;
    // A run superseded by a newer one, or overtaken by a sign-out, books nothing.
    let stale = false;
    const cleanup = () => {
      stale = true;
    };
    if (!remindersEnabled) {
      // Switched off: take back everything booked, including an earlier launch's, or it still fires.
      for (const id of scheduled.keys()) reminderScheduleIO.cancel(id);
      scheduled.clear();
      void bookedNotificationIds("reminder").then((ids) => {
        if (!stale) for (const id of ids) reminderScheduleIO.cancel(id);
      });
      return cleanup;
    }
    if (!initialSyncDone || !canNotify) return;
    const generation = notificationGeneration();
    const plan = {
      timeZone,
      lockedTitle: t("notify.lockedTitle"),
      fallbackTitle: t("notify.reminderTitle"),
    };
    const body = t("notify.reminderBody");
    void (async () => {
      await ensureNotificationSetup();
      bookedRef.current ??= bookedNotificationIds("reminder");
      const booked = await bookedRef.current;
      if (stale || generation !== notificationGeneration()) return;
      // The first reconcile adopts an earlier launch's bookings, so one whose reminder was deleted
      // or completed while the app was closed is cancelled.
      const adopt = !adoptedRef.current;
      adoptedRef.current = true;
      // A language change moves no fire time, so the diff alone would leave banners in the old
      // language: book them all again.
      // Exact-alarm access is read when a booking is made: those made without it stay inexact
      // (Doze holds them ~10 minutes), so book them all again once it is granted.
      const rebook =
        (bookedLanguageRef.current !== null && bookedLanguageRef.current !== language) ||
        (bookedExactRef.current === false && exact);
      bookedLanguageRef.current = language;
      bookedExactRef.current = exact;
      reconcileNotifications(
        reminders,
        tasks,
        Date.now(),
        scheduled,
        body,
        reminderScheduleIO,
        adopt ? { ...plan, booked, rebook } : { ...plan, rebook },
      );
    })();
    return cleanup;
  }, [
    isWeb,
    remindersEnabled,
    initialSyncDone,
    canNotify,
    reminders,
    tasks,
    timeZone,
    t,
    language,
    exact,
  ]);

  // Native: handle a Complete / Snooze press. Subscribed once (the handler rides a ref to see fresh
  // state) and not gated on `remindersEnabled`: a press is an explicit instruction on an existing
  // notification. `planReminderResponse` ignores a completed or deleted task, so a stale banner is safe.
  const responseHandlerRef = useRef<(response: ReminderResponse) => void>(() => {});
  const lastResponseKeyRef = useRef<string | null>(null);

  const handleResponse = useCallback(
    (response: ReminderResponse) => {
      // The OS can deliver one press twice (cached for the launch read, and to a listener); the two
      // arrive back to back, so one slot suffices.
      const key = `${response.actionIdentifier}:${response.reminderId}:${response.notificationDate}`;
      if (lastResponseKeyRef.current === key) return;
      lastResponseKeyRef.current = key;

      const plan = planReminderResponse(response, { reminders, tasks, now: Date.now() });
      if (plan.kind === "complete") {
        // Same write path as completing from a list. Stamping the reminder fired keeps the
        // scheduler, or a later reopen of the task, from re-firing the old notification.
        toggle(plan.task);
        markFired(response.reminderId, Date.now());
      } else if (plan.kind === "snooze") {
        // The reconcile effect picks up the moved fire time and reschedules the OS notification.
        snoozeReminder(plan.reminderId, plan.at);
      }
    },
    [reminders, tasks, toggle, markFired, snoozeReminder],
  );
  responseHandlerRef.current = handleResponse;

  useEffect(() => {
    if (isWeb) return;
    // Cold start: the OS may have launched the app because of a press no listener caught.
    const launch = launchReminderResponse();
    if (launch) responseHandlerRef.current(launch);
    clearLaunchReminderResponse();
    return onReminderResponse((response) => responseHandlerRef.current(response));
  }, [isWeb]);
}
