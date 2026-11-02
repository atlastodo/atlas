import type { LocalStore, MemberRole } from "@atlastodo/client-core";
import {
  compareActivityNewestFirst,
  decodeLabels,
  decodePlace,
  encodeLabels,
  encodePlace,
  writeActivity,
  writeProjectActivity,
  type Activity,
  type ActivityKind,
} from "./activity";
import type { Comment } from "./comments";
import { toTask } from "./taskMapper";
import { restoreEntity } from "./trash";
import { moveTaskToProject, restoreTask, softDeleteTask, toggleTask, updateTask } from "./taskOps";

/**
 * The activity feed of a view: activity entries and comments, scoped, filtered and paged; and undo
 * of an entry from it. An entry is undoable while it is the latest change to its field and the
 * field still holds the value it wrote, by an owner or editor (project events: the owner). The
 * undo goes through the task rules and records its own entry naming the one it reverts.
 */

export type ActivityGroup =
  | "status"
  | "dates"
  | "assignee"
  | "edits"
  | "move"
  | "lifecycle"
  | "projects"
  | "members"
  | "comments";

export const ACTIVITY_GROUPS: readonly ActivityGroup[] = [
  "status",
  "dates",
  "assignee",
  "edits",
  "move",
  "lifecycle",
  "projects",
  "members",
  "comments",
];

export function activityGroup(kind: ActivityKind): ActivityGroup {
  switch (kind) {
    case "status":
      return "status";
    case "due":
    case "start":
      return "dates";
    case "assignee":
      return "assignee";
    case "priority":
    case "labels":
    case "title":
    case "description":
      return "edits";
    case "move":
      return "move";
    case "created":
    case "deleted":
    case "restored":
      return "lifecycle";
    case "member_invited":
    case "member_joined":
    case "member_removed":
      return "members";
    default:
      return "projects";
  }
}

export type FeedItem =
  | { type: "activity"; id: string; at: number; actorId: string; activity: Activity }
  | { type: "comment"; id: string; at: number; actorId: string; comment: Comment };

/** Which entries a view shows; `undefined` is the global feed. */
export interface FeedScope {
  /** Task entries and comments on these tasks. */
  taskIds: ReadonlySet<string>;
  /** Project, section and member entries of these projects. */
  projectIds: ReadonlySet<string>;
}

export interface FeedQuery {
  activities: readonly Activity[];
  comments?: readonly Comment[];
  scope?: FeedScope;
  /** Only these actors (comment authors). */
  people?: ReadonlySet<string>;
  /** Only these groups; `comments` keeps comments. */
  groups?: ReadonlySet<ActivityGroup>;
  /** Paging: items strictly older than this. */
  before?: number;
  limit?: number;
}

/** A title or description entry whose edits came back to where they started records nothing. */
function isNoOp(a: Activity): boolean {
  return (a.kind === "title" || a.kind === "description") && a.from === a.to;
}

function inScope(a: Activity, scope: FeedScope | undefined): boolean {
  if (!scope) return true;
  if (a.task_id) return scope.taskIds.has(a.task_id);
  return a.project_id !== null && scope.projectIds.has(a.project_id);
}

/** Newest first. `hasMore` says a further page exists (page with the last item's `at`). */
export function buildActivityFeed(q: FeedQuery): { items: FeedItem[]; hasMore: boolean } {
  const items: FeedItem[] = [];
  const keep = (at: number, actorId: string) =>
    (q.before === undefined || at < q.before) && (!q.people || q.people.has(actorId));
  for (const a of q.activities) {
    if (isNoOp(a) || !inScope(a, q.scope) || !keep(a.created_at, a.actor_id)) continue;
    if (q.groups && !q.groups.has(activityGroup(a.kind))) continue;
    items.push({ type: "activity", id: a.id, at: a.created_at, actorId: a.actor_id, activity: a });
  }
  if (!q.groups || q.groups.has("comments")) {
    for (const c of q.comments ?? []) {
      if (q.scope && !q.scope.taskIds.has(c.task_id)) continue;
      if (!keep(c.created_at, c.author_id)) continue;
      items.push({ type: "comment", id: c.id, at: c.created_at, actorId: c.author_id, comment: c });
    }
  }
  items.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const limit = q.limit ?? Infinity;
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

/** The field an entry changed, per target: entries sharing it supersede each other. */
export function activityFieldKey(a: Activity): string | null {
  switch (a.kind) {
    case "created":
    case "deleted":
    case "restored":
      return `task:${a.task_id}:trash`;
    case "project_renamed":
      return `project:${a.project_id}:name`;
    case "project_archived":
    case "project_unarchived":
      return `project:${a.project_id}:archive`;
    case "project_deleted":
    case "project_restored":
      return `project:${a.project_id}:trash`;
    case "section_renamed":
      return `section:${a.section_id}:name`;
    case "section_archived":
    case "section_unarchived":
      return `section:${a.section_id}:archive`;
    case "section_deleted":
    case "section_restored":
      return `section:${a.section_id}:trash`;
    case "member_invited":
    case "member_joined":
    case "member_removed":
      return null;
    default:
      return a.task_id ? `task:${a.task_id}:${a.kind}` : null;
  }
}

/** Whether no later entry changed the same field. `all` is every entry the store holds. */
export function isLatestForField(a: Activity, all: readonly Activity[]): boolean {
  const key = activityFieldKey(a);
  if (!key) return false;
  return !all.some(
    (b) => b.id !== a.id && compareActivityNewestFirst(b, a) < 0 && activityFieldKey(b) === key,
  );
}

const numString = (v: unknown): string | null => (typeof v === "number" ? String(v) : null);

function exists(fields: Record<string, unknown> | null | undefined): boolean {
  return fields != null && typeof fields.deleted_at !== "number";
}

/** Whether `place` can be moved back to: its project and section still exist and belong together. */
function placeIsLive(
  store: LocalStore,
  place: { project_id: string | null; section_id: string | null },
) {
  if (place.project_id && !exists(store.get("project", place.project_id))) return false;
  if (place.section_id) {
    const section = store.get("section", place.section_id);
    if (!exists(section) || section!.project_id !== place.project_id) return false;
  }
  return true;
}

/** Whether the field still holds what the entry wrote, so undoing it overwrites nothing newer. */
function stillCurrent(store: LocalStore, a: Activity): boolean {
  if (a.task_id) {
    const fields = store.get("task", a.task_id);
    if (!fields) return false;
    const task = toTask(a.task_id, fields);
    if (task.locked) return false;
    const deleted = task.deleted_at != null;
    switch (a.kind) {
      case "created":
      case "restored":
        return !deleted;
      case "deleted":
        return deleted;
    }
    if (deleted) return false;
    switch (a.kind) {
      case "status":
        // Completing a recurring task spawned its next occurrence; that is the toast's to undo.
        return task.recurrence == null && task.is_completed === (a.to === "completed");
      case "due":
        return numString(task.due_at) === a.to;
      case "start":
        return numString(task.start_at) === a.to;
      case "priority":
        return numString(task.priority) === a.to;
      case "assignee":
        return task.assignee_id === a.to;
      case "labels":
        return encodeLabels(task.label_ids) === encodeLabels(decodeLabels(a.to));
      case "title":
        return task.title === (a.to ?? "");
      case "description":
        return task.notes === (a.to ?? "");
      case "move": {
        const from = decodePlace(a.from);
        const to = decodePlace(a.to);
        if (!from || !to) return false;
        return encodePlace(task) === encodePlace(to) && placeIsLive(store, from);
      }
      default:
        return false;
    }
  }
  const isSection = a.kind.startsWith("section_");
  const id = isSection ? a.section_id : a.project_id;
  if (!id) return false;
  const fields = store.get(isSection ? "section" : "project", id);
  if (!fields) return false;
  const deleted = typeof fields.deleted_at === "number";
  const archived = typeof fields.archived_at === "number";
  switch (a.kind) {
    case "project_renamed":
    case "section_renamed":
      return !deleted && fields.name === a.to;
    case "project_archived":
    case "section_archived":
      return !deleted && archived;
    case "project_unarchived":
    case "section_unarchived":
      return !deleted && !archived;
    case "project_deleted":
    case "section_deleted":
      return deleted;
    case "project_restored":
    case "section_restored":
      return !deleted;
    default:
      return false;
  }
}

/** Project events are owner-only (the server's rule for project writes); the rest need an editor. */
function mayUndo(a: Activity, role: MemberRole): boolean {
  if (a.kind.startsWith("project_")) return role === "owner";
  return role === "owner" || role === "editor";
}

/**
 * Whether `a` can be undone by someone with `role` in its project (`owner` for a personal or
 * unshared one). `all` is every entry the store holds ({@link listActivities}).
 */
export function canUndoActivity(
  store: LocalStore,
  a: Activity,
  all: readonly Activity[],
  role: MemberRole,
): boolean {
  return mayUndo(a, role) && isLatestForField(a, all) && stillCurrent(store, a);
}

/**
 * Undo `a` as `actorId`: put back the value it replaced through the task rules (or the project or
 * section fields), recording an entry that names `a` in `reverts`. Checks only that it still
 * applies ({@link canUndoActivity} is for the UI, with the role). Returns whether it undid.
 */
export function undoActivity(
  store: LocalStore,
  actorId: string,
  a: Activity,
  all: readonly Activity[],
  now: number = Date.now(),
  timeZone?: string,
): boolean {
  if (!isLatestForField(a, all) || !stillCurrent(store, a)) return false;
  const before = new Set(store.list("activity").map((e) => e.id));
  const applied = applyUndo(store, actorId, a, now, timeZone);
  if (!applied) return false;
  for (const e of store.list("activity")) {
    if (!before.has(e.id) && e.fields.actor_id === actorId) {
      store.set("activity", e.id, "reverts", a.id);
    }
  }
  return true;
}

function applyUndo(
  store: LocalStore,
  actorId: string,
  a: Activity,
  now: number,
  timeZone?: string,
): boolean {
  if (a.task_id) {
    const task = toTask(a.task_id, store.get("task", a.task_id)!);
    const num = (v: string | null) => (v === null ? null : Number(v));
    switch (a.kind) {
      case "status":
        // A recurring task never gets here (stillCurrent), so nothing spawns.
        toggleTask(store, task, actorId, now, timeZone);
        return true;
      case "due":
        return updateTask(store, task, { due_at: num(a.from) }, actorId, now, timeZone);
      case "start":
        return updateTask(store, task, { start_at: num(a.from) }, actorId, now, timeZone);
      case "priority": {
        const p = Number(a.from);
        if (p !== 1 && p !== 2 && p !== 3 && p !== 4) return false;
        return updateTask(store, task, { priority: p }, actorId, now, timeZone);
      }
      case "assignee":
        return updateTask(store, task, { assignee_id: a.from }, actorId, now, timeZone);
      case "labels":
        return updateTask(store, task, { label_ids: decodeLabels(a.from) }, actorId, now, timeZone);
      case "title":
      case "description": {
        // Written directly: through updateTask the entry would merge into the one being undone.
        const field = a.kind === "title" ? "title" : "notes";
        const value = a.from ?? "";
        store.set("task", task.id, field, value);
        store.set("task", task.id, "updated_at", now);
        writeActivity(store, actorId, task.id, a.kind, a.to, value, now, { merge: false });
        return true;
      }
      case "move": {
        const from = decodePlace(a.from)!;
        return moveTaskToProject(store, task.id, from, now, actorId);
      }
      case "created":
      case "restored":
        return softDeleteTask(store, task, now, actorId);
      case "deleted":
        return restoreTask(store, task, actorId, now);
      default:
        return false;
    }
  }
  const projectId = a.project_id!;
  const sectionId = a.section_id;
  const target = { projectId, sectionId };
  switch (a.kind) {
    case "project_renamed":
      store.set("project", projectId, "name", a.from ?? "");
      writeProjectActivity(store, actorId, target, a.kind, a.to, a.from, now);
      return true;
    case "section_renamed":
      store.set("section", sectionId!, "name", a.from ?? "");
      writeProjectActivity(store, actorId, target, a.kind, a.to, a.from, now);
      return true;
    case "project_archived":
    case "project_unarchived": {
      const archive = a.kind === "project_unarchived";
      store.set("project", projectId, "archived_at", archive ? now : null);
      const kind = archive ? "project_archived" : "project_unarchived";
      writeProjectActivity(store, actorId, target, kind, null, a.to, now);
      return true;
    }
    case "section_archived":
    case "section_unarchived": {
      const archive = a.kind === "section_unarchived";
      store.set("section", sectionId!, "archived_at", archive ? now : null);
      const kind = archive ? "section_archived" : "section_unarchived";
      writeProjectActivity(store, actorId, target, kind, null, a.to, now);
      return true;
    }
    case "project_deleted":
      restoreEntity(store, "project", projectId);
      writeProjectActivity(store, actorId, target, "project_restored", null, a.to, now);
      return true;
    case "project_restored":
      store.set("project", projectId, "deleted_at", now);
      writeProjectActivity(store, actorId, target, "project_deleted", null, a.to, now);
      return true;
    case "section_deleted":
      restoreEntity(store, "section", sectionId!);
      writeProjectActivity(store, actorId, target, "section_restored", null, a.to, now);
      return true;
    case "section_restored":
      store.set("section", sectionId!, "deleted_at", now);
      writeProjectActivity(store, actorId, target, "section_deleted", null, a.to, now);
      return true;
    default:
      return false;
  }
}
