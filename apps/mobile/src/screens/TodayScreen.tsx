import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import {
  endOfDay,
  planDayItems,
  planDayUpcoming,
  todayTasks,
  type PlanDayWrite,
} from "@atlastodo/shared";
import { useTaskListView } from "../hooks/useTaskListView";
import { PlanDaySheet } from "../ui/PlanDaySheet";
import { Sun } from "../ui/icons";
import { QuickAddTaskList } from "./ViewTaskList";

/**
 * Today: what is due today, with anything overdue called out above it. Defaults to date grouping
 * (`groupTasks(tasks, "date")`, which supplies the red "Overdue" accent) over `todayTasks`. The
 * timezone is the synced `timezone` preference. The Plan day review ({@link PlanDaySheet}) writes
 * through the same store path as the overdue header's "reschedule all to today".
 */

export interface TodayScreenProps {
  onOpenTask?: (task: Task) => void;
}

export function TodayScreen({ onOpenTask }: TodayScreenProps = {}) {
  const { t } = useTranslation();
  const view = useTaskListView("today", { group: "date", sort: "manual" });
  const [planOpen, setPlanOpen] = useState(false);

  const tasks = useMemo(
    () => todayTasks(view.tasks, view.now, view.timeZone),
    [view.tasks, view.now, view.timeZone],
  );
  const planItems = useMemo(
    () => planDayItems(view.tasks, view.now, view.timeZone),
    [view.tasks, view.now, view.timeZone],
  );
  const planUpcoming = useMemo(
    () => planDayUpcoming(view.tasks, view.now, view.timeZone),
    [view.tasks, view.now, view.timeZone],
  );
  const applyPlan = useCallback((writes: PlanDayWrite[]) => view.applyPlanDay(writes), [view]);

  return (
    <>
      <QuickAddTaskList
        view={view}
        tasks={tasks}
        onOpenTask={onOpenTask}
        emptyIcon={Sun}
        emptyLabel={t("empty.today.title")}
        emptyHint={t("empty.today.hint")}
        onRescheduleOverdue={(overdue) =>
          view.rescheduleMany(overdue, endOfDay(view.now, view.timeZone))
        }
        onPlanDay={() => setPlanOpen(true)}
        quickAddDefaults={{ due_at: endOfDay(view.now, view.timeZone) }}
      />
      <PlanDaySheet
        open={planOpen}
        items={planItems}
        upcoming={planUpcoming}
        now={view.now}
        timeZone={view.timeZone}
        formatDue={view.formatDue}
        onApply={applyPlan}
        onClose={() => setPlanOpen(false)}
      />
    </>
  );
}
