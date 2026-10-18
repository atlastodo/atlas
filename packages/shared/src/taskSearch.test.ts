import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { searchTasks, TASK_SEARCH_LIMIT } from "./taskSearch";

/**
 * The matching rule (case-insensitive substring of title or notes) and the ranking (title above
 * notes, earlier/contiguous matches first via the palette's `scoreMatch`, stable ties). Scope (which
 * tasks are searched at all) is the caller's decision, so completed/trashed tasks are
 * searched like any other here.
 */

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "",
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

describe("searchTasks", () => {
  it("matches nothing on a blank query", () => {
    const tasks = [task({ title: "Buy milk" })];
    expect(searchTasks(tasks, "")).toEqual([]);
    expect(searchTasks(tasks, "   ")).toEqual([]);
  });

  it("matches titles case-insensitively", () => {
    const tasks = [task({ title: "Buy OAT milk" })];
    expect(searchTasks(tasks, "oat").map((h) => h.task.id)).toEqual(tasks.map((t) => t.id));
  });

  it("matches notes when the title does not match", () => {
    const tasks = [task({ title: "Groceries", notes: "get oat milk" })];
    const hits = searchTasks(tasks, "oat");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.field).toBe("notes");
  });

  it("requires a contiguous substring: a subsequence alone is not a match", () => {
    const tasks = [task({ title: "Buy milk" })];
    // "bm" appears in order but not contiguously: the palette's fuzzy rule must not leak in here.
    expect(searchTasks(tasks, "bm")).toEqual([]);
  });

  it("ranks a title hit above a notes hit", () => {
    const notes = task({ id: "notes", title: "Shopping", notes: "buy milk" });
    const title = task({ id: "title", title: "Milk run" });
    expect(searchTasks([notes, title], "milk").map((h) => h.task.id)).toEqual(["title", "notes"]);
  });

  it("ranks earlier matches first within a field", () => {
    const later = task({ id: "later", title: "Buy milk" });
    const earlier = task({ id: "earlier", title: "Milk the budget" });
    expect(searchTasks([later, earlier], "milk").map((h) => h.task.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("keeps the caller's order for equal scores", () => {
    const a = task({ id: "a", title: "Milk a" });
    const b = task({ id: "b", title: "Milk b" });
    expect(searchTasks([a, b], "milk").map((h) => h.task.id)).toEqual(["a", "b"]);
    expect(searchTasks([b, a], "milk").map((h) => h.task.id)).toEqual(["b", "a"]);
  });

  it("caps the result list at the limit, best first", () => {
    const tasks = Array.from({ length: TASK_SEARCH_LIMIT + 5 }, (_, i) =>
      task({ id: `t${i}`, title: `Milk ${i}`, sort_order: i }),
    );
    const hits = searchTasks(tasks, "milk");
    expect(hits).toHaveLength(TASK_SEARCH_LIMIT);
    // The default order ties on score, so the first tasks in store order win.
    expect(hits[0]?.task.id).toBe("t0");
  });

  it("honours a caller-supplied limit", () => {
    const tasks = [task({ title: "a one" }), task({ title: "a two" }), task({ title: "a three" })];
    expect(searchTasks(tasks, "a", 2)).toHaveLength(2);
  });

  it("searches every task it is handed, regardless of state", () => {
    // Scope (trash/archive/completion) is the caller's filter, not the matcher's.
    const tasks = [
      task({ id: "done", title: "Milk", is_completed: true, completed_at: 5 }),
      task({ id: "trashed", title: "Milk carton", deleted_at: 5 }),
    ];
    expect(searchTasks(tasks, "milk")).toHaveLength(2);
  });
});
