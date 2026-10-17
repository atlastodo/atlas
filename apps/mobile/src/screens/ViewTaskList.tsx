import type { ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import type { UseTaskListView } from "../hooks/useTaskListView";
import { GroupedTaskList } from "../ui/GroupedTaskList";
import { QuickAdd } from "../ui/QuickAdd";
import { useIsWide } from "../hooks/useIsWide";

type ListProps = ComponentProps<typeof GroupedTaskList>;

export function bulkHandlers(view: UseTaskListView) {
  return {
    onBulkSetPriority: view.bulkSetPriority,
    onBulkSetDue: view.bulkSetDue,
    onBulkDuplicate: view.bulkDuplicate,
    onBulkDelete: view.bulkDelete,
    onBulkComplete: view.bulkComplete,
    onBulkMove: view.bulkMove,
    onBulkSetLabels: view.bulkSetLabels,
    onBulkClearLabels: view.bulkClearLabels,
  };
}

type WiredProps =
  | keyof ReturnType<typeof bulkHandlers>
  | "allTasks"
  | "now"
  | "timeZone"
  | "groupBy"
  | "groupTitle"
  | "sortBy"
  | "emptyLabel"
  | "onToggle"
  | "onSkipTask"
  | "onOpen"
  | "onReschedule"
  | "formatDue"
  | "onReorder"
  | "onReparent"
  | "onUpdateTask"
  | "onCreateTask"
  | "onDiscardTask";

type ViewTaskListProps = Omit<ListProps, WiredProps> & {
  view: UseTaskListView;
  emptyLabel?: string;
  onOpenTask?: (task: Task) => void;
};

/** A smart-list screen's task list wired to its `useTaskListView`, without quick-add or list-pref controls. */
export function ViewTaskList({ view, onOpenTask, emptyLabel, ...rest }: ViewTaskListProps) {
  const { t } = useTranslation();
  return (
    <GroupedTaskList
      allTasks={view.tasks}
      now={view.now}
      timeZone={view.timeZone}
      groupBy={view.listPref.group}
      groupTitle={view.groupTitle}
      sortBy={view.listPref.sort}
      onToggle={view.toggle}
      onSkipTask={view.skip}
      onOpen={onOpenTask}
      onReschedule={view.reschedule}
      formatDue={view.formatDue}
      {...bulkHandlers(view)}
      onReorder={view.reorderTask}
      onReparent={view.reparentTask}
      onUpdateTask={view.update}
      onCreateTask={view.create}
      onDiscardTask={view.discard}
      emptyLabel={emptyLabel ?? t("workspace.emptyTasks")}
      {...rest}
    />
  );
}

/**
 * {@link ViewTaskList} plus the list-pref menu and, on wide web, a quick-add header
 * (`quickAddDefaults` seed new tasks). A phone, web included, adds through the list's add button.
 */
export function QuickAddTaskList({
  view,
  quickAddDefaults,
  ...rest
}: ViewTaskListProps & { quickAddDefaults?: ListProps["quickAddDefaults"] }) {
  const isWide = useIsWide();
  return (
    <ViewTaskList
      view={view}
      resolveLabels={view.resolveLabels}
      resolveProject={view.resolveProject}
      smartDates={view.smartDates}
      quickAddDefaults={quickAddDefaults}
      listPref={view.listPref}
      onChangeListPref={view.setListPref}
      header={
        Platform.OS === "web" && isWide ? (
          // `pl-1`: QuickAdd's own inset then centres its "+" on the rows' 16px checkbox column.
          <View className="py-2 pl-1 pr-4">
            <QuickAdd
              onAdd={view.create}
              onCreateProject={view.createProject}
              onCreateLabel={view.createLabel}
              resolveLabels={view.resolveLabels}
              smartDates={view.smartDates}
              resolveProject={view.resolveProject}
              projects={view.projects}
              sections={view.sections}
              labels={view.labels}
              now={view.now}
              formatDue={view.formatDue}
              defaults={quickAddDefaults}
              timeZone={view.timeZone}
            />
          </View>
        ) : undefined
      }
      {...rest}
    />
  );
}
