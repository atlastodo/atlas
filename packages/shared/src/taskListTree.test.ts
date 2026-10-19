import { describe, expect, it } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { taskContextClosure, taskListSections, type TaskListTreeOptions } from "./taskListTree";

// A fixed "now" so the date buckets are deterministic: 2023-11-14T22:13:20Z.
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: id,
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

const opts = (over: Partial<TaskListTreeOptions> = {}): TaskListTreeOptions => ({
  groupBy: "none",
  now: NOW,
  sortBy: "manual",
  projectOrder: [],
  labelOrder: [],
  ...over,
});

const ids = (tasks: Task[]) => tasks.map((t) => t.id).sort();
/** Every rendered row across every section, in display order, as "id@depth". */
const rowIds = (sections: { rows: { task: Task; depth: number }[] }[]) =>
  sections.flatMap((s) => s.rows.map((r) => `${r.task.id}@${r.depth}`));

describe("taskContextClosure", () => {
  it("pulls in the open subtree below a matched task", () => {
    const all = [
      task("parent"),
      task("child", { parent_id: "parent" }),
      task("grandchild", { parent_id: "child" }),
      task("stranger"),
    ];
    const matched = [all[0]!];
    const kept = taskContextClosure(matched, all, new Set(["parent"]));
    expect(ids(kept)).toEqual(["child", "grandchild", "parent"]);
  });

  it("leaves completed subtasks out", () => {
    const all = [
      task("parent"),
      task("done", { parent_id: "parent", is_completed: true }),
      // Below a completed child, so unreachable; the walk stops at "done".
      task("buried", { parent_id: "done" }),
      task("open", { parent_id: "parent" }),
    ];
    const kept = taskContextClosure([all[0]!], all, new Set(["parent"]));
    expect(ids(kept)).toEqual(["open", "parent"]);
  });

  it("pulls in the parents needed to reach a matched subtask", () => {
    const all = [
      task("grandparent"),
      task("parent", { parent_id: "grandparent" }),
      task("child", { parent_id: "parent" }),
    ];
    const kept = taskContextClosure([all[2]!], all, new Set(["child"]));
    expect(ids(kept)).toEqual(["child", "grandparent", "parent"]);
  });

  it("stops the upward walk at a completed parent", () => {
    // Matches the project view, where a completed parent has moved to its own Done section.
    const all = [
      task("grandparent"),
      task("parent", { parent_id: "grandparent", is_completed: true }),
      task("child", { parent_id: "parent" }),
    ];
    const kept = taskContextClosure([all[2]!], all, new Set(["child"]));
    expect(ids(kept)).toEqual(["child"]);
  });

  it("stops both walks at a task that matched in its own right", () => {
    // "parent" is matched (it renders in whichever group it landed in, with its own children), so
    // neither the walk down from "grandparent" nor the walk up from "child" absorbs it.
    const all = [
      task("grandparent"),
      task("parent", { parent_id: "grandparent" }),
      task("child", { parent_id: "parent" }),
    ];
    const matchedIds = new Set(["grandparent", "parent"]);
    expect(ids(taskContextClosure([all[0]!], all, matchedIds))).toEqual(["grandparent"]);
    expect(ids(taskContextClosure([all[1]!], all, matchedIds))).toEqual(["child", "parent"]);
  });

  it("treats a parent_id pointing outside the set as no parent", () => {
    const all = [task("child", { parent_id: "gone" })];
    expect(ids(taskContextClosure(all, all, new Set(["child"])))).toEqual(["child"]);
  });

  it("terminates on cyclic data", () => {
    const all = [task("a", { parent_id: "b" }), task("b", { parent_id: "a" })];
    const kept = taskContextClosure([all[0]!], all, new Set(["a"]));
    expect(ids(kept)).toEqual(["a", "b"]);
  });
});

describe("taskListSections: nesting", () => {
  it("nests an undated subtask under a parent that matched a dated view", () => {
    // Today matches only the parent, so the child must be pulled into the set.
    const all = [
      task("parent", { due_at: NOW }),
      task("child", { parent_id: "parent" }),
      task("other", { due_at: NOW }),
    ];
    const matched = [all[0]!, all[2]!];
    const sections = taskListSections(matched, opts({ allTasks: all }));
    expect(rowIds(sections)).toEqual(["parent@0", "child@1", "other@0"]);
    expect(sections[0]!.rows.map((r) => r.matched)).toEqual([true, false, true]);
  });

  it("pulls a parent in as context so a matched subtask can nest under it", () => {
    const all = [task("parent", { due_at: NOW + 7 * DAY }), task("child", { parent_id: "parent" })];
    const sections = taskListSections([all[1]!], opts({ allTasks: all }));
    expect(rowIds(sections)).toEqual(["parent@0", "child@1"]);
    expect(sections[0]!.rows[0]!.matched).toBe(false);
    // The header count and any group bulk action see only the real match.
    expect(sections[0]!.matched.map((t) => t.id)).toEqual(["child"]);
  });

  it("counts completed children in the progress marker without rendering them", () => {
    const all = [
      task("parent"),
      task("open", { parent_id: "parent" }),
      task("done", { parent_id: "parent", is_completed: true }),
    ];
    const sections = taskListSections([all[0]!], opts({ allTasks: all }));
    expect(rowIds(sections)).toEqual(["parent@0", "open@1"]);
    const parent = sections[0]!.rows[0]!;
    expect(parent.childCount).toBe(1);
    expect(parent.completedChildCount).toBe(1);
    expect(parent.hasChildren).toBe(true);
  });

  it("folds a collapsed subtree while keeping its parent row", () => {
    const all = [task("parent"), task("child", { parent_id: "parent" })];
    const sections = taskListSections([all[0]!], opts({ allTasks: all }));
    expect(rowIds(sections)).toEqual(["parent@0", "child@1"]);
    const folded = taskListSections(
      [all[0]!],
      opts({ allTasks: all, collapsedTasks: new Set(["parent"]) }),
    );
    expect(rowIds(folded)).toEqual(["parent@0"]);
    expect(folded[0]!.rows[0]!.hasChildren).toBe(true);
  });
});

describe("taskListSections: grouping", () => {
  it("keeps a parent and child that landed in different buckets in their own buckets", () => {
    // Nesting across buckets is impossible; what matters is that neither row is duplicated or lost,
    // and that no bucket is emptied by the widening.
    const all = [
      task("parent", { due_at: NOW - 2 * DAY }),
      task("child", { parent_id: "parent", due_at: NOW }),
    ];
    const sections = taskListSections(all, opts({ groupBy: "date", allTasks: all }));
    expect(sections.map((s) => s.key)).toEqual(["overdue", "today"]);
    expect(rowIds(sections)).toEqual(["parent@0", "child@0"]);
    expect(sections.every((s) => s.rows.every((r) => r.matched))).toBe(true);
  });

  it("renders each task at most once across all sections", () => {
    const all = [
      task("parent", { due_at: NOW - 2 * DAY }),
      task("child", { parent_id: "parent", due_at: NOW }),
      task("undated", { parent_id: "parent" }),
    ];
    const sections = taskListSections([all[0]!, all[1]!], opts({ groupBy: "date", allTasks: all }));
    const rendered = sections.flatMap((s) => s.rows.map((r) => r.task.id));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it("places a context parent where its earliest matched descendant sat", () => {
    const all = [
      task("first", { sort_order: 1 }),
      task("hidden", { sort_order: 2 }),
      task("nested", { parent_id: "hidden", sort_order: 3 }),
      task("last", { sort_order: 4 }),
    ];
    // "hidden" did not match; it is pulled in only to carry "nested", which sat second.
    const sections = taskListSections([all[0]!, all[2]!, all[3]!], opts({ allTasks: all }));
    expect(rowIds(sections)).toEqual(["first@0", "hidden@0", "nested@1", "last@0"]);
  });
});

describe("taskListSections: ordering", () => {
  it("orders roots and siblings by the chosen sort, not by sort_order", () => {
    const all = [
      task("Charlie", { sort_order: 1 }),
      task("Alpha", { sort_order: 2 }),
      task("zulu", { parent_id: "Alpha", sort_order: 1 }),
      task("beta", { parent_id: "Alpha", sort_order: 2 }),
    ];
    const sections = taskListSections(all, opts({ sortBy: "alpha", allTasks: all }));
    expect(rowIds(sections)).toEqual(["Alpha@0", "beta@1", "zulu@1", "Charlie@0"]);
  });

  it("orders by due date when asked", () => {
    const all = [
      task("later", { due_at: NOW + 2 * DAY }),
      task("sooner", { due_at: NOW }),
      task("undated"),
    ];
    const sections = taskListSections(all, opts({ sortBy: "due", allTasks: all }));
    expect(rowIds(sections)).toEqual(["sooner@0", "later@0", "undated@0"]);
  });

  it("keeps the Completed view's newest-completed-first buckets", () => {
    // No allTasks: the Completed view opts out of widening, but must still keep its own order.
    const all = [
      task("old", { is_completed: true, completed_at: NOW - 3600_000, sort_order: 1 }),
      task("new", { is_completed: true, completed_at: NOW, sort_order: 2 }),
    ];
    const sections = taskListSections(all, opts({ groupBy: "completed" }));
    expect(sections.map((s) => s.key)).toEqual(["today"]);
    expect(rowIds(sections)).toEqual(["new@0", "old@0"]);
  });

  it("without allTasks, behaves exactly as an un-widened per-group flatten", () => {
    const all = [task("parent"), task("child", { parent_id: "parent" })];
    // Only the child matched, and there is no full set to reach the parent through: orphan rule.
    const sections = taskListSections([all[1]!], opts());
    expect(rowIds(sections)).toEqual(["child@0"]);
    expect(sections[0]!.rows[0]!.matched).toBe(true);
  });
});
