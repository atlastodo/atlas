import type { LocalStore } from "@atlastodo/client-core";

/**
 * Activity-feed entries: an `activity` entity recording one change with its actor and time, written
 * by {@link writeActivity} (task changes) and {@link writeProjectActivity} (project, section and
 * member events). An entry targets a task (`task_id`) or, without one, a project (`project_id`,
 * plus `section_id` for a section event); it fans out like a comment on shared projects, through
 * its task's project or its own `project_id`.
 *
 * `from`/`to` are strings: dates and priorities as `String(n)`, labels as a JSON array of sorted
 * ids, a move as JSON `{"project_id","section_id"}`, titles and descriptions as the full text.
 * An entry written by an undo names the entry it reverts in `reverts`.
 */
export const TASK_ACTIVITY_KINDS = [
  "status",
  "due",
  "start",
  "assignee",
  "priority",
  "labels",
  "title",
  "description",
  "move",
  "created",
  "deleted",
  "restored",
] as const;

export const PROJECT_ACTIVITY_KINDS = [
  "project_renamed",
  "project_archived",
  "project_unarchived",
  "project_deleted",
  "project_restored",
  "section_renamed",
  "section_archived",
  "section_unarchived",
  "section_deleted",
  "section_restored",
  "member_invited",
  "member_joined",
  "member_removed",
] as const;

export type TaskActivityKind = (typeof TASK_ACTIVITY_KINDS)[number];
export type ProjectActivityKind = (typeof PROJECT_ACTIVITY_KINDS)[number];
export type ActivityKind = TaskActivityKind | ProjectActivityKind;

const KINDS: ReadonlySet<string> = new Set<string>([
  ...TASK_ACTIVITY_KINDS,
  ...PROJECT_ACTIVITY_KINDS,
]);

export function isActivityKind(v: unknown): v is ActivityKind {
  return typeof v === "string" && KINDS.has(v);
}

export interface Activity {
  id: string;
  /** Empty for a project, section or member event. */
  task_id: string;
  /** The target project of a project, section or member event; `null` on a task entry. */
  project_id: string | null;
  section_id: string | null;
  actor_id: string;
  kind: ActivityKind;
  from: string | null;
  to: string | null;
  created_at: number;
  /** The entry this one undid. */
  reverts: string | null;
}

/** `null` for a kind this version does not know (written by a newer app): it is left out. */
export function toActivity(id: string, fields: Record<string, unknown>): Activity | null {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const strOrNull = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  if (!isActivityKind(fields.kind)) return null;
  return {
    id,
    task_id: str(fields.task_id),
    project_id: strOrNull(fields.project_id),
    section_id: strOrNull(fields.section_id),
    actor_id: str(fields.actor_id),
    kind: fields.kind,
    from: typeof fields.from === "string" ? fields.from : null,
    to: typeof fields.to === "string" ? fields.to : null,
    created_at: typeof fields.created_at === "number" ? fields.created_at : 0,
    reverts: strOrNull(fields.reverts),
  };
}

/** Newest first; ties by id, so the order is stable. */
export function compareActivityNewestFirst(a: Activity, b: Activity): number {
  return b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Every entry the store holds that this version understands, newest first. */
export function listActivities(store: Pick<LocalStore, "list">): Activity[] {
  const out: Activity[] = [];
  for (const e of store.list("activity")) {
    const a = toActivity(e.id, e.fields);
    if (a) out.push(a);
  }
  return out.sort(compareActivityNewestFirst);
}

/** Title and description edits within this long of the actor's previous one extend that entry. */
export const ACTIVITY_MERGE_MS = 5 * 60 * 1000;

const MERGED_KINDS: ReadonlySet<string> = new Set(["title", "description"]);

/**
 * The entry a title or description edit extends: the latest entry of that kind on the task, when
 * it is the actor's, at most {@link ACTIVITY_MERGE_MS} old and no undo.
 */
function mergeTarget(
  store: LocalStore,
  actorId: string,
  taskId: string,
  kind: string,
  now: number,
): string | null {
  let latest: { id: string; fields: Record<string, unknown> } | null = null;
  let latestAt = -Infinity;
  for (const e of store.list("activity")) {
    if (e.fields.task_id !== taskId || e.fields.kind !== kind) continue;
    const at = typeof e.fields.created_at === "number" ? e.fields.created_at : 0;
    if (at > latestAt || (at === latestAt && latest !== null && e.id > latest.id)) {
      latest = e;
      latestAt = at;
    }
  }
  if (!latest || latest.fields.actor_id !== actorId) return null;
  if (typeof latest.fields.reverts === "string" && latest.fields.reverts !== "") return null;
  if (now < latestAt || now - latestAt > ACTIVITY_MERGE_MS) return null;
  return latest.id;
}

/**
 * Append a task activity entry. No-op when `actorId` is unknown (background contexts), so only
 * user-driven edits are recorded. A title or description edit extends the actor's entry of the
 * last {@link ACTIVITY_MERGE_MS} (its `to` and time move; its `from` stays), so typing is one
 * entry. The id comes from `store.newEntityId()`: Hermes has no global `crypto`, and a non-UUID id
 * would 422 the sync batch. `merge: false` always appends (an undo). Returns the entry's id.
 */
export function writeActivity(
  store: LocalStore,
  actorId: string | undefined,
  taskId: string,
  kind: TaskActivityKind,
  from: string | null,
  to: string | null,
  now: number = Date.now(),
  options: { merge?: boolean } = {},
): string | null {
  if (!actorId) return null;
  if (options.merge !== false && MERGED_KINDS.has(kind)) {
    const merged = mergeTarget(store, actorId, taskId, kind, now);
    if (merged) {
      store.set("activity", merged, "to", to);
      store.set("activity", merged, "created_at", now);
      return merged;
    }
  }
  const id = store.newEntityId();
  store.set("activity", id, "task_id", taskId);
  store.set("activity", id, "actor_id", actorId);
  store.set("activity", id, "kind", kind);
  if (from !== null) store.set("activity", id, "from", from);
  if (to !== null) store.set("activity", id, "to", to);
  store.set("activity", id, "created_at", now);
  return id;
}

/**
 * Append a project, section or member entry (no task). `sectionId` names the section of a section
 * event; the entry scopes through `projectId`. No-op without an actor.
 */
export function writeProjectActivity(
  store: LocalStore,
  actorId: string | undefined,
  target: { projectId: string; sectionId?: string | null },
  kind: ProjectActivityKind,
  from: string | null,
  to: string | null,
  now: number = Date.now(),
): string | null {
  if (!actorId) return null;
  const id = store.newEntityId();
  store.set("activity", id, "project_id", target.projectId);
  if (target.sectionId) store.set("activity", id, "section_id", target.sectionId);
  store.set("activity", id, "actor_id", actorId);
  store.set("activity", id, "kind", kind);
  if (from !== null) store.set("activity", id, "from", from);
  if (to !== null) store.set("activity", id, "to", to);
  store.set("activity", id, "created_at", now);
  return id;
}

/** `labels` entry values: the label ids, sorted, as a JSON array. */
export function encodeLabels(ids: readonly string[]): string {
  return JSON.stringify([...ids].sort());
}

export function decodeLabels(v: string | null): string[] {
  if (!v) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export interface ActivityPlace {
  project_id: string | null;
  section_id: string | null;
}

/** `move` entry values: where the task was or went, as JSON. */
export function encodePlace(place: ActivityPlace): string {
  return JSON.stringify({ project_id: place.project_id, section_id: place.section_id });
}

export function decodePlace(v: string | null): ActivityPlace | null {
  if (!v) return null;
  try {
    const p = JSON.parse(v) as Record<string, unknown>;
    const s = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
    return { project_id: s(p.project_id), section_id: s(p.section_id) };
  } catch {
    return null;
  }
}

/**
 * Delete the actor's own entries older than `olderThanMs` (the "delete my activity after" setting).
 * Only the actor may re-write an entry, so others' entries are theirs to prune. Returns how many.
 */
export function pruneOwnActivity(
  store: LocalStore,
  actorId: string,
  olderThanMs: number,
  now: number = Date.now(),
): number {
  const cutoff = now - olderThanMs;
  let removed = 0;
  for (const e of store.list("activity")) {
    if (e.fields.actor_id !== actorId) continue;
    const at = typeof e.fields.created_at === "number" ? e.fields.created_at : 0;
    if (at >= cutoff) continue;
    store.remove("activity", e.id);
    removed++;
  }
  return removed;
}
