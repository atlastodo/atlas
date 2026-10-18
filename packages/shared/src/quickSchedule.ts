// Import from the source module, not the barrel: "@atlastodo/shared" here forms a require cycle (index
// -> quickSchedule -> index) that warns and risks uninitialized values.
import { addDays, endOfDay, zonedParts } from "./zonedTime";

/**
 * Quick reschedule targets for the swipe-left day picker and compose bar: `now` injected, optional
 * IANA `timeZone`. Each lands on 23:59 of its day, so the task is all-day.
 */

export interface QuickScheduleOption {
  key: "today" | "tomorrow" | "weekend" | "nextWeek";
  dueAt: number;
}

/**
 * Days from `now` to "this weekend": the coming Saturday, or today once the weekend has started (on
 * a Sunday, this Sunday).
 */
function daysToWeekend(now: number, timeZone?: string): number {
  const weekday = zonedParts(now, timeZone).weekday; // 0 = Sunday .. 6 = Saturday
  if (weekday === 6 || weekday === 0) return 0;
  return 6 - weekday;
}

export function quickScheduleOptions(now: number, timeZone?: string): QuickScheduleOption[] {
  return [
    { key: "today", dueAt: endOfDay(now, timeZone) },
    { key: "tomorrow", dueAt: endOfDay(addDays(now, 1, timeZone), timeZone) },
    {
      key: "weekend",
      dueAt: endOfDay(addDays(now, daysToWeekend(now, timeZone), timeZone), timeZone),
    },
    { key: "nextWeek", dueAt: endOfDay(addDays(now, 7, timeZone), timeZone) },
  ];
}
