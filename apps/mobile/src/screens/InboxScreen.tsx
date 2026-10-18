import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { inboxTasks } from "@atlastodo/shared";
import { useTaskListView } from "../hooks/useTaskListView";
import { Inbox } from "../ui/icons";
import { QuickAddTaskList } from "./ViewTaskList";

/** Inbox: active tasks with no project (`inboxTasks`). Quick-add needs no `due_at` default: a project-less task is what Inbox holds. */

export interface InboxScreenProps {
  onOpenTask?: (task: Task) => void;
}

export function InboxScreen({ onOpenTask }: InboxScreenProps = {}) {
  const { t } = useTranslation();
  const view = useTaskListView("inbox");
  const tasks = useMemo(() => inboxTasks(view.tasks), [view.tasks]);

  return (
    <QuickAddTaskList
      view={view}
      tasks={tasks}
      onOpenTask={onOpenTask}
      emptyIcon={Inbox}
      emptyLabel={t("empty.inbox.title")}
      emptyHint={t("empty.inbox.hint")}
    />
  );
}
