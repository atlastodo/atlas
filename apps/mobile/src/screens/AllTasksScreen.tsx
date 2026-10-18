import { useMemo } from "react";
import type { Task } from "@atlastodo/client-core";
import { openTasks } from "@atlastodo/shared";
import { useTaskListView } from "../hooks/useTaskListView";
import { QuickAddTaskList } from "./ViewTaskList";

/** All tasks: every open task across every project (`@atlastodo/shared`'s `openTasks`). Grouping by project is natural here, though the default stays none. */

export interface AllTasksScreenProps {
  onOpenTask?: (task: Task) => void;
}

export function AllTasksScreen({ onOpenTask }: AllTasksScreenProps = {}) {
  const view = useTaskListView("all");
  const tasks = useMemo(() => openTasks(view.tasks), [view.tasks]);

  return <QuickAddTaskList view={view} tasks={tasks} onOpenTask={onOpenTask} />;
}
