import type { Task } from "@atlastodo/client-core";
import { isOverdue } from "./smartLists";
import { dayOffset } from "./zonedTime";

// Grouping and sorting for task-list views. The engine returns stable keys; the view maps a key to a title.

// "completed" is for the Completed view only; it is not in GROUP_BYS, so it is never a preference.
export type GroupBy = "none" | "date" | "priority" | "label" | "project" | "completed";
export type SortBy = "manual" | "due" | "priority" | "alpha" | "created" | "modified";

export const GROUP_BYS: GroupBy[] = ["none", "date", "priority", "label", "project"];
export const SORT_BYS: SortBy[] = ["manual", "due", "priority", "alpha", "created", "modified"];

export function isGroupBy(v: unknown): v is GroupBy {
  return typeof v === "string" && (GROUP_BYS as string[]).includes(v);
}
export function isSortBy(v: unknown): v is SortBy {
  return typeof v === "string" && (SORT_BYS as string[]).includes(v);
}

export interface TaskGroup {
  key: string;
  kind: GroupBy;
  accent?: "danger";
  tasks: Task[];
}

function byManual(a: Task, b: Task): number {
  return a.sort_order - b.sort_order || a.created_at - b.created_at;
}

// Exported because a nested list sorts each tree level separately (see `TaskTreeOrder`). Ties fall back to manual order.
export function taskComparator(sortBy: SortBy): (a: Task, b: Task) => number {
  switch (sortBy) {
    case "due":
      // Ascending due date; tasks with no due date sink.
      return (a, b) => {
        if (a.due_at == null && b.due_at == null) return byManual(a, b);
        if (a.due_at == null) return 1;
        if (b.due_at == null) return -1;
        return a.due_at - b.due_at || byManual(a, b);
      };
    case "priority":
      // P1 (1) first, "no priority" (4) last.
      return (a, b) => a.priority - b.priority || byManual(a, b);
    case "alpha":
      return (a, b) =>
        a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || byManual(a, b);
    case "created":
      return (a, b) => b.created_at - a.created_at || byManual(a, b);
    case "modified":
      return (a, b) => b.updated_at - a.updated_at || byManual(a, b);
    case "manual":
    default:
      return byManual;
  }
}

export function sortTasks(tasks: Task[], sortBy: SortBy): Task[] {
  return [...tasks].sort(taskComparator(sortBy));
}

export interface GroupContext {
  now: number;
  timeZone?: string;
  sortBy: SortBy;
  projectOrder: string[];
  labelOrder: string[];
}

// Keyed off `completed_at` and calendar days, not rolling hours.
export function completedBucket(completedAt: number, now: number, timeZone?: string): string {
  // dayOffset is completedDay - todayDay (0 today, -1 yesterday), so days-ago is its negation.
  const daysAgo = -dayOffset(completedAt, now, timeZone);
  if (daysAgo <= 0) return "today";
  if (daysAgo < 7) return "thisWeek";
  if (daysAgo < 30) return "thisMonth";
  return "older";
}

function dateBucket(task: Task, now: number, timeZone?: string): string {
  if (task.due_at == null) return "none";
  if (isOverdue(task, now, timeZone)) return "overdue";
  const off = dayOffset(task.due_at, now, timeZone);
  if (off <= 0) return "today";
  if (off === 1) return "tomorrow";
  if (off <= 7) return "week";
  return "later";
}

// Empty groups are omitted. Only `label` grouping duplicates a task (once per label).
export function groupTasks(tasks: Task[], groupBy: GroupBy, ctx: GroupContext): TaskGroup[] {
  if (groupBy === "none") {
    return tasks.length ? [{ key: "all", kind: "none", tasks: sortTasks(tasks, ctx.sortBy) }] : [];
  }

  // Completion-recency grouping: each bucket newest-completed first regardless of ctx.sortBy.
  if (groupBy === "completed") {
    const buckets = new Map<string, Task[]>();
    for (const t of tasks) {
      const key =
        t.completed_at != null ? completedBucket(t.completed_at, ctx.now, ctx.timeZone) : "older";
      const arr = buckets.get(key);
      if (arr) arr.push(t);
      else buckets.set(key, [t]);
    }
    const groups: TaskGroup[] = [];
    for (const key of ["today", "thisWeek", "thisMonth", "older"]) {
      const arr = buckets.get(key);
      if (!arr || arr.length === 0) continue;
      arr.sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
      groups.push({ key, kind: "completed", tasks: arr });
    }
    return groups;
  }

  // Bucket tasks by key, then emit in a fixed key order.
  const buckets = new Map<string, Task[]>();
  const push = (key: string, task: Task) => {
    const arr = buckets.get(key);
    if (arr) arr.push(task);
    else buckets.set(key, [task]);
  };

  let order: string[];
  let accentKeys: Set<string> = new Set();

  if (groupBy === "date") {
    for (const t of tasks) push(dateBucket(t, ctx.now, ctx.timeZone), t);
    order = ["overdue", "today", "tomorrow", "week", "later", "none"];
    accentKeys = new Set(["overdue"]);
  } else if (groupBy === "priority") {
    for (const t of tasks) push(t.priority === 4 ? "none" : `p${t.priority}`, t);
    order = ["p1", "p2", "p3", "none"];
  } else if (groupBy === "project") {
    for (const t of tasks) push(t.project_id ?? "inbox", t);
    order = [...ctx.projectOrder, "inbox"];
  } else {
    // label: a task appears under each of its labels, or under "none" when it has none.
    for (const t of tasks) {
      if (t.label_ids.length === 0) push("none", t);
      else for (const id of t.label_ids) push(id, t);
    }
    order = [...ctx.labelOrder, "none"];
  }

  const groups: TaskGroup[] = [];
  for (const key of order) {
    const arr = buckets.get(key);
    if (!arr || arr.length === 0) continue;
    groups.push({
      key,
      kind: groupBy,
      ...(accentKeys.has(key) ? { accent: "danger" as const } : {}),
      tasks: sortTasks(arr, ctx.sortBy),
    });
  }
  return groups;
}
