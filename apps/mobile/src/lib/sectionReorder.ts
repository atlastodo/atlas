import { rankMoveWrites, type RankWrite } from "@atlastodo/shared";

/**
 * Cross-section drag maths for the project list view.
 *
 * `react-native-reorderable-list` cannot drag between lists, so the sectioned project list is one
 * flat list of section headers, (nested) tasks and per-section add-task rows. Dragging a task past
 * a header changes its section, among another task's children makes it a subtask, and out to a
 * section's top level clears its parent. This pure function turns the `{from, to}` index move into
 * the task's new `section_id`, `parent_id` and `sort_order`.
 *
 * Parent by position (as the smart lists' `resolveIndentTarget`): the moved task's depth is the
 * deeper of the task rows directly above and below the drop, clamped to one level past the row
 * above. The rank comes from `rankMoveWrites` over its new siblings: one fractional write between
 * the neighbours, or a renumber when they are tied (tasks created without a rank all sit at 0, and
 * a rank "between" two equal ranks would snap back).
 */

export type SectionRow =
  | { kind: "header"; sectionId: string | null }
  | {
      kind: "task";
      sectionId: string | null;
      id: string;
      sortOrder: number;
      depth: number;
      parentId: string | null;
    }
  | { kind: "add"; sectionId: string | null };

export interface SectionDrop {
  id: string;
  section_id: string | null;
  parent_id: string | null;
  sort_order: number;
  /** True when the drop moved the task into a different section (vs a within-section reorder). */
  changedSection: boolean;
  /**
   * Every rank to write, the moved task's (`sort_order` above) included: more than one when tied
   * siblings had to be renumbered. The caller applies the others as plain reorders.
   */
  writes: RankWrite[];
}

export function resolveSectionReorder(
  rows: SectionRow[],
  from: number,
  to: number,
): SectionDrop | null {
  if (from === to) return null;
  const moving = rows[from];
  if (!moving || moving.kind !== "task") return null;

  const next = rows.slice();
  next.splice(from, 1);
  next.splice(to, 0, moving);

  // The section is the nearest header at or before the landing index. Dropped above every header
  // (the "No section" group renders last), it lands at the top of the first section.
  let section: string | null = null;
  let headerBefore = -1;
  for (let i = to - 1; i >= 0; i--) {
    if (next[i]!.kind === "header") {
      headerBefore = i;
      section = next[i]!.sectionId;
      break;
    }
  }
  let droppedAboveAll = false;
  if (headerBefore === -1) {
    for (let i = to + 1; i < next.length; i++) {
      if (next[i]!.kind === "header") {
        section = next[i]!.sectionId;
        droppedAboveAll = true;
        break;
      }
    }
  }

  // Where the section's task region begins; dropped above all headers, it starts past the next header.
  let regionStart = to + 1;
  if (droppedAboveAll) {
    while (regionStart < next.length && next[regionStart]!.kind !== "header") regionStart++;
    regionStart++;
  }

  // Parent by position, from the task rows directly above and below the drop (stopping at a
  // header). A drop between a parent and its child joins the child zone. Above all headers there
  // is no task above.
  let above: (SectionRow & { kind: "task" }) | null = null;
  if (!droppedAboveAll) {
    for (let i = to - 1; i >= 0; i--) {
      const r = next[i]!;
      if (r.kind === "header") break;
      if (r.kind === "task") {
        above = r;
        break;
      }
    }
  }
  let below: (SectionRow & { kind: "task" }) | null = null;
  for (let i = droppedAboveAll ? regionStart : to + 1; i < next.length; i++) {
    const r = next[i]!;
    if (r.kind === "header") break;
    if (r.kind === "task") {
      below = r;
      break;
    }
  }
  const aboveDepth = above ? above.depth : -1;
  const belowDepth = below ? below.depth : -1;
  const targetDepth = Math.max(0, Math.min(Math.max(aboveDepth, belowDepth), aboveDepth + 1));
  const parentId =
    targetDepth === 0 || !above ? null : targetDepth === aboveDepth + 1 ? above.id : above.parentId;

  // Rank among the moved row's new siblings (same parentId) in display order. Above every header,
  // the row heads its section.
  const siblings: { id: string; sort_order: number }[] = [];
  let toIndex = 0;
  if (droppedAboveAll) siblings.push({ id: moving.id, sort_order: moving.sortOrder });
  for (let i = droppedAboveAll ? regionStart : headerBefore + 1; i < next.length; i++) {
    const r = next[i]!;
    if (r.kind === "header") break;
    if (r.kind !== "task" || (r !== moving && r.parentId !== parentId)) continue;
    if (r === moving) toIndex = siblings.length;
    siblings.push({ id: r.id, sort_order: r.sortOrder });
  }
  const writes = rankMoveWrites(siblings, moving.id, toIndex);
  const own = writes.find((w) => w.id === moving.id)!;

  return {
    id: moving.id,
    section_id: section,
    parent_id: parentId,
    sort_order: own.sort_order,
    changedSection: (moving.sectionId ?? null) !== section,
    writes,
  };
}
