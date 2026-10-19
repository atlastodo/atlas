import type { LocalStore } from "@atlastodo/client-core";

/**
 * Activity-feed entries: an `activity` entity recording a key task change (status, due date,
 * assignee) with actor and timestamp, written by {@link writeActivity} and shown beside comments.
 * Fans out like a comment on shared projects.
 */
export type ActivityKind = "status" | "due" | "assignee";

export interface Activity {
  id: string;
  task_id: string;
  actor_id: string;
  kind: ActivityKind;
  from: string | null;
  to: string | null;
  created_at: number;
}

export function toActivity(id: string, fields: Record<string, unknown>): Activity {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  const kind = fields.kind;
  return {
    id,
    task_id: str(fields.task_id),
    actor_id: str(fields.actor_id),
    kind: kind === "due" || kind === "assignee" ? kind : "status",
    from: strOrNull(fields.from),
    to: strOrNull(fields.to),
    created_at: typeof fields.created_at === "number" ? fields.created_at : 0,
  };
}

/**
 * Append an activity entry. No-op when `actorId` is unknown (background contexts), so only
 * user-driven edits are recorded. The id comes from `store.newEntityId()`: Hermes has no global
 * `crypto`, and a non-UUID id would 422 the sync batch.
 */
export function writeActivity(
  store: LocalStore,
  actorId: string | undefined,
  taskId: string,
  kind: ActivityKind,
  from: string | null,
  to: string | null,
  now: number = Date.now(),
): void {
  if (!actorId) return;
  const id = store.newEntityId();
  store.set("activity", id, "task_id", taskId);
  store.set("activity", id, "actor_id", actorId);
  store.set("activity", id, "kind", kind);
  if (from !== null) store.set("activity", id, "from", from);
  if (to !== null) store.set("activity", id, "to", to);
  store.set("activity", id, "created_at", now);
}
