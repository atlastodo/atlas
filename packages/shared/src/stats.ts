/**
 * Productivity aggregates over completed tasks: pure, ranges passed in. Days are keyed by calendar
 * date in `timeZone` and iteration walks whole date keys (DST-safe), reusing the habit date
 * helpers.
 */

import type { Task } from "@atlastodo/client-core";
import { shiftDateKey, startOfWeekKey } from "./habits";
import { dayKey } from "./zonedTime";

const MAX_BUCKETS = 366 * 5;

export interface DayCount {
  date: string; // yyyy-mm-dd
  count: number;
}

export interface WeekCount {
  weekStart: string; // yyyy-mm-dd of the week's first day
  count: number;
}

export interface ProjectCount {
  projectId: string | null;
  count: number;
}

function completedOn(task: Task, timeZone?: string): string | null {
  return task.is_completed && task.completed_at != null
    ? dayKey(task.completed_at, timeZone)
    : null;
}

function inRange(ms: number, fromMs: number, toMs: number): boolean {
  return ms >= fromMs && ms <= toMs;
}

export function completionsByDay(
  tasks: Task[],
  fromMs: number,
  toMs: number,
  timeZone?: string,
): DayCount[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.completed_at != null && t.is_completed && inRange(t.completed_at, fromMs, toMs)) {
      const key = dayKey(t.completed_at, timeZone);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out: DayCount[] = [];
  const end = dayKey(toMs, timeZone);
  let key = dayKey(fromMs, timeZone);
  for (let i = 0; i < MAX_BUCKETS && key <= end; i++) {
    out.push({ date: key, count: counts.get(key) ?? 0 });
    key = shiftDateKey(key, 1);
  }
  return out;
}

export function completionsByWeek(
  tasks: Task[],
  fromMs: number,
  toMs: number,
  weekStartsOn = 0,
  timeZone?: string,
): WeekCount[] {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.completed_at != null && t.is_completed && inRange(t.completed_at, fromMs, toMs)) {
      const key = startOfWeekKey(dayKey(t.completed_at, timeZone), weekStartsOn);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out: WeekCount[] = [];
  const endKey = dayKey(toMs, timeZone);
  let key = startOfWeekKey(dayKey(fromMs, timeZone), weekStartsOn);
  for (let i = 0; i < MAX_BUCKETS && key <= endKey; i++) {
    out.push({ weekStart: key, count: counts.get(key) ?? 0 });
    key = shiftDateKey(key, 7);
  }
  return out;
}

export function completionsByProject(tasks: Task[], fromMs: number, toMs: number): ProjectCount[] {
  const counts = new Map<string | null, number>();
  for (const t of tasks) {
    if (t.completed_at != null && t.is_completed && inRange(t.completed_at, fromMs, toMs)) {
      counts.set(t.project_id, (counts.get(t.project_id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([projectId, count]) => ({ projectId, count }))
    .sort((a, b) => b.count - a.count);
}

export function totalCompleted(tasks: Task[], fromMs: number, toMs: number): number {
  return tasks.filter(
    (t) => t.completed_at != null && t.is_completed && inRange(t.completed_at, fromMs, toMs),
  ).length;
}

/**
 * "Karma" streak: consecutive days ending today with a completed task. Today gets grace (no
 * completions yet does not break it); an earlier empty day does.
 */
export function completedStreak(tasks: Task[], todayMs: number, timeZone?: string): number {
  const days = new Set<string>();
  for (const t of tasks) {
    const key = completedOn(t, timeZone);
    if (key) days.add(key);
  }
  const today = dayKey(todayMs, timeZone);
  let key = today;
  let streak = 0;
  for (let i = 0; i < MAX_BUCKETS; i++) {
    if (days.has(key)) streak++;
    else if (key !== today) break;
    key = shiftDateKey(key, -1);
  }
  return streak;
}

export function completedHistory(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  return tasks
    .filter((t) => t.is_completed && t.completed_at != null)
    .filter((t) => q === "" || t.title.toLowerCase().includes(q))
    .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
}
