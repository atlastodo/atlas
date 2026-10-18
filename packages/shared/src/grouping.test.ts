import { describe, expect, it } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { completedBucket, groupTasks, sortTasks, type GroupContext } from "./grouping";

// Fixed reference: 2026-07-15 12:00 UTC (a Wednesday).
const NOW = Date.UTC(2026, 6, 15, 12);
const DAY = 86_400_000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Task",
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
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const ctx = (over: Partial<GroupContext> = {}): GroupContext => ({
  now: NOW,
  timeZone: "UTC",
  sortBy: "manual",
  projectOrder: [],
  labelOrder: [],
  ...over,
});

describe("sortTasks", () => {
  it("manual sorts by sort_order then created_at", () => {
    const tasks = [
      task({ id: "a", sort_order: 2 }),
      task({ id: "b", sort_order: 1 }),
      task({ id: "c", sort_order: 1, created_at: -1 }),
    ];
    expect(sortTasks(tasks, "manual").map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("due sorts ascending with no-due tasks last", () => {
    const tasks = [
      task({ id: "none" }),
      task({ id: "late", due_at: NOW + 5 * DAY }),
      task({ id: "soon", due_at: NOW + DAY }),
    ];
    expect(sortTasks(tasks, "due").map((t) => t.id)).toEqual(["soon", "late", "none"]);
  });

  it("priority sorts P1 first and none (P4) last", () => {
    const tasks = [
      task({ id: "p4", priority: 4 }),
      task({ id: "p1", priority: 1 }),
      task({ id: "p2", priority: 2 }),
    ];
    expect(sortTasks(tasks, "priority").map((t) => t.id)).toEqual(["p1", "p2", "p4"]);
  });

  it("alpha sorts case-insensitively by title", () => {
    const tasks = [task({ id: "b", title: "banana" }), task({ id: "a", title: "Apple" })];
    expect(sortTasks(tasks, "alpha").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("created and modified sort newest first", () => {
    const tasks = [
      task({ id: "old", created_at: 1, updated_at: 1 }),
      task({ id: "new", created_at: 9, updated_at: 9 }),
    ];
    expect(sortTasks(tasks, "created").map((t) => t.id)).toEqual(["new", "old"]);
    expect(sortTasks(tasks, "modified").map((t) => t.id)).toEqual(["new", "old"]);
  });
});

describe("groupTasks", () => {
  it("none yields a single group of all tasks (sorted)", () => {
    const groups = groupTasks([task({ id: "a" }), task({ id: "b" })], "none", ctx());
    expect(groups).toHaveLength(1);
    expect(groups[0]!.tasks).toHaveLength(2);
  });

  it("date buckets in chronological order with overdue flagged danger", () => {
    const tasks = [
      task({ id: "later", due_at: NOW + 30 * DAY }),
      task({ id: "overdue", due_at: NOW - 3 * DAY }),
      task({ id: "today", due_at: NOW }),
      task({ id: "tomorrow", due_at: NOW + DAY }),
      task({ id: "none" }),
    ];
    const groups = groupTasks(tasks, "date", ctx());
    expect(groups.map((g) => g.key)).toEqual(["overdue", "today", "tomorrow", "later", "none"]);
    expect(groups.find((g) => g.key === "overdue")!.accent).toBe("danger");
  });

  it("priority groups P1/P2/P3/none, omitting empty ones", () => {
    const tasks = [task({ id: "a", priority: 1 }), task({ id: "b", priority: 4 })];
    const groups = groupTasks(tasks, "priority", ctx());
    expect(groups.map((g) => g.key)).toEqual(["p1", "none"]);
  });

  it("project groups follow projectOrder then inbox", () => {
    const tasks = [
      task({ id: "x", project_id: "p2" }),
      task({ id: "y", project_id: "p1" }),
      task({ id: "z" }),
    ];
    const groups = groupTasks(tasks, "project", ctx({ projectOrder: ["p1", "p2"] }));
    expect(groups.map((g) => g.key)).toEqual(["p1", "p2", "inbox"]);
  });

  it("label groups place a multi-label task under each of its labels, plus a no-label group", () => {
    const tasks = [task({ id: "multi", label_ids: ["l1", "l2"] }), task({ id: "bare" })];
    const groups = groupTasks(tasks, "label", ctx({ labelOrder: ["l1", "l2"] }));
    expect(groups.map((g) => g.key)).toEqual(["l1", "l2", "none"]);
    expect(groups.find((g) => g.key === "l1")!.tasks.map((t) => t.id)).toEqual(["multi"]);
    expect(groups.find((g) => g.key === "l2")!.tasks.map((t) => t.id)).toEqual(["multi"]);
    expect(groups.find((g) => g.key === "none")!.tasks.map((t) => t.id)).toEqual(["bare"]);
  });
});

describe("completedBucket", () => {
  it("buckets by how long ago a task was completed", () => {
    expect(completedBucket(NOW, NOW, "UTC")).toBe("today"); // today
    expect(completedBucket(NOW - 1 * DAY, NOW, "UTC")).toBe("thisWeek"); // yesterday
    expect(completedBucket(NOW - 6 * DAY, NOW, "UTC")).toBe("thisWeek"); // 6 days ago
    expect(completedBucket(NOW - 7 * DAY, NOW, "UTC")).toBe("thisMonth"); // 7 days ago
    expect(completedBucket(NOW - 29 * DAY, NOW, "UTC")).toBe("thisMonth"); // 29 days ago
    expect(completedBucket(NOW - 30 * DAY, NOW, "UTC")).toBe("older"); // 30 days ago
  });
});

describe("groupTasks (completed)", () => {
  it("groups by completion recency, newest first within each bucket, empty buckets omitted", () => {
    const tasks = [
      task({ id: "old", is_completed: true, completed_at: NOW - 40 * DAY }),
      task({ id: "today", is_completed: true, completed_at: NOW }),
      task({ id: "recent1", is_completed: true, completed_at: NOW - 1 * DAY }),
      task({ id: "recent2", is_completed: true, completed_at: NOW - 2 * DAY }),
      task({ id: "mid", is_completed: true, completed_at: NOW - 10 * DAY }),
    ];
    const groups = groupTasks(tasks, "completed", ctx());
    expect(groups.map((g) => g.key)).toEqual(["today", "thisWeek", "thisMonth", "older"]);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["today"]);
    // Newest-completed first inside the week bucket.
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["recent1", "recent2"]);
    expect(groups[2]!.tasks.map((t) => t.id)).toEqual(["mid"]);
    expect(groups[3]!.tasks.map((t) => t.id)).toEqual(["old"]);
  });

  it("is not offered as a normal grouping option (absent from the group menu list)", async () => {
    const { GROUP_BYS } = await import("./grouping");
    expect(GROUP_BYS).not.toContain("completed");
  });
});
