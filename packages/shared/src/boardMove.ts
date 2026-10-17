import type { Task } from "@atlastodo/client-core";
import { rankMoveWrites } from "./reorder";

// A subtask carried with its parent keeps its own rank, so it has no `sort_order`.
export interface BoardMoveWrite {
  id: string;
  section_id: string | null;
  sort_order?: number;
}

export function columnCards(tasks: Task[], sectionId: string | null, excludeId?: string): Task[] {
  return tasks
    .filter((t) => !t.is_completed && t.section_id === sectionId && t.id !== excludeId)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
}

// A subtask whose parent is elsewhere or completed is a card of its own.
export function columnRoots(tasks: Task[], sectionId: string | null, excludeId?: string): Task[] {
  const cards = columnCards(tasks, sectionId);
  const inColumn = new Set(cards.map((t) => t.id));
  return cards.filter(
    (t) => t.id !== excludeId && (t.parent_id === null || !inColumn.has(t.parent_id)),
  );
}

// Via {@link rankMoveWrites}. A card changing column takes its whole subtree, keeping the subtasks' sibling ranks.
export function columnMoveWrites(
  tasks: Task[],
  activeId: string,
  toSection: string | null,
  toIndex: number,
): BoardMoveWrite[] {
  const cards = columnRoots(tasks, toSection, activeId);
  // Every card in the column already has `section_id === toSection`.
  const writes: BoardMoveWrite[] = rankMoveWrites(cards, activeId, toIndex).map((w) => ({
    ...w,
    section_id: toSection,
  }));
  const active = tasks.find((t) => t.id === activeId);
  if (active && active.section_id !== toSection) {
    for (const d of descendants(tasks, activeId)) {
      if (d.section_id !== toSection) writes.push({ id: d.id, section_id: toSection });
    }
  }
  return writes;
}

function descendants(tasks: Task[], id: string): Task[] {
  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parent_id === null) continue;
    const list = childrenOf.get(t.parent_id);
    if (list) list.push(t);
    else childrenOf.set(t.parent_id, [t]);
  }
  const out: Task[] = [];
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop()!) ?? []) {
      // Guard against a cycle in synced data, like `wouldCycle`.
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      stack.push(child.id);
    }
  }
  return out;
}

/**
 * Move several cards to the end of one column, in the given order: {@link columnMoveWrites} per
 * card against a running copy, so each lands after the previous one. The last write per task wins.
 */
export function columnMoveManyWrites(
  tasks: Task[],
  ids: string[],
  toSection: string | null,
): BoardMoveWrite[] {
  let current = tasks;
  const byId = new Map<string, BoardMoveWrite>();
  for (const id of ids) {
    const writes = columnMoveWrites(current, id, toSection, Number.MAX_SAFE_INTEGER);
    const patch = new Map(writes.map((w) => [w.id, w]));
    current = current.map((t) => {
      const w = patch.get(t.id);
      return w ? { ...t, section_id: w.section_id, sort_order: w.sort_order ?? t.sort_order } : t;
    });
    for (const w of writes) byId.set(w.id, { ...byId.get(w.id), ...w });
  }
  return [...byId.values()];
}
