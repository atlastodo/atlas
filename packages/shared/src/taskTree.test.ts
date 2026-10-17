import { describe, expect, it } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  buildTaskTree,
  flattenTree,
  indentTarget,
  outdentTarget,
  rankAfterChildren,
  resolveIndentTarget,
  subtreeProgress,
  wouldCycle,
} from "./taskTree";

const NOW = 1_700_000_000_000;

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

const ids = (rows: { task: Task }[]) => rows.map((r) => r.task.id);

describe("buildTaskTree", () => {
  it("nests children under parents, each level ordered by sort_order", () => {
    const tasks = [
      task("a", { sort_order: 2 }),
      task("b", { sort_order: 1 }),
      task("a2", { parent_id: "a", sort_order: 2 }),
      task("a1", { parent_id: "a", sort_order: 1 }),
    ];
    const tree = buildTaskTree(tasks);
    expect(tree.map((n) => n.task.id)).toEqual(["b", "a"]); // roots by sort_order
    const a = tree.find((n) => n.task.id === "a")!;
    expect(a.children.map((c) => c.task.id)).toEqual(["a1", "a2"]);
    expect(a.depth).toBe(0);
    expect(a.children[0]!.depth).toBe(1);
  });

  it("supports multiple levels", () => {
    const tasks = [task("a"), task("a1", { parent_id: "a" }), task("a1x", { parent_id: "a1" })];
    const tree = buildTaskTree(tasks);
    expect(tree[0]!.children[0]!.children[0]!.task.id).toBe("a1x");
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it("treats a task whose parent is absent from the set as a root (orphan rule)", () => {
    // "a1" 's parent "a" is not in the set -> it surfaces at depth 0.
    const tree = buildTaskTree([task("a1", { parent_id: "a" }), task("b")]);
    expect(tree.map((n) => n.task.id).sort()).toEqual(["a1", "b"]);
    expect(tree.every((n) => n.depth === 0)).toBe(true);
  });

  it("honours an injected sibling and root order", () => {
    const tasks = [
      task("b", { sort_order: 1 }),
      task("a", { sort_order: 2 }),
      task("a2", { parent_id: "a", sort_order: 1 }),
      task("a1", { parent_id: "a", sort_order: 2 }),
    ];
    const alpha = (x: Task, y: Task) => x.title.localeCompare(y.title);
    const tree = buildTaskTree(tasks, { compareSiblings: alpha });
    expect(tree.map((n) => n.task.id)).toEqual(["a", "b"]); // not sort_order's b, a
    expect(tree[0]!.children.map((c) => c.task.id)).toEqual(["a1", "a2"]);
  });

  it("lets compareRoots differ from compareSiblings", () => {
    const tasks = [
      task("b", { sort_order: 1 }),
      task("a", { sort_order: 2 }),
      task("a2", { parent_id: "a", sort_order: 1 }),
      task("a1", { parent_id: "a", sort_order: 2 }),
    ];
    const tree = buildTaskTree(tasks, {
      // Roots reversed alphabetically, children left on the default sort_order.
      compareRoots: (x, y) => y.title.localeCompare(x.title),
    });
    expect(tree.map((n) => n.task.id)).toEqual(["b", "a"]);
    expect(tree[1]!.children.map((c) => c.task.id)).toEqual(["a2", "a1"]);
  });
});

describe("flattenTree", () => {
  const tasks = [
    task("a"),
    task("a1", { parent_id: "a" }),
    task("a2", { parent_id: "a", is_completed: true }),
    task("b"),
  ];

  it("emits a pre-order list with depths and direct-child progress counts", () => {
    const rows = flattenTree(tasks);
    expect(ids(rows)).toEqual(["a", "a1", "a2", "b"]);
    const a = rows[0]!;
    expect(a.depth).toBe(0);
    expect(a.hasChildren).toBe(true);
    expect(a.childCount).toBe(1); // a1 open
    expect(a.completedChildCount).toBe(1); // a2 done
    expect(rows[1]!.depth).toBe(1);
  });

  it("hides descendants of a collapsed task but keeps the task's own row", () => {
    const rows = flattenTree(tasks, new Set(["a"]));
    expect(ids(rows)).toEqual(["a", "b"]);
    expect(rows[0]!.hasChildren).toBe(true); // still marked as a parent
  });
});

describe("subtreeProgress", () => {
  it("counts the whole subtree recursively", () => {
    const tasks = [
      task("a"),
      task("a1", { parent_id: "a", is_completed: true }),
      task("a1x", { parent_id: "a1" }),
      task("a2", { parent_id: "a" }),
    ];
    const a = buildTaskTree(tasks)[0]!;
    expect(subtreeProgress(a)).toEqual({ done: 1, total: 3 });
  });
});

describe("wouldCycle", () => {
  const tasks = [task("a"), task("a1", { parent_id: "a" }), task("a1x", { parent_id: "a1" })];
  it("rejects nesting a task under itself", () => {
    expect(wouldCycle(tasks, "a", "a")).toBe(true);
  });
  it("rejects nesting a task under its own descendant", () => {
    expect(wouldCycle(tasks, "a", "a1x")).toBe(true);
  });
  it("allows a valid reparent and reparent-to-root", () => {
    expect(wouldCycle(tasks, "a1x", "a")).toBe(false);
    expect(wouldCycle(tasks, "a1", null)).toBe(false);
  });
});

describe("rankAfterChildren", () => {
  it("ranks after the parent's current last child", () => {
    const tasks = [
      task("a"),
      task("a1", { parent_id: "a", sort_order: 10 }),
      task("a2", { parent_id: "a", sort_order: 20 }),
    ];
    expect(rankAfterChildren(tasks, "a")).toBe(21); // rankBetween(20, null)
  });

  it("is 0 for a parent with no children yet", () => {
    expect(rankAfterChildren([task("a")], "a")).toBe(0);
  });
});

describe("indentTarget / outdentTarget", () => {
  it("indents a task under its preceding sibling", () => {
    const tasks = [
      task("a", { sort_order: 10 }),
      task("b", { sort_order: 20 }),
      task("c", { sort_order: 30 }),
    ];
    // b indents under a (its preceding sibling), ranked as a's first child.
    expect(indentTarget(tasks, "b")).toMatchObject({ parent_id: "a", sort_order: 0 });
  });

  it("won't indent the first item (no preceding sibling)", () => {
    const tasks = [task("a", { sort_order: 10 }), task("b", { sort_order: 20 })];
    expect(indentTarget(tasks, "a")).toBeNull();
  });

  it("outdents a child up to its grandparent, after its former parent", () => {
    const tasks = [
      task("a", { sort_order: 10 }),
      task("a1", { parent_id: "a", sort_order: 10 }),
      task("b", { sort_order: 20 }),
    ];
    // a1 outdents to root (a's parent), ranked between a (10) and b (20) -> 15.
    expect(outdentTarget(tasks, "a1")).toMatchObject({ parent_id: null, sort_order: 15 });
  });

  it("won't outdent a top-level task", () => {
    expect(outdentTarget([task("a")], "a")).toBeNull();
  });

  it("never indents across different project boundaries", () => {
    const tasks = [
      task("proj1-a", { project_id: "p1", sort_order: 10 }),
      task("proj1-b", { project_id: "p1", sort_order: 20 }),
      task("inbox-a", { project_id: null, sort_order: 15 }),
      task("inbox-b", { project_id: null, sort_order: 25 }),
    ];
    // inbox-a is the first task in inbox, even though proj1-a has lower sort_order
    expect(indentTarget(tasks, "inbox-a")).toBeNull();
    // inbox-b indents under inbox-a, NOT proj1-b
    expect(indentTarget(tasks, "inbox-b")).toMatchObject({ parent_id: "inbox-a", sort_order: 0 });
  });

  it("never indents across different section boundaries", () => {
    const tasks = [
      task("sec1-a", { project_id: "p1", section_id: "s1", sort_order: 10 }),
      task("sec2-a", { project_id: "p1", section_id: "s2", sort_order: 15 }),
      task("sec2-b", { project_id: "p1", section_id: "s2", sort_order: 20 }),
    ];
    // sec2-a is first in sec2, should not indent under sec1-a
    expect(indentTarget(tasks, "sec2-a")).toBeNull();
    // sec2-b indents under sec2-a
    expect(indentTarget(tasks, "sec2-b")).toMatchObject({ parent_id: "sec2-a", sort_order: 0 });
  });

  it("ranks after children in the full rankPool when supplied", () => {
    const visibleTasks = [task("a", { sort_order: 10 }), task("b", { sort_order: 20 })];
    const allTasks = [
      task("a", { sort_order: 10 }),
      task("a-hidden-child", { parent_id: "a", sort_order: 50 }),
      task("b", { sort_order: 20 }),
    ];
    // With rankPool provided, sort_order is ranked after the hidden child (50)
    expect(indentTarget(visibleTasks, "b", allTasks)).toMatchObject({
      parent_id: "a",
      sort_order: 51,
    });
  });
});

describe("resolveIndentTarget", () => {
  // Flat rows: a, b, c at depth 0 (each with a spread-out sort_order).
  const flat = () =>
    flattenTree([
      task("a", { sort_order: 10 }),
      task("b", { sort_order: 20 }),
      task("c", { sort_order: 30 }),
    ]);

  it("nests a row dropped between a parent and its child (drop in the child zone)", () => {
    // Rows: a(0), a1(1 child of a), b(0). Drag b (index 2) up to between a and a1 (index 1).
    const rows = flattenTree([
      task("a", { sort_order: 10 }),
      task("a1", { parent_id: "a", sort_order: 10 }),
      task("b", { sort_order: 20 }),
    ]);
    const res = resolveIndentTarget(rows, 2, 1);
    expect(res).toMatchObject({ id: "b", parent_id: "a", sort_order: expect.any(Number) });
  });

  it("keeps a top-level drop top-level", () => {
    // Move c to the top: it stays a root (parent null), ranked before a.
    const res = resolveIndentTarget(flat(), 2, 0);
    expect(res!.id).toBe("c");
    expect(res!.parent_id).toBeNull();
    expect(res!.sort_order).toBeLessThan(10);
  });

  it("clears the parent when a subtask is dragged out to a top-level gap", () => {
    // Rows: a(0), a1(1 child of a), b(0), c(0). Drag a1 (index 1) down between b and c (index 2).
    const rows = flattenTree([
      task("a", { sort_order: 10 }),
      task("a1", { parent_id: "a", sort_order: 10 }),
      task("b", { sort_order: 20 }),
      task("c", { sort_order: 30 }),
    ]);
    const res = resolveIndentTarget(rows, 1, 2);
    expect(res!.id).toBe("a1");
    expect(res!.parent_id).toBeNull(); // moved away from a -> no longer its subtask
  });

  it("rejects a move that would create a cycle", () => {
    const rows = flattenTree([task("a"), task("a1", { parent_id: "a" })]);
    // Drag a (index 0) down under its own child a1 -> cycle -> null.
    expect(resolveIndentTarget(rows, 0, 1)).toBeNull();
  });

  it("is a no-op when dropped where it started", () => {
    expect(resolveIndentTarget(flat(), 1, 1)).toBeNull();
  });
});

describe("tied ranks in the tree", () => {
  type Write = { id: string; sort_order: number };
  /** Root order after applying a move's writes (rank, then creation). */
  const orderAfter = (
    tasks: Task[],
    move: { sort_order: number; writes?: Write[] },
    id: string,
  ) => {
    const writes = move.writes ?? [{ id, sort_order: move.sort_order }];
    const rank = new Map(tasks.map((t) => [t.id, t.sort_order]));
    for (const w of writes) rank.set(w.id, w.sort_order);
    return [...tasks]
      .sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || a.created_at - b.created_at)
      .map((t) => t.id);
  };
  const tied = () => ["A", "B", "C", "D"].map((id, i) => task(id, { created_at: NOW + i }));

  it("resolveIndentTarget moves D to index 1 among [A0,B0,C0,D0]", () => {
    const tasks = tied();
    const move = resolveIndentTarget(flattenTree(tasks), 3, 1)!;
    expect(move.parent_id).toBeNull();
    expect(orderAfter(tasks, move, "D")).toEqual(["A", "D", "B", "C"]);
  });

  it("outdentTarget lands right after the former parent even when it ties with the next task", () => {
    const tasks = [
      task("P", { created_at: NOW }),
      // Created after Q, so a tied rank would sort it after Q.
      task("X", { parent_id: "P", created_at: NOW + 2 }),
      task("Q", { created_at: NOW + 1 }),
    ];
    const move = outdentTarget(tasks, "X")!;
    expect(move.parent_id).toBeNull();
    const roots = tasks.filter((t) => t.id !== "X").concat({ ...tasks[1]!, parent_id: null });
    expect(orderAfter(roots, move, "X")).toEqual(["P", "X", "Q"]);
  });
});
