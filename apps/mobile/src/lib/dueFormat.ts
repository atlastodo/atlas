import { isAllDayTask } from "@atlastodo/shared";

/**
 * Default compact due format (device locale), the fallback when a screen passes no
 * preference-aware formatter (`useFormat`'s `dueChip`). A timed task keeps its time; an all-day one
 * shows the date alone.
 */
export function defaultFormatDue(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (isAllDayTask(ms)) return date;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}
