import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { columnCards, columnMoveManyWrites, columnMoveWrites, columnRoots } from "./boardMove";

const NOW = 1_700_000_000_000;
function task(overrides: Partial<Task>): Task {
  return {
    id: "t",
    project_id: "p1",
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

describe("columnCards", () => {
  it("returns a section's active cards ordered by sort_order, excluding a task", () => {
    const tasks = [
      task({ id: "a", section_id: "s1", sort_order: 2 }),
      task({ id: "b", section_id: "s1", sort_order: 1 }),
      task({ id: "c", section_id: "s2", sort_order: 1 }),
      task({ id: "d", section_id: "s1", sort_order: 3, is_completed: true }),
    ];
    expect(columnCards(tasks, "s1").map((t) => t.id)).toEqual(["b", "a"]);
    expect(columnCards(tasks, "s1", "b").map((t) => t.id)).toEqual(["a"]);
  });

  it("returns the no-section (null) group's active cards in order", () => {
    const tasks = [
      task({ id: "a", section_id: null, sort_order: 2 }),
      task({ id: "b", section_id: null, sort_order: 1 }),
      task({ id: "c", section_id: "s1", sort_order: 1 }),
    ];
    expect(columnCards(tasks, null).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("columnMoveWrites", () => {
  it("makes a single fractional write when the target neighbours have distinct ranks", () => {
    const cards = [
      task({ id: "a", section_id: "s1", sort_order: 0 }),
      task({ id: "b", section_id: "s1", sort_order: 10 }),
      task({ id: "c", section_id: "s1", sort_order: 20 }),
    ];
    // Move c between a (0) and b (10) -> midpoint 5, one row only.
    const writes = columnMoveWrites(cards, "c", "s1", 1);
    expect(writes).toEqual([{ id: "c", section_id: "s1", sort_order: 5 }]);
  });

  it("renumbers the column when neighbours share a rank (tied legacy ranks self-heal)", () => {
    // Every card created without a sort_order defaults to 0; a fractional midpoint can't separate
    // them, so the whole column is renumbered with the moved card slotted at the target index.
    const cards = [
      task({ id: "a", section_id: "s1", sort_order: 0, created_at: NOW + 1 }),
      task({ id: "b", section_id: "s1", sort_order: 0, created_at: NOW + 2 }),
      task({ id: "c", section_id: "s1", sort_order: 0, created_at: NOW + 3 }),
    ];
    // Order by (sort_order, created_at) is a, b, c. Move c to index 1 (between a and b).
    const writes = columnMoveWrites(cards, "c", "s1", 1);
    // a stays at 0; c takes index 1; b shifts to 2. Distinct ranks, well-defined order a, c, b.
    expect(writes).toContainEqual({ id: "c", section_id: "s1", sort_order: 1 });
    expect(writes).toContainEqual({ id: "b", section_id: "s1", sort_order: 2 });
    // a already sits at rank 0, so it needs no write.
    expect(writes.find((w) => w.id === "a")).toBeUndefined();
  });

  it("appends to the end of the target column and sets the section on a cross-column move", () => {
    const cards = [
      task({ id: "a", section_id: "s1", sort_order: 0 }),
      task({ id: "b", section_id: "s2", sort_order: 5 }),
    ];
    // Move a to the end of s2 (index past the last card) -> distinct neighbour (b=5) -> one write.
    const writes = columnMoveWrites(cards, "a", "s2", 99);
    expect(writes).toEqual([{ id: "a", section_id: "s2", sort_order: 6 }]);
  });

  it("ranks among the column's cards, not the subtasks nested in them", () => {
    const tasks = [
      task({ id: "p", section_id: "s1", sort_order: 0 }),
      task({ id: "p-sub", section_id: "s1", parent_id: "p", sort_order: 1 }),
      task({ id: "q", section_id: "s1", sort_order: 1 }),
      task({ id: "x", section_id: "s2", sort_order: 0 }),
    ];
    // Index 1 is between p and q; p's subtask (rank 1, tied with q) must not count as a neighbour.
    expect(columnMoveWrites(tasks, "x", "s1", 1).find((w) => w.id === "x")).toEqual({
      id: "x",
      section_id: "s1",
      sort_order: 0.5,
    });
  });

  it("carries a card's whole subtree to its new column, keeping the subtasks' ranks", () => {
    const tasks = [
      task({ id: "p", section_id: "s1", sort_order: 0 }),
      task({ id: "c1", section_id: "s1", parent_id: "p", sort_order: 7 }),
      task({ id: "c2", section_id: "s1", parent_id: "c1", sort_order: 3, is_completed: true }),
      task({ id: "other", section_id: "s1", sort_order: 1 }),
    ];
    const writes = columnMoveWrites(tasks, "p", "s2", 0);
    expect(writes).toEqual([
      { id: "p", section_id: "s2", sort_order: 0 },
      { id: "c1", section_id: "s2" },
      { id: "c2", section_id: "s2" },
    ]);
  });

  it("writes no subtasks for a reorder within the same column", () => {
    const tasks = [
      task({ id: "p", section_id: "s1", sort_order: 0 }),
      task({ id: "c1", section_id: "s1", parent_id: "p", sort_order: 0 }),
      task({ id: "q", section_id: "s1", sort_order: 10 }),
    ];
    expect(columnMoveWrites(tasks, "p", "s1", 1).map((w) => w.id)).toEqual(["p"]);
  });
});

describe("columnRoots", () => {
  it("nests a subtask under a parent in the same column, but not one whose parent is elsewhere", () => {
    const tasks = [
      task({ id: "p", section_id: "s1", sort_order: 0 }),
      task({ id: "p-sub", section_id: "s1", parent_id: "p", sort_order: 0 }),
      task({ id: "far-sub", section_id: "s1", parent_id: "in-s2", sort_order: 1 }),
      task({ id: "done", section_id: "s1", sort_order: 2, is_completed: true }),
      task({ id: "done-sub", section_id: "s1", parent_id: "done", sort_order: 3 }),
      task({ id: "in-s2", section_id: "s2", sort_order: 0 }),
    ];
    expect(columnRoots(tasks, "s1").map((t) => t.id)).toEqual(["p", "far-sub", "done-sub"]);
  });

  it("drops only the excluded card, leaving its subtasks nested", () => {
    const tasks = [
      task({ id: "p", section_id: "s1", sort_order: 0 }),
      task({ id: "p-sub", section_id: "s1", parent_id: "p", sort_order: 0 }),
      task({ id: "q", section_id: "s1", sort_order: 1 }),
    ];
    expect(columnRoots(tasks, "s1", "p").map((t) => t.id)).toEqual(["q"]);
  });
});

describe("columnMoveManyWrites", () => {
  it("appends the cards to the column in order, carrying their subtasks", () => {
    const tasks = [
      task({ id: "x", section_id: "b", sort_order: 1 }),
      task({ id: "a", section_id: "a", sort_order: 1 }),
      task({ id: "a1", section_id: "a", parent_id: "a", sort_order: 1 }),
      task({ id: "c", section_id: null, sort_order: 2 }),
    ];
    const writes = columnMoveManyWrites(tasks, ["a", "c"], "b");
    const byId = new Map(writes.map((w) => [w.id, w]));
    expect(byId.get("a")?.section_id).toBe("b");
    expect(byId.get("c")?.section_id).toBe("b");
    expect(byId.get("a1")).toEqual({ id: "a1", section_id: "b" });
    const order = (id: string) =>
      byId.get(id)?.sort_order ?? tasks.find((t) => t.id === id)!.sort_order;
    expect(order("x")).toBeLessThan(order("a"));
    expect(order("a")).toBeLessThan(order("c"));
  });
});
