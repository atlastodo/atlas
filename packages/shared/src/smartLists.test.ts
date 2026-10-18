import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  assignedToMe,
  inboxTasks,
  isOverdue,
  openTasks,
  partitionToday,
  todayTasks,
  upcomingTasks,
} from "./smartLists";
import { dayOffset } from "./zonedTime";

// A fixed reference "now": 2026-07-02 12:00 local.
const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();
const day = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();

function task(overrides: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(),
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "t",
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("dayOffset", () => {
  it("is 0 for later today and 1 for tomorrow", () => {
    expect(dayOffset(day(2026, 6, 2, 23), NOW)).toBe(0);
    expect(dayOffset(day(2026, 6, 3, 1), NOW)).toBe(1);
    expect(dayOffset(day(2026, 6, 1, 23), NOW)).toBe(-1);
  });
});

describe("smart lists", () => {
  it("Today includes due-today and overdue, excludes future and completed", () => {
    const tasks = [
      task({ id: "today", due_at: day(2026, 6, 2, 20) }),
      task({ id: "overdue", due_at: day(2026, 6, 1) }),
      task({ id: "future", due_at: day(2026, 6, 5) }),
      task({ id: "done", due_at: day(2026, 6, 2), is_completed: true }),
      task({ id: "nodue" }),
    ];
    const ids = todayTasks(tasks, NOW)
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(["overdue", "today"]);
  });

  it("Upcoming lists future tasks ascending by due date", () => {
    const tasks = [
      task({ id: "far", due_at: day(2026, 6, 10) }),
      task({ id: "soon", due_at: day(2026, 6, 3) }),
      task({ id: "today", due_at: day(2026, 6, 2) }),
    ];
    expect(upcomingTasks(tasks, NOW).map((t) => t.id)).toEqual(["soon", "far"]);
  });

  it("Inbox is projectless active top-level tasks", () => {
    const tasks = [
      task({ id: "inbox" }),
      task({ id: "inproject", project_id: "p1" }),
      task({ id: "subtask", parent_id: "x" }),
      task({ id: "done", is_completed: true }),
    ];
    expect(inboxTasks(tasks).map((t) => t.id)).toEqual(["inbox"]);
  });

  it("isOverdue is time-sensitive and false for completed or future tasks", () => {
    expect(isOverdue(task({ due_at: day(2026, 6, 1) }), NOW)).toBe(true);
    // Task due earlier today (9:00 AM vs 12:00 PM) is overdue
    expect(isOverdue(task({ due_at: day(2026, 6, 2, 9) }), NOW)).toBe(true);
    // Task due later today (14:00 vs 12:00 PM) is not overdue
    expect(isOverdue(task({ due_at: day(2026, 6, 2, 14) }), NOW)).toBe(false);
    expect(isOverdue(task({ due_at: day(2026, 6, 1), is_completed: true }), NOW)).toBe(false);
  });

  it("buckets a task into a different day depending on the timezone", () => {
    // Now = 2026-07-15 12:00 UTC. Task due 2026-07-16 02:00 UTC — the next day in UTC, but still
    // 2026-07-15 (22:00) in New York (EDT, UTC-4), so it's "today" there and "upcoming" in UTC.
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const t = task({ id: "edge", due_at: Date.UTC(2026, 6, 16, 2, 0, 0) });
    expect(todayTasks([t], now, "UTC").map((x) => x.id)).toEqual([]);
    expect(upcomingTasks([t], now, "UTC").map((x) => x.id)).toEqual(["edge"]);
    expect(todayTasks([t], now, "America/New_York").map((x) => x.id)).toEqual(["edge"]);
    expect(upcomingTasks([t], now, "America/New_York").map((x) => x.id)).toEqual([]);
  });

  it("partitionToday splits overdue from due-today; union equals todayTasks", () => {
    const tasks = [
      task({ id: "today", due_at: day(2026, 6, 2, 20) }),
      task({ id: "overdue1", due_at: day(2026, 6, 1) }),
      task({ id: "overdue2", due_at: day(2026, 5, 20) }),
      task({ id: "future", due_at: day(2026, 6, 5) }),
      task({ id: "done", due_at: day(2026, 6, 1), is_completed: true }),
    ];
    const { overdue, today } = partitionToday(tasks, NOW);
    expect(overdue.map((t) => t.id).sort()).toEqual(["overdue1", "overdue2"]);
    expect(today.map((t) => t.id)).toEqual(["today"]);
    expect([...overdue, ...today].map((t) => t.id).sort()).toEqual(
      todayTasks(tasks, NOW)
        .map((t) => t.id)
        .sort(),
    );
  });

  it("partitionToday gives an empty overdue group when nothing is overdue", () => {
    const tasks = [task({ id: "today", due_at: day(2026, 6, 2, 20) })];
    const { overdue, today } = partitionToday(tasks, NOW);
    expect(overdue).toEqual([]);
    expect(today.map((t) => t.id)).toEqual(["today"]);
  });

  it("Assigned to me lists active tasks assigned to the user", () => {
    const tasks = [
      task({ id: "mine", assignee_id: "me" }),
      task({ id: "theirs", assignee_id: "you" }),
      task({ id: "mine-done", assignee_id: "me", is_completed: true }),
      task({ id: "unassigned" }),
    ];
    expect(assignedToMe(tasks, "me").map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("openTasks", () => {
  it("returns every task that is not completed", () => {
    const tasks: Task[] = [
      task({ id: "a", is_completed: false }),
      task({ id: "b", is_completed: true }),
      task({ id: "c", is_completed: false, project_id: "p1" }),
    ];
    expect(openTasks(tasks).map((t) => t.id)).toEqual(["a", "c"]);
  });
});
