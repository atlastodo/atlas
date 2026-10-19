import type { Task } from "@atlastodo/client-core";
import {
  groupTasks,
  taskComparator,
  type GroupBy,
  type GroupContext,
  type TaskGroup,
} from "./grouping";
import { flattenTree, type FlatTaskRow } from "./taskTree";

/**
 * A task list's rendered shape: where {@link ./grouping} and {@link ./taskTree} are composed.
 *
 * Views filter tasks individually, so a matching task's parent or open subtasks are often outside
 * the set. A group is widened before nesting with the open subtasks below its matched tasks and
 * the parents needed to reach them; a pulled-in parent is context (`matched: false`).
 *
 * Grouping runs on the matched set alone, so no bucket vanishes and no matched task changes
 * bucket. Both walks stop at a matched task, so a parent and child in different buckets cannot
 * nest; the child renders at depth 0. Order is injected because `buildTaskTree` re-orders every
 * level: roots take the group's order, siblings take `sortBy`.
 */

export interface ListTaskRow extends FlatTaskRow {
  // `false` for a context parent: excluded from "select all" and the header count.
  matched: boolean;
}

export interface TaskListSection {
  key: string;
  kind: GroupBy;
  accent?: "danger";
  // Excludes context parents; used for the header count and bulk actions.
  matched: Task[];
  tasks: Task[];
  rows: ListTaskRow[];
}

export interface TaskListTreeOptions extends GroupContext {
  groupBy: GroupBy;
  // The full set `matched` was filtered from. Supplying it turns on context widening and whole-set
  // progress counts; omitted, orphans render at depth 0 (the Completed view relies on this).
  allTasks?: Task[];
  collapsedTasks?: ReadonlySet<string>;
}

// The upward walk also stops at a completed or missing parent (it sits in Done). A `seen` guard keeps cyclic data from hanging a render.
export function taskContextClosure(
  sectionTasks: Task[],
  allTasks: Task[],
  matchedIds: ReadonlySet<string>,
): Task[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const childrenOf = new Map<string, Task[]>();
  for (const t of allTasks) {
    if (t.parent_id === null) continue;
    const list = childrenOf.get(t.parent_id);
    if (list) list.push(t);
    else childrenOf.set(t.parent_id, [t]);
  }

  const kept = new Map<string, Task>();
  for (const t of sectionTasks) kept.set(t.id, t);

  // Down: the open subtree below each matched task. A matched descendant belongs to its own group
  // and takes its children with it.
  const descend = (task: Task, seen: Set<string>): void => {
    for (const child of childrenOf.get(task.id) ?? []) {
      if (child.is_completed || matchedIds.has(child.id) || seen.has(child.id)) continue;
      seen.add(child.id);
      kept.set(child.id, child);
      descend(child, seen);
    }
  };
  // Up: the parents this group's tasks hang from, as context rows.
  const ascend = (task: Task): void => {
    const seen = new Set<string>([task.id]);
    let cursor = task;
    for (;;) {
      const parentId = cursor.parent_id;
      if (parentId === null || seen.has(parentId)) return;
      const parent = byId.get(parentId);
      if (parent === undefined || parent.is_completed || matchedIds.has(parent.id)) return;
      seen.add(parent.id);
      kept.set(parent.id, parent);
      cursor = parent;
    }
  };

  for (const task of sectionTasks) {
    descend(task, new Set([task.id]));
    ascend(task);
  }
  return [...kept.values()];
}

export function taskListSections(matched: Task[], options: TaskListTreeOptions): TaskListSection[] {
  const { groupBy, allTasks, collapsedTasks, ...ctx } = options;
  const groups = groupTasks(matched, groupBy, ctx);
  const compareSiblings = taskComparator(ctx.sortBy);

  // Progress counts use the full set, so "n/m" counts completed children kept off screen.
  const directChildren = new Map<string, Task[]>();
  if (allTasks) {
    for (const t of allTasks) {
      if (t.parent_id === null) continue;
      const list = directChildren.get(t.parent_id);
      if (list) list.push(t);
      else directChildren.set(t.parent_id, [t]);
    }
  }

  const matchedIds = new Set(matched.map((t) => t.id));

  return groups.map((group: TaskGroup): TaskListSection => {
    const groupIds = new Set(group.tasks.map((t) => t.id));
    const tasks = allTasks ? taskContextClosure(group.tasks, allTasks, matchedIds) : group.tasks;

    // A context parent takes the position of its earliest matched descendant.
    const groupRank = new Map<string, number>();
    group.tasks.forEach((t, i) => groupRank.set(t.id, i));
    // Memoised: `compareRoots` runs O(n log n) times and each miss walks a subtree.
    const rootRankCache = new Map<string, number>();
    const rootRank = (task: Task): number => {
      const cached = rootRankCache.get(task.id);
      if (cached !== undefined) return cached;
      let best = groupRank.get(task.id) ?? Number.POSITIVE_INFINITY;
      const seen = new Set<string>([task.id]);
      const walk = (parentId: string): void => {
        for (const child of directChildren.get(parentId) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          const rank = groupRank.get(child.id);
          if (rank !== undefined && rank < best) best = rank;
          walk(child.id);
        }
      };
      if (best === Number.POSITIVE_INFINITY) walk(task.id);
      rootRankCache.set(task.id, best);
      return best;
    };

    const rows = flattenTree(tasks, collapsedTasks, {
      compareSiblings,
      compareRoots: (a, b) => rootRank(a) - rootRank(b) || compareSiblings(a, b),
    }).map((row): ListTaskRow => {
      const kids = allTasks ? directChildren.get(row.task.id) : undefined;
      return {
        ...row,
        ...(kids
          ? {
              childCount: kids.filter((c) => !c.is_completed).length,
              completedChildCount: kids.filter((c) => c.is_completed).length,
            }
          : {}),
        matched: groupIds.has(row.task.id),
      };
    });

    return {
      key: group.key,
      kind: group.kind,
      ...(group.accent ? { accent: group.accent } : {}),
      matched: group.tasks,
      tasks,
      rows,
    };
  });
}
