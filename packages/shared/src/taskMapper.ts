import {
  isEncryptedEnvelope,
  type CreateTaskInput,
  type Priority,
  type Task,
} from "@atlastodo/client-core";

/**
 * Map a store entity (untyped field bag) to a typed {@link Task} with defaults for absent fields;
 * the store stays schema-agnostic.
 */

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Math.abs(v) <= 8.64e15 ? v : null;
}
function boolean(v: unknown): boolean {
  return v === true;
}
function priority(v: unknown): Priority {
  return v === 1 || v === 2 || v === 3 || v === 4 ? v : 4;
}

export function toTask(id: string, fields: Record<string, unknown>): Task {
  // A field no key here decrypts stays an envelope and maps to its default (a title of ""), so the
  // task is flagged: blank-looking values are placeholders.
  const locked = Object.values(fields).some(isEncryptedEnvelope);
  return {
    id,
    project_id: typeof fields.project_id === "string" ? fields.project_id : null,
    section_id: typeof fields.section_id === "string" ? fields.section_id : null,
    parent_id: typeof fields.parent_id === "string" ? fields.parent_id : null,
    title: str(fields.title),
    notes: str(fields.notes),
    priority: priority(fields.priority),
    start_at: numOrNull(fields.start_at),
    due_at: numOrNull(fields.due_at),
    is_completed: boolean(fields.is_completed),
    completed_at: numOrNull(fields.completed_at),
    archived_at: numOrNull(fields.archived_at),
    deleted_at: numOrNull(fields.deleted_at),
    recurrence:
      typeof fields.recurrence === "string" && fields.recurrence ? fields.recurrence : null,
    assignee_id: typeof fields.assignee_id === "string" ? fields.assignee_id : null,
    estimate_min: typeof fields.estimate_min === "number" ? fields.estimate_min : null,
    label_ids: Array.isArray(fields.label_ids)
      ? fields.label_ids.filter((x): x is string => typeof x === "string")
      : [],
    sort_order: typeof fields.sort_order === "number" ? fields.sort_order : 0,
    created_at: numOrNull(fields.created_at) ?? 0,
    updated_at: numOrNull(fields.updated_at) ?? 0,
    ...(locked ? { locked: true } : {}),
  };
}

export function taskCreateFields(input: CreateTaskInput): Record<string, unknown> {
  const now = Date.now();
  const fields: Record<string, unknown> = {};
  // Link fields first so the server can resolve the task's project for fan-out regardless of op
  // order.
  if (input.project_id != null) fields.project_id = input.project_id;
  if (input.section_id != null) fields.section_id = input.section_id;
  if (input.parent_id != null) fields.parent_id = input.parent_id;
  fields.title = input.title;
  fields.priority = input.priority ?? 4;
  fields.is_completed = false;
  fields.created_at = now;
  fields.updated_at = now;
  if (input.notes != null) fields.notes = input.notes;
  if (input.due_at != null) fields.due_at = input.due_at;
  if (input.start_at != null) fields.start_at = input.start_at;
  if (input.recurrence != null) fields.recurrence = input.recurrence;
  if (input.assignee_id != null) fields.assignee_id = input.assignee_id;
  if (input.estimate_min != null) fields.estimate_min = input.estimate_min;
  if (input.label_ids != null && input.label_ids.length > 0) fields.label_ids = input.label_ids;
  if (input.sort_order != null) fields.sort_order = input.sort_order;
  return fields;
}
