import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { useLocalTasks } from "./useLocalTasks";
import { useProjects } from "./useProjects";
import { useFormat } from "./useFormat";

/**
 * Everything the command palette's task-results section needs, so both palette containers (the
 * root hotkey shell and the tab-header search button) share one wiring.
 *
 * `tasks` is the store's visible list (completed included, minus trash/archive: a result must be
 * reachable). Matching and ranking live in `@atlastodo/shared`'s `searchTasks`; this hook supplies the
 * candidates and per-row context, and no navigation (the containers own `router`).
 */
export interface TaskSearchSource {
  /** The tasks a search covers. */
  tasks: Task[];
  /** Right-aligned row context: "Project · due", falling back to Inbox and dropping what's absent. */
  context: (task: Task) => string;
}

export function useTaskSearch(): TaskSearchSource {
  const { t } = useTranslation();
  const { tasks } = useLocalTasks();
  const { projects } = useProjects();
  const format = useFormat();

  // A task without a project lives in the inbox; an unknown id (deleted mid-search) reads as one too.
  const projectName = useCallback(
    (projectId: string | null) =>
      projectId === null
        ? t("group.inbox")
        : (projects.find((p) => p.id === projectId)?.name ?? t("group.inbox")),
    [projects, t],
  );

  const context = useCallback(
    (task: Task) => {
      const project = projectName(task.project_id);
      const due = task.due_at !== null ? format.dueChip(task.due_at) : "";
      return due === "" ? project : `${project} · ${due}`;
    },
    [projectName, format],
  );

  return useMemo(() => ({ tasks, context }), [tasks, context]);
}
