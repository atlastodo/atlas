import type { Task } from "@atlastodo/client-core";
import type { Reminder } from "@atlastodo/shared";

/**
 * Interactive reminder notifications, shared by `lib/notify.ts` and `lib/notify.web.ts`. On native a
 * task reminder is posted under a category with Complete and Snooze buttons; the identifiers below
 * are the contract between scheduling and the response handler. Web has no buttons.
 */

/**
 * The category carrying the Complete / Snooze actions. Free of `-` and `:`, which expo-notifications
 * warns "might not work as expected" in category identifiers.
 */
export const REMINDER_CATEGORY_ID = "taskreminder";

/** Pressing the category's Complete button reports this action identifier. */
export const REMINDER_COMPLETE_ACTION = "atlas.reminder.complete";

/** Pressing the category's Snooze button reports this action identifier. */
export const REMINDER_SNOOZE_ACTION = "atlas.reminder.snooze";

/**
 * How far a snoozed reminder is pushed: one hour after the press. Not anchored to the due date,
 * which is not always meaningful (an all-day task's reminder fires at 09:00, so a due-relative
 * offset could jump a whole day). The `reminder.actionSnooze` label states the same hour.
 */
export const SNOOZE_INTERVAL_MS = 60 * 60 * 1000;

/** A press on a reminder notification's Complete / Snooze button, reduced to what handling needs. */
export interface ReminderResponse {
  reminderId: string;
  actionIdentifier: string;
  /** The tapped notification's fire time (Unix ms): the dedupe key across delivery paths. */
  notificationDate: number;
}

/**
 * Where notification permission stands: `default` is still undecided (a prompt would ask),
 * `denied` cannot be prompted again, and `unsupported` means this runtime has no notifications.
 */
export type NotifyPermission = "granted" | "default" | "denied" | "unsupported";

/** What handling a reminder response should do, decided without touching the store. */
export type PlannedReminderAction =
  /** Complete the task through the app's normal toggle path (recurrence roll-forward included). */
  | { kind: "complete"; task: Task }
  /** Re-arm the reminder to fire again at `at` (an absolute instant). */
  | { kind: "snooze"; reminderId: string; at: number }
  /** Nothing to do: an unknown action, a stale reminder, or a completed/deleted task. */
  | { kind: "ignore" };

/**
 * Turn a pressed notification action into the store write it asks for, or `ignore`. Kept apart from
 * the handler so it is testable without a notification runtime:
 *
 * - only the two action identifiers act; a plain banner tap just opens the app;
 * - a reminder that no longer exists is ignored, since snoozing it would resurrect a ghost entity;
 * - a task already completed or deleted is ignored, since completing again would reopen it;
 * - Complete on a locked task (one this device cannot decrypt) is ignored: its fields are
 *   placeholders. Snooze only touches the reminder and still works.
 */
export function planReminderResponse(
  response: ReminderResponse,
  args: { reminders: Reminder[]; tasks: Task[]; now: number; snoozeMs?: number },
): PlannedReminderAction {
  if (
    response.actionIdentifier !== REMINDER_COMPLETE_ACTION &&
    response.actionIdentifier !== REMINDER_SNOOZE_ACTION
  ) {
    return { kind: "ignore" };
  }
  const reminder = args.reminders.find((r) => r.id === response.reminderId);
  if (!reminder) return { kind: "ignore" };
  // `tasks` is the visible set: a trashed task is absent, like a hard-deleted one.
  const task = args.tasks.find((t) => t.id === reminder.task_id);
  if (!task || task.is_completed) return { kind: "ignore" };
  if (response.actionIdentifier === REMINDER_COMPLETE_ACTION) {
    return task.locked ? { kind: "ignore" } : { kind: "complete", task };
  }
  return {
    kind: "snooze",
    reminderId: reminder.id,
    at: args.now + (args.snoozeMs ?? SNOOZE_INTERVAL_MS),
  };
}
