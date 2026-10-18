import { useCallback, useMemo } from "react";
import { toActivity, type Activity } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/** Read-only view of `activity` entities, written by `useLocalTasks` on key task changes (status/due/assignee). */

export interface UseActivities {
  activities: Activity[];
  /** Activity entries for a task, oldest first. */
  forTask: (taskId: string) => Activity[];
}

export function useActivities(): UseActivities {
  const { store, version } = useStore();

  const activities = useMemo(
    () => store.list("activity").map((e) => toActivity(e.id, e.fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const forTask = useCallback(
    (taskId: string) =>
      activities.filter((a) => a.task_id === taskId).sort((a, b) => a.created_at - b.created_at),
    [activities],
  );

  return { activities, forTask };
}
