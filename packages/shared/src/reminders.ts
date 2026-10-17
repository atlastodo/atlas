import type { Task } from "@atlastodo/client-core";
import { isAllDayTask } from "./calendar";
import { makeInstant, zonedParts } from "./zonedTime";

/**
 * Task reminders: pure scheduling logic. A reminder fires at an absolute time (`at`) or
 * `offset_min_before_due` minutes before the due date. `fired_at` is synced and covers the fire
 * instant it went out for, so a later-moved instant makes it unfired again ({@link isReminderFired}).
 *
 * All-day dues are 23:59 in the task's calendar, so day-based offsets resolve in `timeZone`, not
 * the device-local reading, which disagrees once the device zone differs.
 */

export interface Reminder {
  id: string;
  task_id: string;
  at: number | null;
  offset_min_before_due: number | null;
  fired_at: number | null;
  created_at: number;
}

export function toReminder(id: string, fields: Record<string, unknown>): Reminder {
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    id,
    task_id: typeof fields.task_id === "string" ? fields.task_id : "",
    at: num(fields.at),
    offset_min_before_due: num(fields.offset_min_before_due),
    fired_at: num(fields.fired_at),
    created_at: num(fields.created_at) ?? 0,
  };
}

function morningOf(ms: number, days: number, timeZone?: string): number {
  const p = zonedParts(ms, timeZone);
  return makeInstant(p.year, p.month, p.day - days, 9, 0, 0, timeZone);
}

export function reminderFireAt(
  reminder: Reminder,
  task: Task | undefined,
  timeZone?: string,
): number | null {
  if (reminder.at !== null) return reminder.at;
  if (reminder.offset_min_before_due !== null && task && task.due_at !== null) {
    const offset = reminder.offset_min_before_due;
    // Day-based offsets (multiples of 1440 min) fire at 09:00, `days` before the due day.
    if (offset % 1440 === 0 && isAllDayTask(task.due_at, timeZone)) {
      return morningOf(task.due_at, offset / 1440, timeZone);
    }
    return task.due_at - offset * 60_000;
  }
  return null;
}

// Quick-add's implicit morning-of reminder: 0 days before the due day, i.e. 09:00.
export const MORNING_OF_OFFSET_MIN = 0;

// Null when none applies: no due, an explicit time, or 09:00 already past (it would fire at creation).
export function morningReminderOffset(
  dueAt: number | null | undefined,
  now: number,
  timeZone?: string,
): number | null {
  if (dueAt == null || !isAllDayTask(dueAt, timeZone)) return null;
  if (morningOf(dueAt, 0, timeZone) <= now) return null;
  return MORNING_OF_OFFSET_MIN;
}

// A stamp from before `fireAt` was for an earlier instant, so it fires again.
export function isReminderFired(reminder: Reminder, fireAt: number): boolean {
  return reminder.fired_at !== null && reminder.fired_at >= fireAt;
}

export function dueReminders(
  reminders: Reminder[],
  tasks: Task[],
  now: number,
  timeZone?: string,
): Reminder[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return reminders.filter((r) => {
    const task = byId.get(r.task_id);
    if (!task || task.is_completed) return false;
    const fireAt = reminderFireAt(r, task, timeZone);
    return fireAt !== null && fireAt <= now && !isReminderFired(r, fireAt);
  });
}

// Past this a reminder is old news: an OS-scheduled notification does not stamp `fired_at`, so the web would repeat it.
export const REMINDER_STALE_AFTER_MS = 15 * 60_000;

// Stale reminders are only stamped fired, not announced.
export function splitDueReminders(
  reminders: Reminder[],
  tasks: Task[],
  now: number,
  timeZone?: string,
  staleAfterMs = REMINDER_STALE_AFTER_MS,
): { fire: Reminder[]; stale: Reminder[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const fire: Reminder[] = [];
  const stale: Reminder[] = [];
  for (const r of dueReminders(reminders, tasks, now, timeZone)) {
    // Non-null: `dueReminders` only returns reminders with a resolvable fire instant.
    const fireAt = reminderFireAt(r, byId.get(r.task_id), timeZone)!;
    (now - fireAt > staleAfterMs ? stale : fire).push(r);
  }
  return { fire, stale };
}
