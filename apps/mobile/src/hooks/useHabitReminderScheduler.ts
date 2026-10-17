import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { adoptBooked, applySchedule, habitReminders } from "@atlastodo/shared";
import {
  bookedNotificationIds,
  ensureNotificationSetup,
  notificationGeneration,
  scheduleIO,
} from "../lib/notify";
import { useStore } from "../data/StoreProvider";
import { useHabits } from "./useHabits";
import { useHabitCheckins } from "./useHabitCheckins";
import { usePreferences } from "./usePreferences";
import { useExactAlarms, useNotifyPermission } from "./useReminders";

/**
 * Delivers per-habit nudges as OS-scheduled local notifications. Mount once at the app root.
 *
 * Gated on both `remindersEnabled` and `habitsEnabled`, and on the OS notification permission,
 * which it only reads (prompting belongs to explicit UI). Native only: a browser cannot schedule
 * into a closed tab, and a nudge exists to reach you when the app is not open.
 *
 * The plan is reconciled on every habit/check-in change, so checking in cancels the rest of the
 * period's nudges. Switching either gate off cancels every nudge booked.
 */
export function useHabitReminderScheduler(): void {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const { initialSyncDone } = useStore();
  const { remindersEnabled, habitsEnabled, weekStartsOn } = usePreferences();
  const { habits } = useHabits();
  const { statesFor } = useHabitCheckins();
  // reminderId -> the fire instant currently booked with the OS.
  const scheduledRef = useRef<Map<string, number>>(new Map());
  // What an earlier launch left booked with the OS, read and adopted once per mount.
  const bookedRef = useRef<Promise<string[]> | null>(null);
  const adoptedRef = useRef(false);
  // The UI language the OS holds the nudges' text in.
  const bookedLanguageRef = useRef<string | null>(null);
  // Whether the OS held exact-alarm access when the nudges were booked.
  const bookedExactRef = useRef<boolean | null>(null);
  const isWeb = Platform.OS === "web";
  const canNotify = useNotifyPermission().permission === "granted";
  const exact = useExactAlarms().exactAlarms !== "denied";

  useEffect(() => {
    if (isWeb) return;
    const scheduled = scheduledRef.current;
    // A run superseded by a newer one, or overtaken by a sign-out, books nothing.
    let stale = false;
    const cleanup = () => {
      stale = true;
    };
    if (!remindersEnabled || !habitsEnabled) {
      // Switched off: take back every nudge booked, including an earlier launch's.
      for (const id of scheduled.keys()) scheduleIO.cancel(id);
      scheduled.clear();
      void bookedNotificationIds("habit").then((ids) => {
        if (!stale) for (const id of ids) scheduleIO.cancel(id);
      });
      return cleanup;
    }
    if (!initialSyncDone || !canNotify) return;
    const generation = notificationGeneration();
    const body = t("notify.habitBody");
    void (async () => {
      await ensureNotificationSetup();
      bookedRef.current ??= bookedNotificationIds("habit");
      const booked = await bookedRef.current;
      if (stale || generation !== notificationGeneration()) return;
      const desired = habitReminders(habits, statesFor, Date.now(), weekStartsOn);
      // The first run adopts an earlier launch's bookings, cancelling nudges for habits deleted,
      // archived or checked off while the app was closed.
      if (!adoptedRef.current) adoptBooked(booked, desired, scheduled);
      adoptedRef.current = true;
      // A language change moves no fire time: book every nudge again so none keeps the old text.
      // Likewise once exact-alarm access is granted: earlier bookings stay inexact otherwise.
      const rebook =
        (bookedLanguageRef.current !== null && bookedLanguageRef.current !== language) ||
        (bookedExactRef.current === false && exact);
      bookedLanguageRef.current = language;
      bookedExactRef.current = exact;
      applySchedule(desired, scheduled, body, scheduleIO, { rebook });
    })();
    return cleanup;
  }, [
    isWeb,
    remindersEnabled,
    habitsEnabled,
    initialSyncDone,
    canNotify,
    habits,
    statesFor,
    weekStartsOn,
    t,
    language,
    exact,
  ]);
}
