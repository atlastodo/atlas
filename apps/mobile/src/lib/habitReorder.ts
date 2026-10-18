import { rankBetween, type HabitListRow } from "@atlastodo/shared";

/**
 * Where a dragged habit landed in the two-level list.
 *
 * `react-native-reorderable-list` cannot drag between lists, so groups and members are one flat
 * list of interleaved rows (as `lib/sectionReorder`). A drag can then cross a group header, so the
 * resolver must rank the row against its new container's siblings or it would snap back.
 *
 * A group travels with its members: a dragged header arrives alone, but members are ranked among
 * themselves (`flattenHabitGroups`), so re-ranking the header is the whole block move. Move up /
 * Move down stay in the group's menu as the accessible path.
 */
export interface HabitDrop {
  id: string;
  parent_id: string | null;
  sort_order: number;
}

/** The group a row belongs to as drawn, or null at the top level. */
function containerOf(row: HabitListRow): string | null {
  return row.kind === "group" ? row.group.id : row.habit.parent_id;
}

/** A row that ranks at the top level: a group header, or a habit in no group. */
function isTopLevel(row: HabitListRow): boolean {
  return row.kind === "group" || row.habit.parent_id === null;
}

function sortOrderOf(row: HabitListRow): number {
  return row.kind === "group" ? row.group.sort_order : row.habit.sort_order;
}

/**
 * A dropped routine, ranked against the top level alone. Groups never nest, so a header dropped
 * among another routine's members lands after that routine.
 */
function resolveGroupDrop(next: HabitListRow[], to: number, id: string): HabitDrop {
  let before: number | null = null;
  for (let i = to - 1; i >= 0; i--) {
    const row = next[i]!;
    if (!isTopLevel(row)) continue;
    before = sortOrderOf(row);
    break;
  }
  let after: number | null = null;
  for (let i = to + 1; i < next.length; i++) {
    const row = next[i]!;
    if (!isTopLevel(row)) continue;
    after = sortOrderOf(row);
    break;
  }
  return { id, parent_id: null, sort_order: rankBetween(before, after) };
}

export function resolveHabitDrop(rows: HabitListRow[], from: number, to: number): HabitDrop | null {
  if (from === to) return null;
  const moving = rows[from];
  if (!moving) return null;

  const next = rows.slice();
  next.splice(from, 1);
  next.splice(to, 0, moving);

  if (moving.kind === "group") return resolveGroupDrop(next, to, moving.group.id);

  // The container is the nearest group header above the landing spot -- unless a top-level row sits
  // between, which closes that group off. A drop above every header is the top level.
  let parent: string | null = null;
  for (let i = to - 1; i >= 0; i--) {
    const row = next[i]!;
    if (row.kind === "group") {
      parent = row.group.id;
      break;
    }
    // A standalone habit above the drop means the nearest group already ended.
    if (row.habit.parent_id === null) break;
  }

  // Rank between the moved row's new *siblings*: the rows on either side that share its container.
  // A group header counts as the boundary, never as a neighbour.
  let before: number | null = null;
  for (let i = to - 1; i >= 0; i--) {
    const row = next[i]!;
    if (row.kind === "group") break;
    if (containerOf(row) === parent) {
      before = row.habit.sort_order;
      break;
    }
  }
  let after: number | null = null;
  for (let i = to + 1; i < next.length; i++) {
    const row = next[i]!;
    if (row.kind === "group") {
      // A group header is a sibling at the top level, so it bounds the rank there.
      if (parent === null) after = row.group.sort_order;
      break;
    }
    if (containerOf(row) === parent) {
      after = row.habit.sort_order;
      break;
    }
  }

  return { id: moving.habit.id, parent_id: parent, sort_order: rankBetween(before, after) };
}
