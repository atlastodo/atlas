import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { endOfDay, upcomingTasks } from "@atlastodo/shared";
import { useTaskListView } from "../hooks/useTaskListView";
import { CalendarDays } from "../ui/icons";
import { QuickAddTaskList } from "./ViewTaskList";

/**
 * Upcoming: everything due after today, grouped by day (`upcomingTasks` plus `groupTasks`' `date`
 * mode); the choice is changeable and syncs. Navigation is injected: importing expo-router's
 * `router` into a screen drags its dev-server lookup into every test that renders it.
 */

export interface UpcomingScreenProps {
  onOpenTask?: (task: Task) => void;
}

export function UpcomingScreen({ onOpenTask }: UpcomingScreenProps = {}) {
  const { t } = useTranslation();
  const view = useTaskListView("upcoming", { group: "date", sort: "manual" });

  const tasks = useMemo(
    () => upcomingTasks(view.tasks, view.now, view.timeZone),
    [view.tasks, view.now, view.timeZone],
  );

  return (
    <QuickAddTaskList
      view={view}
      tasks={tasks}
      onOpenTask={onOpenTask}
      emptyIcon={CalendarDays}
      emptyLabel={t("empty.upcoming.title")}
      emptyHint={t("empty.upcoming.hint")}
      quickAddDefaults={{ due_at: endOfDay(view.now + 86_400_000, view.timeZone) }}
    />
  );
}
