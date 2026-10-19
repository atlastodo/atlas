import type { Project } from "@atlastodo/client-core";
import { rankBetween } from "./rank";

/**
 * The project forest: a flat `Project[]` as a nested render list. A folder is a project with
 * `kind: "folder"` that holds no tasks and groups others via `parent_id`.
 *
 * Exports are named differently from `taskTree`'s because `index.ts` star-exports both (TS2308).
 *
 * Orphans are roots: a co-member of a shared project can receive a `parent_id` naming a folder
 * never shared with them and would otherwise lose the project.
 *
 * Cycles are guarded here only (the server does not validate parents on the sync path), so
 * {@link wouldCycleProject} is the enforcement and every walk carries a `seen` guard.
 */

export interface ProjectTreeNode {
  project: Project;
  depth: number;
  children: ProjectTreeNode[];
}

export interface FlatProjectRow {
  project: Project;
  depth: number;
  hasChildren: boolean;
  childCount: number;
}

const bySortOrder = (a: Project, b: Project): number =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name);

function effectiveParent(project: Project, present: ReadonlySet<string>): string | null {
  return project.parent_id !== null && present.has(project.parent_id) ? project.parent_id : null;
}

export function buildProjectTree(projects: Project[]): ProjectTreeNode[] {
  const present = new Set(projects.map((p) => p.id));
  const childrenOf = new Map<string, Project[]>();
  const roots: Project[] = [];
  for (const project of projects) {
    const parent = effectiveParent(project, present);
    if (parent === null) {
      roots.push(project);
      continue;
    }
    const list = childrenOf.get(parent);
    if (list) list.push(project);
    else childrenOf.set(parent, [project]);
  }

  // Each id is consumed once; a cycle has no root and is never visited.
  const toNode = (project: Project, depth: number): ProjectTreeNode => {
    const kids = childrenOf.get(project.id);
    return {
      project,
      depth,
      children: kids ? kids.sort(bySortOrder).map((c) => toNode(c, depth + 1)) : [],
    };
  };
  return roots.sort(bySortOrder).map((r) => toNode(r, 0));
}

// Pre-order; a `collapsed` folder emits its own row but none of its descendants.
export function flattenProjectTree(
  projects: Project[],
  collapsed?: ReadonlySet<string>,
): FlatProjectRow[] {
  const rows: FlatProjectRow[] = [];
  const walk = (nodes: ProjectTreeNode[]): void => {
    for (const node of nodes) {
      rows.push({
        project: node.project,
        depth: node.depth,
        hasChildren: node.children.length > 0,
        childCount: node.children.length,
      });
      if (node.children.length > 0 && !collapsed?.has(node.project.id)) walk(node.children);
    }
  };
  walk(buildProjectTree(projects));
  return rows;
}

export function projectAncestors(projects: Project[], id: string): Project[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const out: Project[] = [];
  const seen = new Set<string>([id]);
  let cursor = byId.get(id)?.parent_id ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    const parent = byId.get(cursor);
    if (!parent) break;
    out.push(parent);
    seen.add(cursor);
    cursor = parent.parent_id;
  }
  return out;
}

export function projectDescendantIds(projects: Project[], id: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const p of projects) {
    if (p.parent_id === null) continue;
    const list = childrenOf.get(p.parent_id);
    if (list) list.push(p.id);
    else childrenOf.set(p.parent_id, [p.id]);
  }
  const out = new Set<string>();
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (next === id || out.has(next)) continue; // cyclic data: never revisit
    out.add(next);
    queue.push(...(childrenOf.get(next) ?? []));
  }
  return out;
}

export function wouldCycleProject(
  projects: Project[],
  movingId: string,
  candidateParentId: string | null,
): boolean {
  if (candidateParentId === null) return false;
  if (candidateParentId === movingId) return true;
  const byId = new Map(projects.map((p) => [p.id, p]));
  let cursor: string | null = candidateParentId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === movingId) return true;
    if (seen.has(cursor)) break; // pre-existing cycle in the data -- don't loop forever
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

// `null` when the project is unknown or it would cycle.
export function moveProjectTarget(
  projects: Project[],
  id: string,
  newParentId: string | null,
): { parent_id: string | null; sort_order: number } | null {
  if (!projects.some((p) => p.id === id)) return null;
  if (wouldCycleProject(projects, id, newParentId)) return null;
  const siblings = projects.filter((p) => p.id !== id && p.parent_id === newParentId);
  const last = siblings.length > 0 ? Math.max(...siblings.map((s) => s.sort_order)) : null;
  return { parent_id: newParentId, sort_order: rankBetween(last, null) };
}

// Resolved at read time so restoring a folder brings its subtree back. One memoised pass: call it
// once per read, since it feeds `visibleTasks`. Takes the structural minimum so raw store rows work.
export function hiddenProjectIds(
  items: ReadonlyArray<{
    id: string;
    parent_id: string | null;
    archived_at: number | null;
    deleted_at: number | null;
  }>,
): Set<string> {
  const byId = new Map(items.map((p) => [p.id, p]));
  const verdict = new Map<string, boolean>();

  const resolve = (id: string): boolean => {
    const known = verdict.get(id);
    if (known !== undefined) return known;
    // Walk up to a known verdict, root, orphan or repeat (cyclic data), then write the answer back down.
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | null = id;
    let hidden = false;
    while (cursor !== null) {
      const cached = verdict.get(cursor);
      if (cached !== undefined) {
        hidden = cached;
        break;
      }
      if (onPath.has(cursor)) break; // pre-existing cycle: nothing above it decides
      const node = byId.get(cursor);
      if (!node) break; // orphan: its missing parent cannot hide it
      path.push(cursor);
      onPath.add(cursor);
      if (node.archived_at != null || node.deleted_at != null) {
        hidden = true;
        break;
      }
      cursor = node.parent_id;
    }
    // Everything from the hiding node downwards is hidden; if nothing hid it, none are.
    for (const step of path) verdict.set(step, hidden);
    return hidden;
  };

  const out = new Set<string>();
  for (const item of items) if (resolve(item.id)) out.add(item.id);
  return out;
}

// A folder appears only when a pinned project is below it. `isPinned` is injected because pinning
// is per-user (on the private `preference` entity); on the project it would unpin for every member.
export function pinnedProjectTree(
  projects: Project[],
  isPinned: (projectId: string) => boolean,
  collapsed?: ReadonlySet<string>,
): FlatProjectRow[] {
  const hidden = hiddenProjectIds(projects);
  const visible = projects.filter((p) => !hidden.has(p.id));
  const keep = new Set<string>();
  for (const project of visible) {
    if (project.kind !== "project" || !isPinned(project.id)) continue;
    keep.add(project.id);
    for (const ancestor of projectAncestors(visible, project.id)) keep.add(ancestor.id);
  }
  return flattenProjectTree(
    visible.filter((p) => keep.has(p.id)),
    collapsed,
  );
}
