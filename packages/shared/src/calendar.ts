import type { Task } from "@atlastodo/client-core";
import { addDays, makeInstant, startOfDay, zonedParts } from "./zonedTime";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Pure calendar layout helpers: `now` injected, day boundaries in an optional IANA `timeZone`
 * (default: runtime zone), like {@link ./zonedTime}.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DayCell {
  date: number;
  day: number;
  inMonth: boolean;
}

export function weekdayLabels(weekStartsOn: number): string[] {
  const start = ((weekStartsOn % 7) + 7) % 7;
  return Array.from({ length: 7 }, (_, i) => WEEKDAYS[(start + i) % 7]!);
}

// `month` is 0-indexed; padded with neighbouring-month days so every row has 7 cells.
export function monthGrid(
  year: number,
  month: number,
  weekStartsOn: number,
  timeZone?: string,
): DayCell[][] {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const start = ((weekStartsOn % 7) + 7) % 7;
  const offset = (first.getDay() - start + 7) % 7; // leading days from the previous month
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7;

  const weeks: DayCell[][] = [];
  for (let i = 0; i < cellCount; i++) {
    // A local Date only for month/year rollover; a cell is that date's midnight in the viewing zone.
    const d = new Date(year, month, 1 - offset + i);
    const cell: DayCell = {
      date: makeInstant(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, timeZone),
      day: d.getDate(),
      inMonth: d.getMonth() === month && d.getFullYear() === year,
    };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push(cell);
  }
  return weeks;
}

export function weekDays(anchorMs: number, weekStartsOn: number, timeZone?: string): DayCell[] {
  const start = ((weekStartsOn % 7) + 7) % 7;
  const anchorStart = startOfDay(anchorMs, timeZone);
  const back = (zonedParts(anchorStart, timeZone).weekday - start + 7) % 7;
  const weekStart = addDays(anchorStart, -back, timeZone);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i, timeZone);
    return { date, day: zonedParts(date, timeZone).day, inMonth: true };
  });
}

// ISO weeks are Monday-based whatever `week_starts_on` is.
export function isoWeek(ms: number, timeZone?: string): number {
  const p = zonedParts(ms, timeZone);
  // Operate on the plain calendar date in UTC so zone offset and DST cannot shift the day.
  const target = new Date(Date.UTC(p.year, p.month, p.day));
  const dayNr = (target.getUTCDay() + 6) % 7; // Mon = 0 .. Sun = 6
  target.setUTCDate(target.getUTCDate() - dayNr + 3); // the Thursday of this ISO week
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1); // Jan 1 of the ISO-week-year
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7)); // first Thursday of that year
  }
  return 1 + Math.round((firstThursday - target.getTime()) / WEEK_MS);
}

export function tasksByDay(tasks: Task[], timeZone?: string): Map<number, Task[]> {
  const map = new Map<number, Task[]>();
  for (const t of tasks) {
    if (t.is_completed || t.due_at === null) continue;
    const day = startOfDay(t.due_at, timeZone);
    const bucket = map.get(day);
    if (bucket) bucket.push(t);
    else map.set(day, [t]);
  }
  return map;
}

export function isAllDayTask(dueAt: number, timeZone?: string): boolean {
  const p = zonedParts(dueAt, timeZone);
  return p.hour === 23 && p.minute === 59;
}

export interface TimedTaskInfo {
  task: Task;
  startHour: number;
  startMinute: number;
  durationMin: number;
}

export interface DayTasksPartition {
  allDay: Task[];
  timed: TimedTaskInfo[];
}

export function partitionDayTasks(tasks: Task[], timeZone?: string): DayTasksPartition {
  const allDay: Task[] = [];
  const timed: TimedTaskInfo[] = [];

  for (const task of tasks) {
    if (task.due_at === null) continue;
    if (isAllDayTask(task.due_at, timeZone)) {
      allDay.push(task);
    } else {
      const p = zonedParts(task.due_at, timeZone);
      const durationMin =
        task.estimate_min !== null && task.estimate_min > 0 ? task.estimate_min : 30;
      timed.push({
        task,
        startHour: p.hour,
        startMinute: p.minute,
        durationMin,
      });
    }
  }

  timed.sort((a, b) => a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute));
  return { allDay, timed };
}
