import { CalendarDays, Flag, Hash, Repeat, Tag } from "./icons";
import type { LucideIcon } from "./icons";
import type { ChipKind } from "@atlastodo/shared";

/**
 * The look of a task-detail chip, shared by `QuickAdd`'s preview and `TaskComposeBar`'s chips. Its
 * own module so the bar need not import the component that renders it (a require cycle, see
 * `quickSchedule.ts`).
 */

export const CHIP_ICON: Record<ChipKind, LucideIcon> = {
  due: CalendarDays,
  recurrence: Repeat,
  project: Hash,
  label: Tag,
  priority: Flag,
};

/** A subtle colour per chip kind (date sky, project fuchsia, label emerald, ...). The inline date highlight reuses `chipColors("due").box` so the box matches its chip. */
export function chipColors(kind: ChipKind): { chip: string; text: string; box: string } {
  const MAP: Record<ChipKind, { chip: string; text: string; box: string }> = {
    due: {
      chip: "bg-sky-100 dark:bg-sky-950",
      text: "text-sky-700 dark:text-sky-300",
      box: "bg-sky-100 dark:bg-sky-900",
    },
    recurrence: {
      chip: "bg-violet-100 dark:bg-violet-950",
      text: "text-violet-700 dark:text-violet-300",
      box: "bg-violet-100 dark:bg-violet-900",
    },
    project: {
      chip: "bg-fuchsia-100 dark:bg-fuchsia-950",
      text: "text-fuchsia-700 dark:text-fuchsia-300",
      box: "bg-fuchsia-100 dark:bg-fuchsia-900",
    },
    label: {
      chip: "bg-emerald-100 dark:bg-emerald-950",
      text: "text-emerald-700 dark:text-emerald-300",
      box: "bg-emerald-100 dark:bg-emerald-900",
    },
    priority: {
      chip: "bg-rose-100 dark:bg-rose-950",
      text: "text-rose-700 dark:text-rose-300",
      box: "bg-rose-100 dark:bg-rose-900",
    },
  };
  return MAP[kind];
}
