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

/**
 * An actor reversing their own latest change to a field within this long (a toast's undo, a
 * mis-click put right) takes that entry back instead of recording the reverse: nothing happened.
 */
export const ACTIVITY_CANCEL_MS = 60 * 1000;

const MERGED_KINDS: ReadonlySet<string> = new Set(["title", "description"]);

/**
 * A short fingerprint of a text: FNV-1a (32-bit) over its code points, as `#` and 8 hex digits.
 * A description entry's `to` holds this rather than the text, so autosaving a long description does
 * not re-send it with every keystroke; the old text (`from`) is what an undo needs.
 */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `#${h.toString(16).padStart(8, "0")}`;
}

/**
 * The field an entry changed, per target: entries sharing a key supersede each other. Member
 * entries have none.
 */
export function activityKeyOf(fields: Record<string, unknown>): string | null {
  const kind = fields.kind;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (kind) {
    case "created":
    case "deleted":
    case "restored":
      return `task:${str(fields.task_id)}:trash`;
    case "project_renamed":
      return `project:${str(fields.project_id)}:name`;
    case "project_archived":
    case "project_unarchived":
      return `project:${str(fields.project_id)}:archive`;
    case "project_deleted":
    case "project_restored":
      return `project:${str(fields.project_id)}:trash`;
    case "section_renamed":
      return `section:${str(fields.section_id)}:name`;
    case "section_archived":
    case "section_unarchived":
      return `section:${str(fields.section_id)}:archive`;
    case "section_deleted":
    case "section_restored":
      return `section:${str(fields.section_id)}:trash`;
    case "member_invited":
    case "member_joined":
    case "member_removed":
      return null;
    default:
      return typeof kind === "string" && str(fields.task_id)
        ? `task:${str(fields.task_id)}:${kind}`
        : null;
  }
}

interface Latest {
  id: string;
  fields: Record<string, unknown>;
  at: number;
}

const createdAt = (f: Record<string, unknown>) =>
  typeof f.created_at === "number" ? f.created_at : 0;

/** Whether `a` sorts after `b` (newest first: later time, then higher id). */
const isNewer = (a: Latest, b: Latest) => a.at > b.at || (a.at === b.at && a.id > b.id);

// The latest entry per field key, per store; rebuilt when someone else touched activity.
const latestCache = new WeakMap<LocalStore, { rev: number; map: Map<string, Latest> }>();

function latestIndex(store: LocalStore): Map<string, Latest> {
  const rev = store.revision("activity");
  const cached = latestCache.get(store);
  if (cached?.rev === rev) return cached.map;
  const map = new Map<string, Latest>();
  for (const e of store.list("activity")) {
    const key = activityKeyOf(e.fields);
    if (!key) continue;
    const entry = { id: e.id, fields: e.fields, at: createdAt(e.fields) };
    const prev = map.get(key);
    if (!prev || isNewer(entry, prev)) map.set(key, entry);
  }
  latestCache.set(store, { rev, map });
  return map;
}

/** After this module's own write: keep the index rather than rebuild it on the next keystroke. */
function noteWrite(store: LocalStore, id: string): void {
  const cached = latestCache.get(store);
  if (!cached) return;
  const fields = store.get("activity", id);
  const key = fields ? activityKeyOf(fields) : null;
  if (fields && key) cached.map.set(key, { id, fields, at: createdAt(fields) });
  cached.rev = store.revision("activity");
}

/** After a cancel: who is latest on that field now is not known without a scan. */
function noteRemove(store: LocalStore): void {
  latestCache.delete(store);
}

/** The latest entry on that field, if the actor wrote it, it undid nothing and it is recent. */
function ownRecent(
  store: LocalStore,
  key: string,
  actorId: string,
  now: number,
  windowMs: number,
): Latest | null {
  const latest = latestIndex(store).get(key);
  if (!latest || latest.fields.actor_id !== actorId) return null;
  const reverts = latest.fields.reverts;
  if (typeof reverts === "string" && reverts !== "") return null;
  if (now < latest.at || now - latest.at > windowMs) return null;
  return latest;
}

const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** Whether writing `kind` with `to` puts back what `prev` changed. */
function reverses(prev: Record<string, unknown>, kind: string, to: string | null): boolean {
  const prevKind = prev.kind;
  switch (kind) {
    case "status":
      return prevKind === "status" && strOrNull(prev.to) !== to;
    case "restored":
      return prevKind === "deleted";
    case "project_restored":
      return prevKind === "project_deleted";
    case "section_restored":
      return prevKind === "section_deleted";
    case "project_archived":
    case "project_unarchived":
    case "section_archived":
    case "section_unarchived":
      return prevKind !== kind;
    case "created":
    case "deleted":
    case "project_deleted":
    case "section_deleted":
      return false;
    case "description":
      return prevKind === kind && to === hashText(strOrNull(prev.from) ?? "");
    default:
      return prevKind === kind && strOrNull(prev.from) === to;
  }
}

// Stores in the middle of an undo from the feed: its entry is the record of the undo, never a cancel.
const recording = new WeakSet<LocalStore>();

/** Run `fn` with every entry it writes kept, even one that reverses a recent change. */
export function withoutCancel<T>(store: LocalStore, fn: () => T): T {
  recording.add(store);
  try {
    return fn();
  } finally {
    recording.delete(store);
  }
}

/** Append (or merge, or cancel) an entry; the shared tail of both writers. */
function record(
  store: LocalStore,
  actorId: string,
  target: Record<string, string>,
  kind: string,
  from: string | null,
  to: string | null,
  now: number,
  merge: boolean,
): string | null {
  const key = activityKeyOf({ ...target, kind });
  if (key && merge && MERGED_KINDS.has(kind)) {
    const prev = ownRecent(store, key, actorId, now, ACTIVITY_MERGE_MS);
    if (prev) {
      store.set("activity", prev.id, "to", to);
      store.set("activity", prev.id, "created_at", now);
      noteWrite(store, prev.id);
      return prev.id;
    }
  }
  if (key && !recording.has(store) && !MERGED_KINDS.has(kind)) {
    const prev = ownRecent(store, key, actorId, now, ACTIVITY_CANCEL_MS);
    if (prev && reverses(prev.fields, kind, to)) {
      store.remove("activity", prev.id);
      noteRemove(store);
      return null;
    }
  }
  const id = store.newEntityId();
  for (const [field, value] of Object.entries(target)) store.set("activity", id, field, value);
  store.set("activity", id, "actor_id", actorId);
  store.set("activity", id, "kind", kind);
  if (from !== null) store.set("activity", id, "from", from);
  if (to !== null) store.set("activity", id, "to", to);
  store.set("activity", id, "created_at", now);
  noteWrite(store, id);
  return id;
}

/**
 * Append a task activity entry. No-op when `actorId` is unknown (background contexts), so only
 * user-driven edits are recorded.
 *
 * - A title or description edit extends the actor's entry of the last {@link ACTIVITY_MERGE_MS}
 *   (its `to` and time move; its `from` stays), so typing is one entry.
 * - A change that puts back what the actor's own latest entry on that field changed, within
 *   {@link ACTIVITY_CANCEL_MS}, removes that entry instead (see {@link withoutCancel}).
 * - A description's `to` is {@link hashText} of the new text.
 *
 * The id comes from `store.newEntityId()`: Hermes has no global `crypto`, and a non-UUID id would
 * 422 the sync batch. `merge: false` always appends. Returns the entry's id, or null.
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
  return record(store, actorId, { task_id: taskId }, kind, from, to, now, options.merge !== false);
}

/**
 * Append a project, section or member entry (no task). `sectionId` names the section of a section
 * event; the entry scopes through `projectId`. Reversals cancel as in {@link writeActivity}.
 * Member entries name the member's user id. No-op without an actor.
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
  const fields: Record<string, string> = { project_id: target.projectId };
  if (target.sectionId) fields.section_id = target.sectionId;
  return record(store, actorId, fields, kind, from, to, now, false);
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
