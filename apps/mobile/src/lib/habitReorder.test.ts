import { flattenHabitGroups, type Habit } from "@atlastodo/shared";
import { resolveHabitDrop } from "./habitReorder";

/**
 * The drop maths for the two-level habit list. Pure, so the rule is tested without a gesture --
 * the library is mocked in `jest-setup` and cannot lift a row.
 */

function makeHabit(over: Partial<Habit> = {}): Habit {
  return {
    id: "h",
    name: "Habit",
    kind: "habit",
    parent_id: null,
    goal_kind: "daily",
    days: [],
    target: 1,
    color: "#6366f1",
    icon: "hash",
    notes: "",
    steps: [],
    unit: "",
    reminder_time: null,
    schedule_history: [],
    archived_at: null,
    created_at: 0,
    sort_order: 0,
    ...over,
  };
}

/** solo(1) / group g(2) / member m1(3) / member m2(4) / solo2(5) */
const HABITS = [
  makeHabit({ id: "solo", sort_order: 1 }),
  makeHabit({ id: "g", kind: "group", sort_order: 2 }),
  makeHabit({ id: "m1", parent_id: "g", sort_order: 3 }),
  makeHabit({ id: "m2", parent_id: "g", sort_order: 4 }),
  makeHabit({ id: "solo2", sort_order: 5 }),
];
const rows = flattenHabitGroups(HABITS);

describe("resolveHabitDrop", () => {
  it("puts a standalone habit dragged into a group's block into that group", () => {
    // rows: solo(0) g(1) m1(2) m2(3) solo2(4) -- drop `solo` between m1 and m2.
    const drop = resolveHabitDrop(rows, 0, 2);
    expect(drop).toMatchObject({ id: "solo", parent_id: "g" });
    expect(drop!.sort_order).toBeGreaterThan(3);
    expect(drop!.sort_order).toBeLessThan(4);
  });

  it("takes a member dragged out below the group back to the top level", () => {
    // Drop `m1` at the end, past solo2.
    const drop = resolveHabitDrop(rows, 2, 4);
    expect(drop).toMatchObject({ id: "m1", parent_id: null });
    expect(drop!.sort_order).toBeGreaterThan(5);
  });

  it("keeps a within-group move inside the group", () => {
    const drop = resolveHabitDrop(rows, 3, 2); // m2 above m1
    expect(drop).toMatchObject({ id: "m2", parent_id: "g" });
    expect(drop!.sort_order).toBeLessThan(3);
  });

  it("ranks a top-level drop against the group header, not through it", () => {
    // `solo2` dragged to the very top, above `solo`.
    const drop = resolveHabitDrop(rows, 4, 0);
    expect(drop).toMatchObject({ id: "solo2", parent_id: null });
    expect(drop!.sort_order).toBeLessThan(1);
  });

  it("re-ranks a dragged group against the top level, carrying its members", () => {
    // rows: solo(0) g(1) m1(2) m2(3) solo2(4) -- drag the routine to the end, past solo2.
    const drop = resolveHabitDrop(rows, 1, 4);
    expect(drop).toMatchObject({ id: "g", parent_id: null });
    expect(drop!.sort_order).toBeGreaterThan(5);
    // Only the header is written: a member's rank is relative to its siblings and does not move.
  });

  it("ranks a dragged group above a standalone habit it was dropped over", () => {
    const drop = resolveHabitDrop(rows, 1, 0);
    expect(drop).toMatchObject({ id: "g", parent_id: null });
    expect(drop!.sort_order).toBeLessThan(1);
  });

  it("never lets a dragged group land inside another group", () => {
    // solo(0) g1(1) a(2) g2(3) b(4) -- drop g2 between g1's two positions.
    const nested = flattenHabitGroups([
      makeHabit({ id: "solo", sort_order: 1 }),
      makeHabit({ id: "g1", kind: "group", sort_order: 2 }),
      makeHabit({ id: "a", parent_id: "g1", sort_order: 3 }),
      makeHabit({ id: "g2", kind: "group", sort_order: 4 }),
      makeHabit({ id: "b", parent_id: "g2", sort_order: 5 }),
    ]);
    const drop = resolveHabitDrop(nested, 3, 2);
    expect(drop).toMatchObject({ id: "g2", parent_id: null });
    // Landed after g1 rather than among its members -- groups never nest.
    expect(drop!.sort_order).toBeGreaterThan(2);
  });

  it("is a no-op when the row did not move", () => {
    expect(resolveHabitDrop(rows, 2, 2)).toBeNull();
  });

  it("returns nothing for an index off the end", () => {
    expect(resolveHabitDrop(rows, 99, 0)).toBeNull();
  });

  it("drops into the group when a collapsed group hides its members", () => {
    // Collapsed: rows are solo(0) g(1) solo2(2). Dropping solo directly after the header still
    // means "into this group" -- there is nothing else it could mean.
    const collapsed = flattenHabitGroups(HABITS, () => false);
    expect(resolveHabitDrop(collapsed, 0, 1)).toMatchObject({ id: "solo", parent_id: "g" });
  });
});
