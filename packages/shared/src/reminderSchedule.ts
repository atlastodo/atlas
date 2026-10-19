import type { Task } from "@atlastodo/client-core";
import { isReminderFired, reminderFireAt, type Reminder } from "./reminders";

/**
 * OS-scheduled reminder planning: decides which local notifications to book and diffs that against
 * what is booked, so reconciling is idempotent. Keys off {@link reminderFireAt}, so it is
 * DST-correct. Platform differences live in the injected {@link ScheduleIO}.
 */

export interface ScheduledReminder {
  reminderId: string;
  fireAt: number;
  title: string;
  body?: string;
}

export interface ScheduleDiff {
  toSchedule: ScheduledReminder[];
  toCancel: string[];
}

export interface ScheduleIO {
  schedule: (title: string, body: string, at: number, id: string) => void;
  cancel: (id: string) => void;
}

export interface ReminderTitleOptions {
  lockedTitle?: string;
  fallbackTitle?: string;
}

export interface ReminderPlanOptions extends ReminderTitleOptions {
  // All-day anchors resolve in this zone (see `reminderFireAt`); the device's when absent.
  timeZone?: string;
}

export function reminderTitle(task: Task | undefined, options: ReminderTitleOptions = {}): string {
  if (task?.locked && options.lockedTitle !== undefined) return options.lockedTitle;
  const title = task?.title ?? "";
  return title !== "" ? title : (options.fallbackTitle ?? "");
}

export function reminderBody(task: Task | undefined): string {
  if (!task || task.locked || !task.notes) return "";
  const firstLine = task.notes.split(/\r?\n/).find((line) => line.trim() !== "");
  return firstLine ? firstLine.trim() : "";
}

// Strictly future fire instants only: past-due ones are the in-app scheduler's job.
export function futureReminders(
  reminders: Reminder[],
  tasks: Task[],
  now: number,
  options: ReminderPlanOptions = {},
): ScheduledReminder[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: ScheduledReminder[] = [];
  for (const r of reminders) {
    const task = byId.get(r.task_id);
    if (!task || task.is_completed) continue;
    const fireAt = reminderFireAt(r, task, options.timeZone);
    if (fireAt === null || fireAt <= now || isReminderFired(r, fireAt)) continue;
    const body = reminderBody(task);
    out.push({
      reminderId: r.id,
      fireAt,
      title: reminderTitle(task, options),
      ...(body ? { body } : {}),
    });
  }
  return out;
}

export interface ApplyOptions {
  // Rebook even unmoved instants: the OS shows the text it was booked with (the UI language may have changed).
  rebook?: boolean;
}

// Free of `Reminder`/`Task` so habit reminders reconcile through the same code.
export function diffSchedule(
  desired: ScheduledReminder[],
  scheduled: Map<string, number>,
  { rebook = false }: ApplyOptions = {},
): ScheduleDiff {
  const desiredById = new Map(desired.map((d) => [d.reminderId, d]));
  if (rebook) {
    // Booking under the same id replaces the OS copy; a cancel for a still-wanted id could land after it.
    return {
      toSchedule: desired,
      toCancel: [...scheduled.keys()].filter((id) => !desiredById.has(id)),
    };
  }
  const toSchedule = desired.filter((d) => scheduled.get(d.reminderId) !== d.fireAt);
  const toCancel = [...scheduled.keys()].filter((id) => {
    const d = desiredById.get(id);
    return d === undefined || d.fireAt !== scheduled.get(id);
  });
  return { toSchedule, toCancel };
}

export function applySchedule(
  desired: ScheduledReminder[],
  scheduled: Map<string, number>,
  body: string,
  io: ScheduleIO,
  options: ApplyOptions = {},
): void {
  const { toSchedule, toCancel } = diffSchedule(desired, scheduled, options);
  for (const id of toCancel) {
    io.cancel(id);
    scheduled.delete(id);
  }
  for (const s of toSchedule) {
    const notificationBody = s.body !== undefined && s.body !== "" ? s.body : body;
    io.schedule(s.title, notificationBody, s.fireAt, s.reminderId);
    scheduled.set(s.reminderId, s.fireAt);
  }
}

// Adopts ids an earlier launch left booked, so the next {@link applySchedule} cancels stale ones.
export function adoptBooked(
  booked: readonly string[],
  desired: ScheduledReminder[],
  scheduled: Map<string, number>,
): void {
  const wanted = new Set(desired.map((d) => d.reminderId));
  // NaN never equals a fire instant, so the diff always treats an adopted id as stale.
  for (const id of booked) if (!wanted.has(id) && !scheduled.has(id)) scheduled.set(id, Number.NaN);
}

export function reconcileSchedule(
  reminders: Reminder[],
  tasks: Task[],
  now: number,
  scheduled: Map<string, number>,
): ScheduleDiff {
  return diffSchedule(futureReminders(reminders, tasks, now), scheduled);
}

export interface ReconcileOptions extends ReminderPlanOptions, ApplyOptions {
  booked?: readonly string[];
}

export function reconcileNotifications(
  reminders: Reminder[],
  tasks: Task[],
  now: number,
  scheduled: Map<string, number>,
  body: string,
  io: ScheduleIO,
  options: ReconcileOptions = {},
): void {
  const desired = futureReminders(reminders, tasks, now, options);
  if (options.booked) adoptBooked(options.booked, desired, scheduled);
  applySchedule(desired, scheduled, body, io, { rebook: options.rebook });
}
