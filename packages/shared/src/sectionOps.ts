import type { LocalStore, Section, Task } from "@atlastodo/client-core";
import { toSection } from "./sectionMapper";
import { allTasks } from "./taskOps";
import { writeProjectActivity } from "./activity";

// Section rules over a {@link LocalStore} that touch more than one entity.

export function allSections(store: LocalStore): Section[] {
  return store
    .list("section")
    .map((e) => toSection(e.id, e.fields))
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export function visibleSections(store: LocalStore, projectId: string): Section[] {
  return allSections(store).filter(
    (s) => s.project_id === projectId && s.deleted_at == null && s.archived_at == null,
  );
}

// Tasks carry a redundant `project_id` that must move in lockstep or they are orphaned. Trashed tasks are left alone.
export function moveSectionToProject(
  store: LocalStore,
  sectionId: string,
  targetProjectId: string,
  now: number = Date.now(),
  tasks: Task[] = allTasks(store),
): void {
  store.set("section", sectionId, "project_id", targetProjectId);
  for (const task of tasks) {
    if (task.section_id === sectionId && task.project_id !== targetProjectId) {
      store.set("task", task.id, "project_id", targetProjectId);
      store.set("task", task.id, "updated_at", now);
    }
  }
}

// Tasks are untouched: the read cascade in {@link visibleTasks} hides them. `actorId` records it.
export function setSectionArchived(
  store: LocalStore,
  sectionId: string,
  archived: boolean,
  now: number = Date.now(),
  actorId?: string,
): void {
  store.set("section", sectionId, "archived_at", archived ? now : null);
  const fields = store.get("section", sectionId);
  if (typeof fields?.project_id !== "string" || fields.project_id === "") return;
  writeProjectActivity(
    store,
    actorId,
    { projectId: fields.project_id, sectionId },
    archived ? "section_archived" : "section_unarchived",
    null,
    typeof fields.name === "string" ? fields.name : null,
    now,
  );
}
