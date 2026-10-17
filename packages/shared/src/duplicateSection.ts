import type { Section, Task } from "@atlastodo/client-core";
import { pushOpenTaskCopies, type EntityWrite } from "./duplicateProject";

export interface DuplicateSectionPlan {
  newSectionId: string;
  writes: EntityWrite[];
}

/**
 * The field writes for duplicating one section and its open tasks (completed and trashed ones
 * dropped, like {@link planProjectDuplicate}). Only the section name gets "(copy)"; a sub-task
 * keeps its parent only when the parent is in the copy. Pure given `mkId`/`now`.
 */
export function planSectionDuplicate(
  section: Section,
  tasks: Task[],
  opts: { mkId: () => string; now: number },
): DuplicateSectionPlan {
  const { mkId, now } = opts;
  const writes: EntityWrite[] = [];

  const newSectionId = mkId();
  writes.push({
    kind: "section",
    id: newSectionId,
    field: "project_id",
    value: section.project_id,
  });
  writes.push({
    kind: "section",
    id: newSectionId,
    field: "name",
    value: `${section.name} (copy)`,
  });
  writes.push({ kind: "section", id: newSectionId, field: "sort_order", value: now });

  const openTasks = tasks.filter(
    (task) => task.section_id === section.id && !task.is_completed && task.deleted_at == null,
  );
  pushOpenTaskCopies(writes, openTasks, section.project_id, () => newSectionId, opts);

  return { newSectionId, writes };
}
