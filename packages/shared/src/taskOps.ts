import {
  isEncryptedEnvelope,
  type CreateTaskInput,
  type LocalStore,
  type Task,
} from "@atlastodo/client-core";
import { taskCreateFields, toTask } from "./taskMapper";
import { advanceSeries, anchorMonthDay } from "./recurrence";
import { writeActivity } from "./activity";
import { restoreEntity } from "./trash";
import { wouldCycle } from "./taskTree";
import { hiddenProjectIds } from "./projectTree";
import { dayOffset, makeInstant, resolveTimeZone, zonedParts } from "./zonedTime";

/**
 * The task rules as pure functions over a {@link LocalStore}, with no React.
 *
 * - `now` is injected; `timeZone` defaults to the runtime zone.
 * - Ids come from `store.newEntityId()`, never `crypto.randomUUID()`: Hermes has no global
 *   `crypto`, and a non-UUID entity id 422s the whole sync push batch.
 * - Deletes are soft (`deleted_at`); a real tombstone is only issued by an explicit purge.
 * - A locked task is read-only: every write refuses one this device cannot decrypt.
 */

// Its typed fields are placeholders, so a write built from them would overwrite what other members
// see. Checks the store, so a stale `Task` snapshot cannot slip past.
export function isTaskLocked(store: LocalStore, id: string): boolean {
  const fields = store.get("task", id);
  return fields != null && Object.values(fields).some(isEncryptedEnvelope);
}

function locked(store: LocalStore, task: Task): boolean {
  return task.locked === true || isTaskLocked(store, task.id);
}

export interface TaskMove {
  section_id?: string | null;
  sort_order?: number;
  due_at?: number | null;
  parent_id?: string | null;
}

// Derived lists, per store, cached until the kinds they read change. The arrays are shared: do not mutate.
const allCache = new WeakMap<LocalStore, { rev: number; tasks: Task[] }>();
const visibleCache = new WeakMap<Task[], { projects: number; sections: number; tasks: Task[] }>();
const archivedCache = new WeakMap<Task[], Task[]>();

export function allTasks(store: LocalStore): Task[] {
  const rev = store.revision("task");
  const cached = allCache.get(store);
  if (cached?.rev === rev) return cached.tasks;
  const tasks = store
    .list("task")
    .map((e) => toTask(e.id, e.fields))
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at);
  allCache.set(store, { rev, tasks });
  return tasks;
}

function idsWithTimestamp(
  store: LocalStore,
  kind: "project" | "section",
  field: string,
): Set<string> {
  const ids = new Set<string>();
  for (const e of store.list(kind)) if (typeof e.fields[field] === "number") ids.add(e.id);
  return ids;
}

// The container cascade is resolved at read time, so restoring a project brings its tasks back and a delete stays O(1) ops.
export function visibleTasks(store: LocalStore, tasks: Task[] = allTasks(store)): Task[] {
  const projects = store.revision("project");
  const sections = store.revision("section");
  const cached = visibleCache.get(tasks);
  if (cached?.projects === projects && cached.sections === sections) return cached.tasks;
  const visible = filterVisible(store, tasks);
  visibleCache.set(tasks, { projects, sections, tasks: visible });
  return visible;
}

function filterVisible(store: LocalStore, tasks: Task[]): Task[] {
  const hiddenProjects = hiddenProjectIds(
    store.list("project").map((e) => ({
      id: e.id,
      parent_id: typeof e.fields.parent_id === "string" ? e.fields.parent_id : null,
      archived_at: typeof e.fields.archived_at === "number" ? e.fields.archived_at : null,
      deleted_at: typeof e.fields.deleted_at === "number" ? e.fields.deleted_at : null,
    })),
  );
  const trashedSections = idsWithTimestamp(store, "section", "deleted_at");
  const archivedSections = idsWithTimestamp(store, "section", "archived_at");
  return tasks.filter(
    (t) =>
      t.deleted_at == null &&
      t.archived_at == null &&
      !(t.project_id != null && hiddenProjects.has(t.project_id)) &&
      !(t.section_id != null && trashedSections.has(t.section_id)) &&
      !(t.section_id != null && archivedSections.has(t.section_id)),
  );
}

// Tasks hidden only by an archived project are excluded: they restore with that project.
export function archivedTasks(store: LocalStore, tasks: Task[] = allTasks(store)): Task[] {
  let archived = archivedCache.get(tasks);
  if (!archived) {
    archived = tasks.filter((t) => t.archived_at != null && t.deleted_at == null);
    archivedCache.set(tasks, archived);
  }
  return archived;
}

export function createTask(store: LocalStore, input: CreateTaskInput, timeZone?: string): string {
  const id = store.newEntityId();
  const fields = taskCreateFields(
    input.recurrence && input.due_at != null
      ? { ...input, recurrence: anchorMonthDay(input.recurrence, input.due_at, timeZone) }
      : input,
  );
  for (const [field, value] of Object.entries(fields)) store.set("task", id, field, value);
  return id;
}

function shiftWithDue(ms: number, fromDue: number, toDue: number, timeZone: string): number {
  const days = dayOffset(toDue, fromDue, timeZone);
  const p = zonedParts(ms, timeZone);
  const sub = ((ms % 1000) + 1000) % 1000;
  return makeInstant(p.year, p.month, p.day + days, p.hour, p.minute, p.second, timeZone) + sub;
}

/**
 * Complete or reopen a task. Completing a recurring task with a due date closes this instance and
 * spawns the next occurrence. `start_at` and absolute reminders move by the same calendar days as
 * the due date; due-relative reminders carry over with the fire stamp reset. Reopening never spawns.
 * Returns the spawned id (the UI needs it to undo), or `null`.
 */
export function toggleTask(
  store: LocalStore,
  task: Task,
  actorId?: string,
  now: number = Date.now(),
  timeZone?: string,
): string | null {
  if (locked(store, task)) return null;
  const nowCompleted = !task.is_completed;
  let spawnedId: string | null = null;
  if (nowCompleted && task.recurrence && task.due_at != null) {
    const tz = resolveTimeZone(timeZone);
    const due = task.due_at;
    const advanced = advanceSeries(task.recurrence, due, now, tz);
    if (advanced) {
      const { next, rule } = advanced;
      const shift = (ms: number) => shiftWithDue(ms, due, next, tz);
      spawnedId = createTask(
        store,
        {
          title: task.title,
          notes: task.notes,
          priority: task.priority,
          project_id: task.project_id,
          section_id: task.section_id,
          parent_id: task.parent_id,
          start_at: task.start_at != null ? shift(task.start_at) : null,
          due_at: next,
          recurrence: rule,
          estimate_min: task.estimate_min,
          label_ids: [...task.label_ids],
          assignee_id: task.assignee_id,
        },
        tz,
      );
      for (const e of store.list("reminder")) {
        if (e.fields.task_id !== task.id) continue;
        const reminderId = store.newEntityId();
        store.set("reminder", reminderId, "task_id", spawnedId);
        if (typeof e.fields.at === "number")
          store.set("reminder", reminderId, "at", shift(e.fields.at));
        if (e.fields.offset_min_before_due != null) {
          store.set(
            "reminder",
            reminderId,
            "offset_min_before_due",
            e.fields.offset_min_before_due,
          );
        }
        store.set("reminder", reminderId, "created_at", now);
      }
    }
  }
  store.set("task", task.id, "is_completed", nowCompleted);
  store.set("task", task.id, "completed_at", nowCompleted ? now : null);
  writeActivity(
    store,
    actorId,
    task.id,
    "status",
    null,
    nowCompleted ? "completed" : "reopened",
    now,
  );
  return spawnedId;
}

// Skips fields already equal and returns whether anything changed. A new recurrence rule takes its
// day of month from the new due date ({@link anchorMonthDay}); moving only the due date leaves the rule alone.
export function updateTask(
  store: LocalStore,
  task: Task,
  patch: Partial<Task>,
  actorId?: string,
  now: number = Date.now(),
  timeZone?: string,
): boolean {
  if (locked(store, task)) return false;
  const due = patch.due_at !== undefined ? patch.due_at : task.due_at;
  if (patch.recurrence && due != null) {
    patch = { ...patch, recurrence: anchorMonthDay(patch.recurrence, due, timeZone) };
  }
  let changed = false;
  for (const [field, value] of Object.entries(patch)) {
    if ((task as unknown as Record<string, unknown>)[field] === value) continue;
    store.set("task", task.id, field, value);
    changed = true;
    if (field === "due_at") {
      writeActivity(
        store,
        actorId,
        task.id,
        "due",
        task.due_at != null ? String(task.due_at) : null,
        typeof value === "number" ? String(value) : null,
        now,
      );
    } else if (field === "assignee_id") {
      writeActivity(
        store,
        actorId,
        task.id,
        "assignee",
        task.assignee_id,
        typeof value === "string" ? value : null,
        now,
      );
    }
  }
  if (changed) store.set("task", task.id, "updated_at", now);
  return changed;
}

export type RecurEditScope = "this_occurrence" | "all_occurrences";

// A patch touching `recurrence` is always a series edit: detaching with it would fork the series.
export function updateRecurringTask(
  store: LocalStore,
  task: Task,
  patch: Partial<Task>,
  scope: RecurEditScope,
  actorId?: string,
  now: number = Date.now(),
  timeZone?: string,
): boolean {
  if (locked(store, task)) return false;
  if (
    scope === "all_occurrences" ||
    patch.recurrence !== undefined ||
    !task.recurrence ||
    task.due_at == null
  ) {
    const seriesPatch =
      patch.due_at != null && patch.recurrence === undefined && task.recurrence
        ? { ...patch, recurrence: anchorMonthDay(task.recurrence, patch.due_at, timeZone) }
        : patch;
    return updateTask(store, task, seriesPatch, actorId, now, timeZone);
  }

  // "this_occurrence": detach as a one-off and spawn the series from the next occurrence.
  const tz = resolveTimeZone(timeZone);
  const advanced = advanceSeries(task.recurrence, task.due_at, now, tz);
  if (advanced) {
    const { next, rule } = advanced;
    const nextStart =
      task.start_at != null ? shiftWithDue(task.start_at, task.due_at, next, tz) : null;
    createTask(
      store,
      {
        title: task.title,
        notes: task.notes,
        priority: task.priority,
        project_id: task.project_id,
        section_id: task.section_id,
        parent_id: task.parent_id,
        start_at: nextStart,
        due_at: next,
        recurrence: rule,
        estimate_min: task.estimate_min,
        label_ids: [...task.label_ids],
        assignee_id: task.assignee_id,
      },
      tz,
    );
  }

  store.set("task", task.id, "recurrence", null);
  updateTask(store, { ...task, recurrence: null }, patch, actorId, now);
  return true;
}

/**
 * Advance a recurring task to its next occurrence without completing it. The due date only moves
 * forward: an after-completion rule landing before it is a no-op. Returns whether it advanced.
 */
export function skipTask(
  store: LocalStore,
  task: Task,
  actorId?: string,
  now: number = Date.now(),
  timeZone?: string,
): boolean {
  if (locked(store, task) || task.is_completed || !task.recurrence || task.due_at == null) {
    return false;
  }
  const tz = resolveTimeZone(timeZone);
  const due = task.due_at;
  const advanced = advanceSeries(task.recurrence, due, now, tz);
  if (!advanced || advanced.next <= due) return false;
  const { next, rule } = advanced;
  const shift = (ms: number) => shiftWithDue(ms, due, next, tz);
  updateTask(
    store,
    task,
    {
      due_at: next,
      ...(task.start_at != null ? { start_at: shift(task.start_at) } : {}),
      ...(rule !== task.recurrence ? { recurrence: rule } : {}),
    },
    actorId,
    now,
    tz,
  );
  for (const e of store.list("reminder")) {
    if (e.fields.task_id !== task.id) continue;
    if (typeof e.fields.at === "number") store.set("reminder", e.id, "at", shift(e.fields.at));
  }
  return true;
}

export function moveTask(
  store: LocalStore,
  id: string,
  patch: TaskMove,
  now: number = Date.now(),
): boolean {
  if (isTaskLocked(store, id)) return false;
  let changed = false;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    store.set("task", id, field, value);
    changed = true;
  }
  if (changed) store.set("task", id, "updated_at", now);
  return changed;
}

// Rejected (`false`) when it would create a cycle in `allTasks`. A subtask keeps its project and section.
export function reparentTask(
  store: LocalStore,
  allTasks: Task[],
  id: string,
  parentId: string | null,
  sortOrder: number,
  now: number = Date.now(),
): boolean {
  if (wouldCycle(allTasks, id, parentId)) return false;
  return moveTask(store, id, { parent_id: parentId, sort_order: sortOrder }, now);
}

export interface TaskProjectMove {
  project_id: string | null;
  section_id: string | null;
  sort_order?: number;
}

// "Move to": rewrites `project_id` and `section_id` together (a stale `section_id` would orphan the task). `null` is the Inbox.
export function moveTaskToProject(
  store: LocalStore,
  id: string,
  target: TaskProjectMove,
  now: number = Date.now(),
): boolean {
  if (isTaskLocked(store, id)) return false;
  store.set("task", id, "project_id", target.project_id);
  store.set("task", id, "section_id", target.section_id);
  if (target.sort_order !== undefined) store.set("task", id, "sort_order", target.sort_order);
  store.set("task", id, "updated_at", now);
  return true;
}

export function softDeleteTask(store: LocalStore, task: Task, now: number = Date.now()): boolean {
  if (locked(store, task)) return false;
  store.set("task", task.id, "deleted_at", now);
  return true;
}

export function restoreTask(store: LocalStore, task: Task): boolean {
  if (locked(store, task)) return false;
  restoreEntity(store, "task", task.id);
  return true;
}

// Hard-remove (real tombstone) to undo a just-created duplicate. Refuses a task this device cannot
// decrypt, whose tombstone would reach every member.
export function discardTask(store: LocalStore, id: string): boolean {
  if (isTaskLocked(store, id)) return false;
  store.remove("task", id);
  return true;
}

// The copy always starts open. A locked task is not copied (`null`).
export function duplicateTask(store: LocalStore, task: Task, timeZone?: string): string | null {
  if (locked(store, task)) return null;
  return createTask(
    store,
    {
      title: `${task.title} (copy)`,
      notes: task.notes,
      priority: task.priority,
      project_id: task.project_id,
      section_id: task.section_id,
      parent_id: task.parent_id,
      start_at: task.start_at,
      due_at: task.due_at,
      recurrence: task.recurrence,
      estimate_min: task.estimate_min,
      label_ids: task.label_ids,
      assignee_id: task.assignee_id,
    },
    timeZone,
  );
}

export function setTaskArchived(
  store: LocalStore,
  task: Task,
  archived: boolean,
  now: number = Date.now(),
): boolean {
  if (locked(store, task)) return false;
  store.set("task", task.id, "archived_at", archived ? now : null);
  store.set("task", task.id, "updated_at", now);
  return true;
}
