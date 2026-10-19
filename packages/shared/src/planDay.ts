import type { Task } from "@atlastodo/client-core";
import { addDays, dayOffset, endOfDay } from "./zonedTime";
import { partitionToday, upcomingTasks } from "./smartLists";

/**
 * Helpers for the Today screen's plan-my-day review. The only persisted outcome is due-date
 * changes (`planDayWrites` reduces decisions to plain `{ id, dueAt }` writes).
 */

export const PLAN_DAY_HORIZON_DAYS = 7;

export type PlanDayBucket = "overdue" | "today" | "upcoming";

export interface PlanDayItem {
  task: Task;
  bucket: PlanDayBucket;
}

export function planDayItems(tasks: Task[], now: number, timeZone?: string): PlanDayItem[] {
  const { overdue, today } = partitionToday(tasks, now, timeZone);
  return [
    ...overdue.map((task) => ({ task, bucket: "overdue" as const })),
    ...today.map((task) => ({ task, bucket: "today" as const })),
  ];
}

export function planDayUpcoming(
  tasks: Task[],
  now: number,
  timeZone?: string,
  days: number = PLAN_DAY_HORIZON_DAYS,
): Task[] {
  return upcomingTasks(tasks, now, timeZone).filter(
    (t) => dayOffset(t.due_at as number, now, timeZone) <= days,
  );
}

export interface PlanDayOption {
  offset: number;
  dueAt: number;
}

// The same instants `quickScheduleOptions` writes.
export function planDayPostponeOptions(
  now: number,
  timeZone?: string,
  days: number = PLAN_DAY_HORIZON_DAYS,
): PlanDayOption[] {
  return Array.from({ length: days }, (_, i) => {
    const offset = i + 1;
    return { offset, dueAt: endOfDay(addDays(now, offset, timeZone), timeZone) };
  });
}

export type PlanDayDecision =
  { kind: "keep" } | { kind: "postpone"; dueAt: number } | { kind: "later" };

export interface PlanDayWrite {
  id: string;
  dueAt: number;
}

// Equal-value writes are skipped to keep undo honest.
export function planDayWrites(
  items: PlanDayItem[],
  decisions: Record<string, PlanDayDecision | undefined>,
  todayEnd: number,
): PlanDayWrite[] {
  const writes: PlanDayWrite[] = [];
  for (const item of items) {
    const decision = decisions[item.task.id];
    if (!decision || decision.kind === "later") continue;
    const to =
      decision.kind === "postpone" ? decision.dueAt : item.bucket === "upcoming" ? todayEnd : null;
    if (to === null) continue;
    if (item.task.due_at === to) continue;
    writes.push({ id: item.task.id, dueAt: to });
  }
  return writes;
}
