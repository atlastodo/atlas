import type { Task } from "@atlastodo/client-core";
import { dayOffset } from "./zonedTime";

// Helpers for the Inbox / Today / Upcoming smart lists.

export function isOverdue(task: Task, now: number, _timeZone?: string): boolean {
  return !task.is_completed && task.due_at !== null && task.due_at < now;
}

// Subtasks are excluded as rows (`taskListTree` pulls them back in under their root); otherwise a subtask would be top-level whenever its parent sits in a project.
export function inboxTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.is_completed && t.project_id === null && t.parent_id === null);
}

export function todayTasks(tasks: Task[], now: number, timeZone?: string): Task[] {
  return tasks.filter(
    (t) => !t.is_completed && t.due_at !== null && dayOffset(t.due_at, now, timeZone) <= 0,
  );
}

export function partitionToday(
  tasks: Task[],
  now: number,
  timeZone?: string,
): { overdue: Task[]; today: Task[] } {
  const inScope = todayTasks(tasks, now, timeZone);
  const overdue = inScope.filter((t) => isOverdue(t, now, timeZone));
  const today = inScope.filter((t) => !isOverdue(t, now, timeZone));
  return { overdue, today };
}

export function assignedToMe(tasks: Task[], userId: string): Task[] {
  return tasks.filter((t) => !t.is_completed && t.assignee_id === userId);
}

export function openTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.is_completed);
}

export function upcomingTasks(tasks: Task[], now: number, timeZone?: string): Task[] {
  return tasks
    .filter((t) => !t.is_completed && t.due_at !== null && dayOffset(t.due_at, now, timeZone) > 0)
    .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0));
}
