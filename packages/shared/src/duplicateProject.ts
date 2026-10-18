import type { EntityKind, Project, Section, Task } from "@atlastodo/client-core";

export interface EntityWrite {
  kind: EntityKind;
  id: string;
  field: string;
  value: unknown;
}

export interface DuplicateProjectPlan {
  newProjectId: string;
  writes: EntityWrite[];
}

function pushTaskCopyFields(writes: EntityWrite[], id: string, task: Task, now: number): void {
  const push = (field: string, value: unknown) => writes.push({ kind: "task", id, field, value });
  push("title", task.title);
  push("priority", task.priority);
  push("is_completed", false);
  push("created_at", now);
  push("updated_at", now);
  if (task.notes) push("notes", task.notes);
  if (task.due_at != null) push("due_at", task.due_at);
  if (task.start_at != null) push("start_at", task.start_at);
  if (task.recurrence != null) push("recurrence", task.recurrence);
  if (task.estimate_min != null) push("estimate_min", task.estimate_min);
  if (task.label_ids.length > 0) push("label_ids", task.label_ids);
  if (task.sort_order) push("sort_order", task.sort_order);
}

// A section link is kept only when `newSectionId` maps it, a parent link only when the parent is in
// the copy. Assignee and completion state are dropped.
export function pushOpenTaskCopies(
  writes: EntityWrite[],
  openTasks: Task[],
  projectId: string,
  newSectionId: (task: Task) => string | undefined,
  opts: { mkId: () => string; now: number },
): void {
  // Mint ids for all tasks first so parent links can be remapped in one pass.
  const taskIdMap = new Map<string, string>();
  for (const task of openTasks) taskIdMap.set(task.id, opts.mkId());

  for (const task of openTasks) {
    const id = taskIdMap.get(task.id)!;
    const push = (field: string, value: unknown) => writes.push({ kind: "task", id, field, value });
    push("project_id", projectId);
    const sectionId = newSectionId(task);
    if (sectionId != null) push("section_id", sectionId);
    const newParentId = task.parent_id != null ? taskIdMap.get(task.parent_id) : undefined;
    if (newParentId != null) push("parent_id", newParentId);
    pushTaskCopyFields(writes, id, task, opts.now);
  }
}

// Deep duplicate: the project, its sections and its open tasks, remapped through fresh ids.
export function planProjectDuplicate(
  project: Project,
  sections: Section[],
  tasks: Task[],
  opts: { mkId: () => string; now: number },
): DuplicateProjectPlan {
  const { mkId, now } = opts;
  const writes: EntityWrite[] = [];

  const newProjectId = mkId();
  const projPush = (field: string, value: unknown) =>
    writes.push({ kind: "project", id: newProjectId, field, value });
  projPush("name", `${project.name} (copy)`);
  projPush("kind", "project");
  // The copy lands beside its original, in the same folder.
  projPush("parent_id", project.parent_id);
  projPush("sort_order", now);
  if (project.color) projPush("color", project.color);
  if (project.icon) projPush("icon", project.icon);
  if (project.default_view === "board") projPush("default_view", "board");

  const sectionIdMap = new Map<string, string>();
  for (const section of sections) {
    const id = mkId();
    sectionIdMap.set(section.id, id);
    writes.push({ kind: "section", id, field: "project_id", value: newProjectId });
    writes.push({ kind: "section", id, field: "name", value: section.name });
    writes.push({ kind: "section", id, field: "sort_order", value: section.sort_order });
  }

  // A section link pointing outside the copy (e.g. a trashed section) is dropped.
  const openTasks = tasks.filter((task) => !task.is_completed && task.deleted_at == null);
  pushOpenTaskCopies(
    writes,
    openTasks,
    newProjectId,
    (task) => (task.section_id != null ? sectionIdMap.get(task.section_id) : undefined),
    opts,
  );

  return { newProjectId, writes };
}
