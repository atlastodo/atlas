/**
 * Trash. Deleting sets a synced `deleted_at`, recoverable for 30 days. "Delete permanently" and
 * the sweep issue the real tombstone (`store.remove`). A trashed container's children are hidden
 * by a read-time cascade and hard-purged with it.
 */
import { isEncryptedEnvelope, type EntityKind, type LocalStore } from "@atlastodo/client-core";

export const TRASH_KINDS: EntityKind[] = [
  "task",
  "project",
  "section",
  "saved_filter",
  "habit",
  "comment",
  "reminder",
  "label",
  // A deleted attachment must be tombstoned eventually: the server frees its blob only then.
  "attachment",
];

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Rounded up so a partial last day reads "1 day left"; clamped at 0.
export function daysUntilPurge(deletedAt: number, now: number): number {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((deletedAt + TRASH_RETENTION_MS - now) / dayMs));
}

export function isTrashed(fields: Record<string, unknown>): boolean {
  return typeof fields.deleted_at === "number";
}

// Rewrites every field at a fresh timestamp: another device may have purged the item, and a
// tombstone hides earlier fields, so clearing `deleted_at` alone would revive an untitled husk.
// Values this device cannot open are left alone.
export function restoreEntity(store: LocalStore, kind: EntityKind, id: string): void {
  for (const { field, value } of store.visibleFieldStates(kind, id)) {
    if (field === "deleted_at" || isEncryptedEnvelope(value)) continue;
    store.set(kind, id, field, value);
  }
  store.set(kind, id, "deleted_at", null);
}

export function softDelete(
  store: LocalStore,
  kick: () => void,
  kind: EntityKind,
  id: string,
): () => void {
  store.set(kind, id, "deleted_at", Date.now());
  kick();
  return () => {
    restoreEntity(store, kind, id);
    kick();
  };
}

export function restoreFromTrash(
  store: LocalStore,
  kick: () => void,
  kind: EntityKind,
  id: string,
): void {
  restoreEntity(store, kind, id);
  kick();
}

// Kinds keyed by `task_id`, tombstoned with the task so they do not sync forever.
const TASK_CHILDREN: EntityKind[] = ["attachment", "reminder", "comment", "activity"];

// Tombstones a container's children, then the entity. A project may be a folder, so nested projects are purged too.
function purgeCascade(store: LocalStore, kind: EntityKind, id: string): void {
  // Tasks this purge removes; what hangs off them goes too (see `TASK_CHILDREN`).
  const tasks = new Set<string>(kind === "task" ? [id] : []);
  if (kind === "project") {
    const childrenOf = new Map<string, string[]>();
    for (const e of store.list("project")) {
      const parent = e.fields.parent_id;
      if (typeof parent !== "string") continue;
      const list = childrenOf.get(parent);
      if (list) list.push(e.id);
      else childrenOf.set(parent, [e.id]);
    }
    const doomed = new Set<string>([id]);
    const queue = [...(childrenOf.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (doomed.has(next)) continue; // cyclic data: never revisit
      doomed.add(next);
      queue.push(...(childrenOf.get(next) ?? []));
    }
    for (const e of store.list("section"))
      if (typeof e.fields.project_id === "string" && doomed.has(e.fields.project_id))
        store.remove("section", e.id);
    for (const e of store.list("task"))
      if (typeof e.fields.project_id === "string" && doomed.has(e.fields.project_id)) {
        store.remove("task", e.id);
        tasks.add(e.id);
      }
    for (const nested of doomed) if (nested !== id) store.remove("project", nested);
  } else if (kind === "section") {
    for (const e of store.list("task"))
      if (e.fields.section_id === id) {
        store.remove("task", e.id);
        tasks.add(e.id);
      }
  } else if (kind === "habit") {
    // Soft delete keeps check-ins (so restore brings back history); only the purge collects them.
    // A group takes its members with it; groups never nest, so one pass finds them.
    const doomed = new Set<string>([id]);
    for (const e of store.list("habit")) if (e.fields.parent_id === id) doomed.add(e.id);
    for (const e of store.list("habit_checkin")) {
      const owner = e.fields.habit_id;
      if (typeof owner === "string" && doomed.has(owner)) store.remove("habit_checkin", e.id);
    }
    for (const member of doomed) if (member !== id) store.remove("habit", member);
  }
  if (tasks.size > 0) {
    for (const child of TASK_CHILDREN) {
      for (const e of store.list(child)) {
        const task = e.fields.task_id;
        if (typeof task === "string" && tasks.has(task)) store.remove(child, e.id);
      }
    }
  }
  store.remove(kind, id);
}

export function purge(store: LocalStore, kick: () => void, kind: EntityKind, id: string): void {
  purgeCascade(store, kind, id);
  kick();
}

export interface TrashItem {
  kind: EntityKind;
  id: string;
  label: string;
  deletedAt: number;
  daysLeft: number;
}

function trashLabel(kind: EntityKind, fields: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (kind) {
    case "task":
    case "reminder":
      return s(fields.title);
    case "comment":
      return s(fields.body);
    default:
      return s(fields.name) || s(fields.title);
  }
}

export function listTrash(store: LocalStore, now: number): TrashItem[] {
  const cutoff = now - TRASH_RETENTION_MS;
  const items: TrashItem[] = [];
  for (const kind of TRASH_KINDS) {
    for (const e of store.list(kind)) {
      const del = e.fields.deleted_at;
      if (typeof del !== "number" || del <= cutoff) continue;
      items.push({
        kind,
        id: e.id,
        label: trashLabel(kind, e.fields),
        deletedAt: del,
        daysLeft: daysUntilPurge(del, now),
      });
    }
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}

export function sweepExpiredTrash(store: LocalStore, kick: () => void, now: number): number {
  const cutoff = now - TRASH_RETENTION_MS;
  let purged = 0;
  for (const kind of TRASH_KINDS) {
    for (const e of store.list(kind)) {
      const del = e.fields.deleted_at;
      if (typeof del === "number" && del <= cutoff) {
        purgeCascade(store, kind, e.id);
        purged++;
      }
    }
  }
  if (purged > 0) kick();
  return purged;
}

export function purgeAllTrash(store: LocalStore, kick: () => void, now: number): number {
  const items = listTrash(store, now);
  for (const item of items) {
    purgeCascade(store, item.kind, item.id);
  }
  if (items.length > 0) kick();
  return items.length;
}
