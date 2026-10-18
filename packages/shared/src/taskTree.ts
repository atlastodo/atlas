import type { Task } from "@atlastodo/client-core";
import { rankMoveWrites, type RankWrite } from "./reorder";

/**
 * The subtask tree: a flat `Task[]` as a nested render list, plus the maths for reparenting by drag.
 *
 * Siblings default to `sort_order` then `created_at`; a custom order must be injected as a
 * {@link TaskTreeOrder}, since the build re-orders every level. Orphans (`parent_id` null or
 * outside the set) render at depth 0 instead of vanishing.
 */

export interface TaskTreeNode {
  task: Task;
  depth: number;
  children: TaskTreeNode[];
}

export interface FlatTaskRow {
  task: Task;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  completedChildCount: number;
}

const bySortOrder = (a: Task, b: Task): number =>
  a.sort_order - b.sort_order || a.created_at - b.created_at;

export interface TaskTreeOrder {
  compareSiblings?: (a: Task, b: Task) => number;
  compareRoots?: (a: Task, b: Task) => number;
}

export function buildTaskTree(tasks: Task[], order?: TaskTreeOrder): TaskTreeNode[] {
  const compareSiblings = order?.compareSiblings ?? bySortOrder;
  const compareRoots = order?.compareRoots ?? compareSiblings;
  const present = new Set(tasks.map((t) => t.id));
  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const task of tasks) {
    const parent = task.parent_id;
    if (parent !== null && present.has(parent)) {
      const list = childrenOf.get(parent);
      if (list) list.push(task);
      else childrenOf.set(parent, [task]);
    } else {
      roots.push(task);
    }
  }

  const toNode = (task: Task, depth: number): TaskTreeNode => {
    const kids = childrenOf.get(task.id);
    return {
      task,
      depth,
      children: kids ? kids.sort(compareSiblings).map((c) => toNode(c, depth + 1)) : [],
    };
  };
  return roots.sort(compareRoots).map((r) => toNode(r, 0));
}

// Pre-order. A `collapsed` task emits its own row but none of its descendants.
export function flattenTree(
  tasks: Task[],
  collapsed?: ReadonlySet<string>,
  order?: TaskTreeOrder,
): FlatTaskRow[] {
  const rows: FlatTaskRow[] = [];
  const walk = (nodes: TaskTreeNode[]): void => {
    for (const node of nodes) {
      const children = node.children.map((c) => c.task);
      rows.push({
        task: node.task,
        depth: node.depth,
        hasChildren: children.length > 0,
        childCount: children.filter((c) => !c.is_completed).length,
        completedChildCount: children.filter((c) => c.is_completed).length,
      });
      if (children.length > 0 && !collapsed?.has(node.task.id)) walk(node.children);
    }
  };
  walk(buildTaskTree(tasks, order));
  return rows;
}

// After the current last child (or `0`), never tying. `movedId` is left out if already a child.
export function rankAfterChildren(tasks: Task[], parentId: string, movedId = ""): number {
  const kids = tasks.filter((t) => t.parent_id === parentId).sort(bySortOrder);
  return rankMoveWrites(kids, movedId, kids.length)[0]!.sort_order;
}

// Indent: under the preceding sibling as its last child; `null` without one.
export function indentTarget(
  tasks: Task[],
  id: string,
  allTasks?: Task[],
): { parent_id: string | null; sort_order: number; writes: RankWrite[] } | null {
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  const parentOf = (t: Task): string | null =>
    t.parent_id !== null && tasks.some((x) => x.id === t.parent_id) ? t.parent_id : null;
  const myParent = parentOf(task);
  const siblings = tasks
    .filter(
      (t) =>
        parentOf(t) === myParent &&
        t.project_id === task.project_id &&
        t.section_id === task.section_id,
    )
    .sort(bySortOrder);
  const idx = siblings.findIndex((s) => s.id === id);
  if (idx <= 0) return null; // first (or missing) -> nothing above to nest under
  const newParent = siblings[idx - 1]!;
  const rankPool = allTasks ?? tasks;
  const sortOrder = rankAfterChildren(rankPool, newParent.id, id);
  return {
    parent_id: newParent.id,
    sort_order: sortOrder,
    writes: [{ id, sort_order: sortOrder }],
  };
}

// Outdent: to the grandparent (or root), right after the former parent. `writes` holds every rank to apply (several when ranks tie).
export function outdentTarget(
  tasks: Task[],
  id: string,
): { parent_id: string | null; sort_order: number; writes: RankWrite[] } | null {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.parent_id === null) return null;
  const parent = tasks.find((t) => t.id === task.parent_id);
  if (!parent) return null; // parent absent -> already renders at root
  const parentOf = (t: Task): string | null =>
    t.parent_id !== null && tasks.some((x) => x.id === t.parent_id) ? t.parent_id : null;
  const grandparent = parentOf(parent);
  const uncles = tasks
    .filter(
      (t) =>
        parentOf(t) === grandparent &&
        t.project_id === parent.project_id &&
        t.section_id === parent.section_id,
    )
    .sort(bySortOrder);
  const pIdx = uncles.findIndex((u) => u.id === parent.id);
  const writes = rankMoveWrites(uncles, id, pIdx + 1);
  const own = writes.find((w) => w.id === id)!;
  return { parent_id: grandparent, sort_order: own.sort_order, writes };
}

export function subtreeProgress(node: TaskTreeNode): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const child of node.children) {
    total += 1;
    if (child.task.is_completed) done += 1;
    const deep = subtreeProgress(child);
    done += deep.done;
    total += deep.total;
  }
  return { done, total };
}

// A cycle: the candidate parent is the task or its descendant.
export function wouldCycle(
  tasks: Task[],
  movingId: string,
  candidateParentId: string | null,
): boolean {
  if (candidateParentId === null) return false;
  if (candidateParentId === movingId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // Walk up from the candidate: reaching the moving task means the candidate is its descendant.
  let cursor: string | null = candidateParentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === movingId) return true;
    if (seen.has(cursor)) break; // defensive: pre-existing cycle in the data, don't loop forever
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

/**
 * Resolve a drag over the flattened list into a reparent target. The moved row's depth is
 * `max(aboveDepth, belowDepth)`, at most one deeper than the row above. `null` for a no-op or a cycle.
 */
export function resolveIndentTarget(
  rows: FlatTaskRow[],
  from: number,
  to: number,
): { id: string; parent_id: string | null; sort_order: number; writes: RankWrite[] } | null {
  if (from < 0 || from >= rows.length || to < 0 || to >= rows.length) return null;
  if (from === to) return null; // dropped where it started -> no-op
  const moved = rows[from]!.task;

  // The order after the move, so "above/below" is whatever ends up around the moved row.
  const reordered = rows.slice();
  const [movedRow] = reordered.splice(from, 1);
  if (!movedRow) return null;
  reordered.splice(to, 0, movedRow);
  const movedAt = to;

  // Depth from the surrounding rows: the deeper of above and below, but never more than one past
  // the row above; no row above allows only 0.
  const above = movedAt > 0 ? reordered[movedAt - 1]! : null;
  const below = movedAt < reordered.length - 1 ? reordered[movedAt + 1]! : null;
  const aboveDepth = above ? above.depth : -1;
  const belowDepth = below ? below.depth : -1;
  const targetDepth = Math.max(0, Math.min(Math.max(aboveDepth, belowDepth), aboveDepth + 1));

  // The new parent is the nearest row above the drop at depth `targetDepth - 1`; depth 0 is root.
  let parentId: string | null = null;
  if (targetDepth > 0) {
    for (let i = movedAt - 1; i >= 0; i--) {
      if (reordered[i]!.depth === targetDepth - 1) {
        parentId = reordered[i]!.task.id;
        break;
      }
    }
    if (parentId === null) return null; // no row at that depth above -> reject
  }

  if (
    wouldCycle(
      rows.map((r) => r.task),
      moved.id,
      parentId,
    )
  )
    return null;

  // Rank among the new siblings (rows whose effective parent is `parentId`, excluding the moved row
  // and its descendants); the moved row goes after those above its drop slot.
  const present = new Set(rows.map((r) => r.task.id));
  const effectiveParent = (t: Task): string | null =>
    t.parent_id !== null && present.has(t.parent_id) ? t.parent_id : null;
  const siblings: Task[] = [];
  let slot = 0;
  for (let i = 0; i < reordered.length; i++) {
    const t = reordered[i]!.task;
    if (t.id === moved.id || effectiveParent(t) !== parentId) continue;
    siblings.push(t);
    if (i < movedAt) slot = siblings.length;
  }
  const writes = rankMoveWrites(siblings, moved.id, slot);
  const own = writes.find((w) => w.id === moved.id)!;

  return { id: moved.id, parent_id: parentId, sort_order: own.sort_order, writes };
}
