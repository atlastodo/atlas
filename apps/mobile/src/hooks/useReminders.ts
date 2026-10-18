import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PREFERENCES_ID,
  isTrashed,
  morningReminderOffset,
  softDelete,
  toReminder,
  type Reminder,
} from "@atlastodo/shared";
import { useStore, useStoreOptional, type StoreContextValue } from "../data/StoreProvider";
import {
  ensureNotifyPermission,
  onNotifyPermissionChange,
  openExactAlarmSettings,
  readExactAlarms,
  readNotifyPermission,
} from "../lib/notify";
import { explainNotifications } from "../lib/permissionExplainer";
import type { NotifyPermission } from "../lib/reminderActions";
import { remindersEnabledIn } from "./usePreferences";

/**
 * Task reminders: `reminder` entities in the shared store, synced like any other entity. Ids come
 * from `store.newEntityId()`, never `crypto.randomUUID()` (Hermes has no global crypto, and a
 * non-UUID entity_id 422s the whole push).
 */

export interface NewReminder {
  at?: number | null;
  offset_min_before_due?: number | null;
}

export interface UseReminders {
  reminders: Reminder[];
  /** Reminders attached to a given task, oldest first. */
  forTask: (taskId: string) => Reminder[];
  createReminder: (taskId: string, spec: NewReminder) => string;
  /** Set or update the single reminder on a task (replaces existing if any). */
  setReminder: (taskId: string, spec: NewReminder) => string;
  markFired: (id: string, at: number) => void;
  /**
   * Re-arm a fired reminder to fire again at `at` (Unix ms), the notification's snooze. The fire
   * time becomes absolute and any due-relative offset is dropped.
   */
  snoozeReminder: (id: string, at: number) => void;
  /** Delete a reminder; returns a closure that restores it (for an undo). */
  removeReminder: (id: string) => () => void;
}

/**
 * The field ops every reminder creation writes: `task_id`, the anchor (`at` and/or
 * `offset_min_before_due`) and a `created_at` stamp (the `forTask` ordering). `fired_at` stays
 * unwritten, so the scheduler's dedupe treats the reminder as never fired.
 */
function writeNewReminder(
  store: StoreContextValue["store"],
  taskId: string,
  spec: NewReminder,
): string {
  const id = store.newEntityId();
  store.set("reminder", id, "task_id", taskId);
  if (spec.at != null) store.set("reminder", id, "at", spec.at);
  if (spec.offset_min_before_due != null)
    store.set("reminder", id, "offset_min_before_due", spec.offset_min_before_due);
  store.set("reminder", id, "created_at", Date.now());
  return id;
}

/** Ids of the tasks with a reminder still to come (not yet fired), for the rows' bell marker. */
export function useReminderTaskIds(): Set<string> {
  const { store, version } = useStore();
  return useMemo(
    () => {
      const ids = new Set<string>();
      for (const e of store.list("reminder")) {
        if (isTrashed(e.fields)) continue;
        const r = toReminder(e.id, e.fields);
        if (r.fired_at == null && r.task_id) ids.add(r.task_id);
      }
      return ids;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );
}

export function useReminders(): UseReminders {
  const { store, version, kick } = useStore();

  const reminders = useMemo(
    () =>
      store
        .list("reminder")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toReminder(e.id, e.fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const forTask = useCallback(
    (taskId: string) =>
      reminders.filter((r) => r.task_id === taskId).sort((a, b) => a.created_at - b.created_at),
    [reminders],
  );

  const createReminder = useCallback(
    (taskId: string, spec: NewReminder) => {
      const id = writeNewReminder(store, taskId, spec);
      kick();
      return id;
    },
    [store, kick],
  );

  const markFired = useCallback(
    (id: string, at: number) => {
      store.set("reminder", id, "fired_at", at);
      kick();
    },
    [store, kick],
  );

  // `at` replaces the anchor outright (null offset, so the entity carries no misleading one) and
  // the fire stamp clears so the dedupe does not swallow the re-fire.
  const snoozeReminder = useCallback(
    (id: string, at: number) => {
      store.set("reminder", id, "at", at);
      store.set("reminder", id, "offset_min_before_due", null);
      store.set("reminder", id, "fired_at", null);
      kick();
    },
    [store, kick],
  );

  const removeReminder = useCallback(
    (id: string) => softDelete(store, kick, "reminder", id),
    [store, kick],
  );

  const setReminder = useCallback(
    (taskId: string, spec: NewReminder) => {
      const existing = reminders.filter((r) => r.task_id === taskId);
      if (existing.length > 0) {
        const primary = existing[0]!;
        for (let i = 1; i < existing.length; i++) {
          removeReminder(existing[i]!.id);
        }
        store.set("reminder", primary.id, "at", spec.at ?? null);
        store.set(
          "reminder",
          primary.id,
          "offset_min_before_due",
          spec.offset_min_before_due ?? null,
        );
        store.set("reminder", primary.id, "fired_at", null);
        kick();
        return primary.id;
      }
      return createReminder(taskId, spec);
    },
    [reminders, store, kick, removeReminder, createReminder],
  );

  return {
    reminders,
    forTask,
    createReminder,
    setReminder,
    markFired,
    snoozeReminder,
    removeReminder,
  };
}

/**
 * Quick-add's implicit morning-of reminder: when a quick-added task comes out all-day (due stored at
 * 23:59, no explicit time), attach one reminder at 09:00 local on the due date, as the day-based
 * `morningReminderOffset` so it follows the due date. The only creation path that adds a reminder
 * silently.
 *
 * Gated on the reminders master toggle (`remindersEnabledIn`) and a no-op without a store (bare
 * test renders). It also asks for notification permission if still undecided, since reminders
 * default on and nothing else would. `now`/`timeZone` are explicit so quick-add can pass the
 * reference it parsed the title with.
 */
export function useQuickAddMorningReminder(): (
  taskId: string,
  dueAt: number | null | undefined,
  timeZone?: string,
  now?: number,
) => void {
  const ctx = useStoreOptional();
  return useCallback(
    (taskId, dueAt, timeZone, now = Date.now()) => {
      if (!ctx) return;
      if (!remindersEnabledIn(ctx.store.get("preference", PREFERENCES_ID))) return;
      const offset = morningReminderOffset(dueAt, now, timeZone);
      if (offset === null) return;
      writeNewReminder(ctx.store, taskId, { offset_min_before_due: offset });
      ctx.kick();
      // Unasked for, so a "Not now" to the explainer keeps later quick-adds quiet.
      void explainNotifications({ implicit: true });
    },
    [ctx],
  );
}

export interface UseNotifyPermission {
  /** Where permission stands; null until the first read lands. */
  permission: NotifyPermission | null;
  /**
   * Prompt when still undecided; resolves to whether notifications are allowed. Call it from a
   * user gesture: a browser ignores any other prompt.
   */
  request: () => Promise<boolean>;
}

/** Notification permission, re-read whenever it may have changed (prompt answered, site or OS setting flipped). */
export function useNotifyPermission(): UseNotifyPermission {
  const [permission, setPermission] = useState<NotifyPermission | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void readNotifyPermission().then((next) => {
        if (live) setPermission(next);
      });
    };
    refresh();
    const unsubscribe = onNotifyPermissionChange(refresh);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return { permission, request: ensureNotifyPermission };
}

export interface UseExactAlarms {
  /** Whether booked reminders fire on time; `unsupported` where the OS never delays them. */
  exactAlarms: "granted" | "denied" | "unsupported";
  /** Open the system page that grants exact-alarm access. */
  openSettings: () => Promise<boolean>;
}

/** Exact-alarm access (Android 12+), re-read whenever the app returns to the foreground. */
export function useExactAlarms(): UseExactAlarms {
  const [exactAlarms, setExactAlarms] = useState(readExactAlarms);
  useEffect(() => onNotifyPermissionChange(() => setExactAlarms(readExactAlarms())), []);
  return { exactAlarms, openSettings: openExactAlarmSettings };
}
