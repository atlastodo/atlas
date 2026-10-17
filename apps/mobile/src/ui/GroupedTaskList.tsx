import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  SectionList,
  Text,
  View,
  type FlatList,
} from "react-native";
import ReorderableList from "react-native-reorderable-list";
import { scheduleOnRN } from "react-native-worklets";
import { useTranslation } from "react-i18next";
import type { CreateTaskInput, Priority, Task } from "@atlastodo/client-core";
import {
  avatarColorFor,
  indentTarget,
  initialsOf,
  outdentTarget,
  rankAfterChildren,
  rankBetween,
  reorderRank,
  resolveIndentTarget,
  taskListSections,
  type GroupBy,
  type ListTaskRow,
  type RankWrite,
  type SortBy,
} from "@atlastodo/shared";
import { useAuth } from "../auth/AuthContext";
import { useSelection } from "../data/SelectionProvider";
import { useRegisterSelectionActions } from "../data/SelectionActionsProvider";
import { useCursorList } from "../data/CursorProvider";
import { useReminderTaskIds } from "../hooks/useReminders";
import { useTaskClipboard } from "../hooks/useTaskClipboard";
import { useSelectionSource } from "../hooks/useSelectionSource";
import { useOutsidePressExit } from "../hooks/useOutsidePressExit";
import { useIsWide } from "../hooks/useIsWide";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { useDragPan } from "../hooks/useDragPan";
import { useLabels } from "../hooks/useLabels";
import { useProjects } from "../hooks/useProjects";
import { useAllSections } from "../hooks/useAllSections";
import { useProjectMembers } from "../hooks/useProjectMembers";
import { usePreferences } from "../hooks/usePreferences";
import { useStableCallback } from "../hooks/useStableCallback";
import { QuickRescheduleSheet } from "./QuickRescheduleSheet";
import { SelectionToolbar } from "./SelectionToolbar";
import { ListToolbar } from "./ListToolbar";
import { TaskContextMenu } from "./TaskContextMenu";
import { TaskRow, type RowAssignee, type TaskOrigin, type TaskRowHandle } from "./TaskRow";
import { DraggableTaskRow } from "./DraggableTaskRow";
import { DragToReorder } from "./DragToReorder";
import { AnimatedRow } from "./AnimatedRow";
import { MoveToPicker } from "./MoveToPicker";
import { BulkLabelSheet } from "./BulkLabelSheet";
import { FloatingAddButton } from "./FloatingAddButton";
import { KeyboardPinnedTaskAdd } from "./KeyboardPinnedTaskAdd";
import { KeyboardPinnedRenameBar } from "./KeyboardPinnedRenameBar";
import type { MenuPos } from "../hooks/useContextMenu";
import type { ListPref } from "../hooks/usePreferences";
import { dragReleaseAction } from "../lib/dragRelease";
import { haptics } from "../lib/haptics";
import { CalendarClock, ChevronDown, ChevronRight, Inbox, type LucideIcon } from "./icons";
import { EmptyState } from "./EmptyState";
import { displayTitle } from "../lib/taskTitle";
import { LIST_WIDTH_STYLE } from "./listWidth";

/**
 * The list surface every smart view is built on: grouping, sorting, multi-select and the empty
 * state, over a `SectionList`.
 *
 * Grouping and nesting come from `@atlastodo/shared`'s `taskListSections`, which also widens each group
 * with context parents and open subtasks the view's filter left out. Group titles are resolved by
 * the caller (`groupTitle`).
 *
 * A `SectionList` even when ungrouped (one unnamed section). It counts headers as items, so
 * `ListEmptyComponent` fires only when there are no sections at all; a collapsed group keeps its
 * header. The collapsed set is local state and resets when you leave the screen.
 */

export interface GroupedTaskListProps {
  tasks: Task[];
  /**
   * The full set the view filtered `tasks` out of, so a matched task's parent or open subtask can
   * be pulled in and nested. Grouping still runs on `tasks` alone. Omit it and each group is its
   * own universe (a task whose parent is elsewhere renders at depth 0); Completed relies on that.
   */
  allTasks?: Task[];
  now: number;
  timeZone?: string;
  groupBy: GroupBy;
  /** Resolve a group key to its display title (the caller owns project/label lookups). */
  groupTitle: (kind: GroupBy, key: string) => string;
  sortBy: SortBy;
  projectOrder?: string[];
  labelOrder?: string[];
  onToggle: (task: Task) => void;
  /** Skip a recurring task's occurrence (advance its due date without completing). */
  onSkipTask?: (task: Task) => void;
  onOpen?: (task: Task) => void;
  /** Reschedule one task via swipe-left. */
  onReschedule?: (task: Task, dueAt: number | null) => void;
  formatDue?: (ms: number) => string;
  /** Bulk actions, applied across the selection. */
  onBulkSetPriority: (ids: string[], priority: Priority) => void;
  onBulkSetDue: (ids: string[], dueAt: number | null) => void;
  onBulkSetLabels: (ids: string[], change: { add: string[]; remove: string[] }) => void;
  onBulkClearLabels: (ids: string[]) => void;
  onBulkDuplicate: (ids: string[]) => void;
  onBulkDelete: (ids: string[]) => void;
  /** Complete the selected tasks with a single undoable toast. */
  onBulkComplete?: (ids: string[]) => void;
  /** Move the selected tasks to another project/section. */
  onBulkMove: (
    ids: string[],
    target: { project_id: string | null; section_id: string | null },
  ) => void;
  /** Rendered above the list (quick-add, a header). */
  header?: ReactElement;
  /** Shown when there is nothing at all, as the {@link EmptyState} title (with `emptyIcon` and `emptyHint`). */
  emptyLabel?: string;
  /** The empty state's icon (default: the inbox tray). */
  emptyIcon?: LucideIcon;
  emptyHint?: string;
  /** Group keys to start collapsed (seeded once on mount); e.g. Completed folds older buckets. */
  initialCollapsedKeys?: string[];
  /** Show the Select + group/sort toolbar (default true). The project screen has them in its nav header. */
  showToolbar?: boolean;
  /** The synced group/sort preference; when given, the toolbar shows the group/sort menu. */
  listPref?: ListPref;
  onChangeListPref?: (patch: Partial<ListPref>) => void;
  /** Today's "reschedule all overdue to today": when given, a danger (overdue) group header shows it. */
  onRescheduleOverdue?: (tasks: Task[]) => void;
  /** Today's "Plan day" entry point; the screen owns the sheet. */
  onPlanDay?: () => void;
  /**
   * Persist a reordered task's new sort_order. When given AND the list is flat + manually sorted
   * (`group: none`, `sort: manual`), rows become drag-reorderable via a whole-row long-press.
   */
  onReorder?: (id: string, sortOrder: number) => void;
  /** Persist a subtask reparent; a drag on a flat manual list then routes through `resolveIndentTarget`. */
  onReparent?: (id: string, parentId: string | null, sortOrder: number) => void;
  /** Update task fields (e.g. title after inline rename). */
  onUpdateTask?: (task: Task, patch: Partial<Task>) => void;
  /** Create a new task (used for Enter-to-create-below and FAB quick-add). */
  onCreateTask?: (input: CreateTaskInput) => string;
  /** Discard a task by id (e.g. newly created empty task cancelled or blurred with no title). */
  onDiscardTask?: (id: string) => void;
  /** Default fields for tasks created via FAB quick-add */
  quickAddDefaults?: Partial<CreateTaskInput>;
  /** Resolve labels for FAB quick-add */
  resolveLabels?: (names: string[]) => string[];
  /** Resolve project for FAB quick-add */
  resolveProject?: (name: string) => string | null;
  /** Smart dates toggle for FAB quick-add */
  smartDates?: boolean;
}

interface Section {
  key: string;
  title: string;
  danger: boolean;
  /** The tasks genuinely in this group, excluding context parents (the header count). */
  matched: Task[];
  data: Task[];
}

/** The group key of the reorderable (ungrouped) list, whose rows' siblings are `visible`. */
const FLAT_GROUP = "\0flat";

/** A row's handlers that depend on its group (see `handlersFor`). */
interface GroupRowHandlers {
  indent: (task: Task) => void;
  outdent: (task: Task) => void;
  contextMenu: (task: Task, pos: MenuPos) => void;
}

/** Distinct tasks in first-seen order; `label` grouping renders one task under each label. */
const uniqueTasks = (rows: Task[]): Task[] => {
  const seen = new Set<string>();
  return rows.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
};

export function GroupedTaskList({
  tasks,
  allTasks,
  now,
  timeZone,
  groupBy,
  groupTitle,
  sortBy,
  projectOrder: projectOrderProp,
  labelOrder: labelOrderProp,
  onToggle,
  onSkipTask,
  onOpen,
  onReschedule,
  formatDue,
  onBulkSetPriority,
  onBulkSetDue,
  onBulkSetLabels,
  onBulkClearLabels,
  onBulkDuplicate,
  onBulkDelete,
  onBulkComplete,
  onBulkMove,
  header,
  emptyLabel,
  emptyIcon,
  emptyHint,
  initialCollapsedKeys,
  showToolbar = true,
  listPref,
  onChangeListPref,
  onRescheduleOverdue,
  onPlanDay,
  onReorder,
  onReparent,
  onUpdateTask,
  onCreateTask,
  onDiscardTask,
  quickAddDefaults,
  resolveLabels,
  resolveProject,
  smartDates = true,
}: GroupedTaskListProps) {
  const { t } = useTranslation();
  const selection = useSelection();
  const isWide = useIsWide();

  const { byId: labelOf, labels, createLabel } = useLabels();
  const { projects, createProject } = useProjects();
  const allSections = useAllSections();
  const { byUserId } = useProjectMembers();
  const { swipeRightAction, swipeLeftAction } = usePreferences();
  const { session } = useAuth();
  const myId = session?.user.id;

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const editingTask = editingTaskId
    ? tasks.find((t) => t.id === editingTaskId) ||
      allTasks?.find((t) => t.id === editingTaskId) ||
      null
    : null;
  // Clearing `editingTaskId` alone unmounts the input before its blur can save, so the keyboard
  // toolbar commits the draft explicitly.
  const editingRowRef = useRef<TaskRowHandle | null>(null);
  const [fabOpen, setFabOpen] = useState(false);

  const reorderableListRef = useRef<FlatList<Task>>(null);
  const sectionListRef = useRef<SectionList<Task>>(null);
  const keyboardHeight = useKeyboardHeight();
  const isWeb = Platform.OS === "web";
  // The phone shell, native or web: bottom nav plus the add button (see `(drawer)/_layout`).
  const isPhone = !isWide;
  const contentWidth = LIST_WIDTH_STYLE;
  const dynamicBottomPadding =
    editingTaskId !== null
      ? Math.max(keyboardHeight, 300) + 80
      : keyboardHeight > 0
        ? keyboardHeight + 80
        : isPhone
          ? 88
          : 16;

  // `groupTasks` emits only keys it is given an order for; without one every task outside the
  // inbox/none bucket was dropped. Derived from the loaded lists, alpha by name; props override.
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  const projectOrder = useMemo(
    () => projectOrderProp ?? [...projects].sort(byName).map((p) => p.id),
    [projectOrderProp, projects],
  );
  const labelOrder = useMemo(
    () => labelOrderProp ?? [...labels].sort(byName).map((l) => l.id),
    [labelOrderProp, labels],
  );

  const originOf = useCallback(
    (task: Task): TaskOrigin => ({
      project: task.project_id ? projects.find((p) => p.id === task.project_id)?.name : undefined,
      section: task.section_id ? allSections.byId(task.section_id)?.name : undefined,
    }),
    [projects, allSections],
  );
  const assigneeOf = useCallback(
    (task: Task): RowAssignee | undefined => {
      if (!task.assignee_id) return undefined;
      const member = byUserId(task.assignee_id);
      if (!member) return undefined;
      return {
        initials: initialsOf(member),
        name: member.display_name || member.email,
        color: avatarColorFor(member.user_id, myId),
      };
    },
    [byUserId, myId],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(initialCollapsedKeys ?? []),
  );
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => new Set());
  const toggleTaskExpand = useCallback((task: Task) => {
    setCollapsedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }, []);
  const pressPos = useRef<MenuPos>({ x: 0, y: 0 });
  const [rescheduling, setRescheduling] = useState<Task | null>(null);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [labeling, setLabeling] = useState<string[] | null>(null);
  // Web-only (native fires no `contextmenu`). `siblings` is the row's group, so Indent/Outdent match the swipe.
  const [menu, setMenu] = useState<{ task: Task; pos: MenuPos; siblings?: Task[] } | null>(null);

  const sections = useMemo(
    () =>
      taskListSections(tasks, {
        groupBy,
        now,
        timeZone,
        sortBy,
        projectOrder,
        labelOrder,
        allTasks,
        collapsedTasks,
      }).map((s) => ({
        key: s.key,
        title: s.kind === "none" ? "" : groupTitle(s.kind, s.key),
        danger: s.accent === "danger",
        matched: s.matched,
        data: s.tasks,
        rows: s.rows,
      })),
    [
      tasks,
      allTasks,
      groupBy,
      sortBy,
      now,
      timeZone,
      projectOrder,
      labelOrder,
      groupTitle,
      collapsedTasks,
    ],
  );

  const shownFlat = useMemo(
    () => sections.map((s) => ({ ...s, rows: collapsed.has(s.key) ? [] : s.rows })),
    [sections, collapsed],
  );

  // Keyed by section, not task id: under `label` grouping one task renders in several groups at different depths.
  const visibleRows = useMemo(() => shownFlat.flatMap((s) => s.rows), [shownFlat]);
  const rowsByKey = useMemo(() => {
    const m = new Map<string, ListTaskRow[]>();
    for (const s of shownFlat) m.set(s.key, s.rows);
    return m;
  }, [shownFlat]);
  const hasSubtasks = useMemo(() => visibleRows.some((r) => r.hasChildren), [visibleRows]);

  // Deduped: `label` grouping shows a task twice, and a bulk toggle per occurrence would complete then reopen it.
  const visible = useMemo(() => uniqueTasks(visibleRows.map((r) => r.task)), [visibleRows]);
  // What the selection prunes against; collapse-independent so a row in a folded group is not deselected.
  const known = useMemo(() => uniqueTasks(sections.flatMap((s) => s.data)), [sections]);
  // "Select all" skips parents shown only as scaffolding for a subtask; `known` still holds them.
  const selectableIds = useMemo(
    () => uniqueTasks(visibleRows.filter((r) => r.matched).map((r) => r.task)),
    [visibleRows],
  );
  useSelectionSource(selectableIds, known);
  const outsidePress = useOutsidePressExit();

  const reminderTaskIds = useReminderTaskIds();

  const cursorId = useCursorList({
    getTasks: () => visible,
    open: (task) => onOpen?.(task),
    toggle: (task) => onToggle(task),
    reschedule: (task) => setRescheduling(task),
    remove: (task) => onBulkDelete([task.id]),
  });

  const ids = () => [...selection.selected];
  const selectedTasks = () => visible.filter((task) => selection.has(task.id));
  const allSelectedCompleted = () => {
    const chosen = selectedTasks();
    return chosen.length > 0 && chosen.every((task) => task.is_completed);
  };
  // Complete the selection, or reopen it when every selected task is already done.
  const toggleSelected = () => {
    const chosen = selectedTasks();
    if (allSelectedCompleted()) {
      for (const task of chosen) onToggle(task);
    } else if (onBulkComplete) {
      onBulkComplete(chosen.map((task) => task.id));
    } else {
      for (const task of chosen) onToggle(task);
    }
  };
  // Right-clicking a task inside a multi-task selection opens the menu on the whole selection.
  const menuOnSelection =
    menu != null && selection.mode && selection.has(menu.task.id) && selection.count > 1;

  const dragPan = useDragPan();
  const onDragRelease = useCallback(
    (from: number, to: number) => {
      // The library persists the reorder itself; a moved release only needs the drop thud.
      if (from !== to) haptics.impact("light");
      if (dragReleaseAction({ from, to, selectMode: selection.mode, isWeb }) !== "menu") return;
      const task = visible[from];
      if (task) setMenu({ task, pos: pressPos.current });
    },
    [visible, selection.mode, isWeb],
  );

  const { copyTasks } = useTaskClipboard();

  useRegisterSelectionActions({
    copy: () => void copyTasks(visible.filter((task) => selection.has(task.id))),
    duplicate: () => onBulkDuplicate([...selection.selected]),
    cut: () => {
      const chosen = visible.filter((task) => selection.has(task.id));
      void copyTasks(chosen);
      onBulkDelete(chosen.map((task) => task.id));
    },
  });

  // Inside the list's capped content, so it centres under the header controls, not the whole pane.
  const emptyView = (
    <EmptyState
      icon={emptyIcon ?? Inbox}
      title={emptyLabel ?? t("common.nothingHere")}
      description={emptyHint}
    />
  );

  const planDayLink =
    onPlanDay && !selection.mode ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("planDay.entry")}
        onPress={onPlanDay}
        className="-ml-2.5 flex-row items-center gap-1.5 rounded-md px-2.5 py-1.5 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800"
      >
        <CalendarClock size={18} className="text-accent-600 dark:text-accent-400" />
        <Text className="text-sm font-medium text-accent-600 dark:text-accent-400">
          {t("planDay.entry")}
        </Text>
      </Pressable>
    ) : undefined;

  // A blank row is dropped by the draft effect below; a locked task's "" title is a placeholder, so nothing is written.
  // The row handlers below are stable (`useStableCallback`): `TaskRow` is memoised, and a handler
  // that changed with `visible` or a caller's inline prop would re-render every row on any change.
  const handleSaveRename = useStableCallback((task: Task, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!task.locked && trimmed && task.title !== trimmed && onUpdateTask) {
      onUpdateTask(task, { title: trimmed });
    }
    setEditingTaskId((curr) => (curr === task.id ? null : curr));
  });

  const handleCancelRename = useCallback((task?: Task) => {
    setEditingTaskId((curr) => (task ? (curr === task.id ? null : curr) : null));
  }, []);

  const handleCreateTaskBelow = useStableCallback((currentTask: Task, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (currentTask.locked || (!trimmed && !currentTask.title.trim())) {
      setEditingTaskId(null);
      return;
    }

    if (trimmed && currentTask.title !== trimmed && onUpdateTask) {
      onUpdateTask(currentTask, { title: trimmed });
    }
    if (!onCreateTask) {
      setEditingTaskId(null);
      return;
    }
    const currentIndex = visible.findIndex((t) => t.id === currentTask.id);
    const nextTask =
      currentIndex !== -1 && currentIndex + 1 < visible.length
        ? visible[currentIndex + 1]
        : undefined;
    let newSortOrder: number;
    if (
      nextTask &&
      nextTask.parent_id === currentTask.parent_id &&
      nextTask.section_id === currentTask.section_id
    ) {
      newSortOrder = rankBetween(currentTask.sort_order, nextTask.sort_order);
    } else {
      newSortOrder = currentTask.sort_order + 1;
    }
    const newId = onCreateTask({
      title: "",
      project_id: currentTask.project_id,
      section_id: currentTask.section_id,
      parent_id: currentTask.parent_id,
      due_at: currentTask.due_at,
      priority: 4,
      sort_order: newSortOrder,
    });
    setEditingTaskId(newId);
  });

  // Flat + manually sorted lists are drag-reorderable. Disabled on narrow web: the library's
  // pan-gesture handler eats touch scrolling under react-native-web.
  const dragDisabled = Platform.OS === "web" && !isWide;
  const canReorder = groupBy === "none" && sortBy === "manual" && !!onReorder && !dragDisabled;

  const sectionListData = useMemo(
    () => shownFlat.map(({ rows, ...s }) => ({ ...s, data: rows.map((r) => r.task) })),
    [shownFlat],
  );

  const scrollRaf = useRef<number | null>(null);

  const scrollToTask = useCallback(
    (taskId: string) => {
      if (Platform.OS === "web") return;
      if (scrollRaf.current !== null) {
        cancelAnimationFrame(scrollRaf.current);
      }
      scrollRaf.current = requestAnimationFrame(() => {
        if (canReorder) {
          const idx = visible.findIndex((t) => t.id === taskId);
          if (idx >= 0) {
            try {
              reorderableListRef.current?.scrollToIndex?.({
                index: idx,
                viewPosition: 0.35,
                animated: true,
              });
            } catch {
              const offset = Math.max(0, idx * 56);
              reorderableListRef.current?.scrollToOffset?.({ offset, animated: true });
            }
          }
        } else {
          for (let sIdx = 0; sIdx < sectionListData.length; sIdx++) {
            const itemIdx = sectionListData[sIdx]?.data?.findIndex((t) => t.id === taskId) ?? -1;
            if (itemIdx >= 0) {
              try {
                sectionListRef.current?.scrollToLocation?.({
                  sectionIndex: sIdx,
                  itemIndex: itemIdx,
                  viewPosition: 0.35,
                  animated: true,
                });
              } catch {
                let countBefore = 0;
                for (let prevS = 0; prevS < sIdx; prevS++) {
                  countBefore += (sectionListData[prevS]?.data?.length ?? 0) + 1;
                }
                const offset = Math.max(0, (countBefore + itemIdx) * 56);
                try {
                  sectionListRef.current
                    ?.getScrollResponder()
                    ?.scrollTo?.({ y: offset, animated: true });
                } catch {}
              }
              break;
            }
          }
        }
      });
    },
    [canReorder, visible, sectionListData],
  );

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      const offset = Math.max(0, info.index * (info.averageItemLength || 56));
      reorderableListRef.current?.scrollToOffset?.({ offset, animated: true });
      setTimeout(() => {
        try {
          reorderableListRef.current?.scrollToIndex?.({
            index: info.index,
            viewPosition: 0.35,
            animated: true,
          });
        } catch {}
      }, 100);
    },
    [],
  );

  const handleSectionScrollFailed = useCallback(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      const offset = Math.max(0, info.index * (info.averageItemLength || 56));
      try {
        sectionListRef.current?.getScrollResponder()?.scrollTo?.({ y: offset, animated: true });
      } catch {}
    },
    [],
  );

  const handleStartRename = useStableCallback((targetTask: Task) => {
    if (targetTask.locked) return;
    setEditingTaskId(targetTask.id);
    requestAnimationFrame(() => {
      scrollToTask(targetTask.id);
    });
  });

  useEffect(() => {
    if (editingTaskId && Platform.OS !== "web") {
      const timer = setTimeout(() => {
        scrollToTask(editingTaskId);
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [editingTaskId, scrollToTask]);

  // Drops a row left blank when its edit ends (the draft Enter made). Reads the latest tasks via a
  // ref so a title saved in the same update counts.
  const draftCheck = useRef({ tasks, allTasks, onDiscardTask });
  draftCheck.current = { tasks, allTasks, onDiscardTask };
  useEffect(() => {
    if (!editingTaskId) return;
    return () => {
      const latest = draftCheck.current;
      const left =
        latest.tasks.find((t) => t.id === editingTaskId) ??
        latest.allTasks?.find((t) => t.id === editingTaskId);
      if (left && !left.locked && !left.title.trim()) latest.onDiscardTask?.(left.id);
    };
  }, [editingTaskId]);

  // Nesting maths runs over the full set: ranking after the last visible child can collide with a hidden sibling's rank.
  const nestingSet = allTasks ?? tasks;

  const reparentOnto = (draggedId: string, target: Task) => {
    if (!onReparent || draggedId === target.id) return;
    onReparent(draggedId, target.id, rankAfterChildren(nestingSet, target.id));
  };

  const rerankSiblings = (movedId: string, writes: RankWrite[]) => {
    for (const w of writes) if (w.id !== movedId) onReorder?.(w.id, w.sort_order);
  };

  const indentTask = (task: Task, contextTasks: Task[] = nestingSet) => {
    const target = indentTarget(contextTasks, task.id, nestingSet);
    if (target && onReparent) onReparent(task.id, target.parent_id, target.sort_order);
  };
  const outdentTask = (task: Task, contextTasks: Task[] = nestingSet) => {
    const target = outdentTarget(contextTasks, task.id);
    if (target && onReparent) {
      onReparent(task.id, target.parent_id, target.sort_order);
      rerankSiblings(task.id, target.writes);
    }
  };

  const menuSiblings = menu?.siblings ?? (groupBy === "none" ? visible : tasks);

  const toggleRow = useStableCallback((task: Task) => onToggle(task));
  const openRow = useStableCallback((task: Task) => onOpen?.(task));
  // Swallows the trailing click of a web click-drag paint so it is not toggled back.
  const selectRow = useStableCallback((task: Task) => {
    if (!selection.paintConsumeClick(task.id)) selection.toggle(task.id);
  });
  const scheduleRow = useCallback((task: Task) => setRescheduling(task), []);
  const deleteRow = useStableCallback((task: Task) => onBulkDelete([task.id]));
  const notePressPos = useCallback((pos: MenuPos) => {
    pressPos.current = pos;
  }, []);

  // Indent/Outdent and the menu work within the row's group, and under `label` grouping one task
  // sits in several. So their handlers are made once per group key and look the group's rows up
  // when called, keeping each row's handlers the same across renders.
  const groupTasks = useStableCallback((key: string): Task[] =>
    key === FLAT_GROUP ? visible : (sectionListData.find((s) => s.key === key)?.data ?? tasks),
  );
  const indentRow = useStableCallback(indentTask);
  const outdentRow = useStableCallback(outdentTask);
  const [groupHandlers] = useState(() => new Map<string, GroupRowHandlers>());
  const handlersFor = (key: string): GroupRowHandlers => {
    let handlers = groupHandlers.get(key);
    if (!handlers) {
      handlers = {
        indent: (task) => indentRow(task, groupTasks(key)),
        outdent: (task) => outdentRow(task, groupTasks(key)),
        contextMenu: (task, pos) => setMenu({ task, pos, siblings: groupTasks(key) }),
      };
      groupHandlers.set(key, handlers);
    }
    return handlers;
  };

  // `startDrag` is present only inside a reorderable list, where long-press lifts the row. Without
  // it, native long-press opens the menu; web uses right-click.
  const rowFor = (
    item: Task,
    meta: ListTaskRow | undefined,
    startDrag: (() => void) | undefined,
    groupKey: string,
    activeTasks: Task[],
  ) => {
    const handlers = handlersFor(groupKey);
    const hasChildren = meta?.hasChildren ?? false;
    const childTotal = (meta?.childCount ?? 0) + (meta?.completedChildCount ?? 0);
    const lift = item.locked ? undefined : startDrag;
    const row = (
      <TaskRow
        ref={editingTaskId === item.id ? editingRowRef : null}
        task={item}
        now={now}
        onToggle={toggleRow}
        onOpen={onOpen ? openRow : undefined}
        isEditing={editingTaskId === item.id}
        onStartRename={handleStartRename}
        onSaveRename={handleSaveRename}
        onSubmitRenameAndAddBelow={handleCreateTaskBelow}
        onCancelRename={handleCancelRename}
        formatDue={formatDue}
        hasReminder={reminderTaskIds.has(item.id)}
        depth={meta?.depth ?? 0}
        indentGutter={hasSubtasks}
        showCompletedAt={groupBy === "completed"}
        // Counts every direct subtask, including completed ones kept off screen.
        subtaskProgress={
          childTotal > 0 ? { done: meta!.completedChildCount, total: childTotal } : undefined
        }
        expanded={!collapsedTasks.has(item.id)}
        onToggleExpand={hasChildren ? toggleTaskExpand : undefined}
        selectMode={selection.mode}
        selected={selection.has(item.id)}
        onSelect={selectRow}
        onSchedule={onReschedule ? scheduleRow : undefined}
        onDelete={deleteRow}
        onIndent={onReparent ? handlers.indent : undefined}
        onOutdent={onReparent ? handlers.outdent : undefined}
        canIndent={onReparent ? indentTarget(activeTasks, item.id, nestingSet) !== null : false}
        canOutdent={onReparent ? outdentTarget(activeTasks, item.id) !== null : false}
        origin={originOf(item)}
        assignee={assigneeOf(item)}
        labelOf={labelOf}
        onContextMenu={handlers.contextMenu}
        // The library's lift is stable per cell and ignores the task argument.
        onLongPress={lift}
        // Derived from this row's own drag: a prop gating a native-only affordance must not use a web-only condition.
        enableLongPressMenu={!lift}
        onPressIn={notePressPos}
        focused={item.id === cursorId || item.id === menu?.task.id}
        swipeRightAction={swipeRightAction}
        swipeLeftAction={swipeLeftAction}
      />
    );
    if (item.locked) return row;
    return (
      <DraggableTaskRow task={item} onReparentDrop={reparentOnto}>
        {row}
      </DraggableTaskRow>
    );
  };

  const applyDrag = (from: number, to: number) => {
    if (onReparent) {
      // A plain reorder reparents by drop position: the row takes the level of the row above it.
      const move = resolveIndentTarget(visibleRows, from, to);
      if (move) {
        onReparent(move.id, move.parent_id, move.sort_order);
        rerankSiblings(move.id, move.writes);
      }
    } else {
      const move = reorderRank(visible, from, to);
      if (move) for (const w of move.writes) onReorder!(w.id, w.sort_order);
    }
  };

  // `handled` lets a tap register while the keyboard is up instead of only dismissing it.
  const keyboardListProps = {
    keyboardShouldPersistTaps: "handled",
  } as const;

  return (
    <View className="flex-1 bg-white dark:bg-zinc-950" {...outsidePress}>
      {/* Top controls bar: the visible Select button (replacing the old hover-only checkbox) and the
          group/sort menu, grouped as one cluster. In select mode the Select button gives way to the
          bottom SelectionToolbar's Clear/Exit. Today's "Plan day" review sits at the left edge, and
          keeps the bar (and the entry) up even for an empty list. */}
      {showToolbar &&
        (onChangeListPref || planDayLink || (visible.length > 0 && !selection.mode)) && (
          <View style={contentWidth}>
            <ListToolbar
              canSelect={visible.length > 0 && !selection.mode}
              listPref={listPref}
              onChangeListPref={onChangeListPref}
              leading={planDayLink}
            />
          </View>
        )}
      {canReorder ? (
        <ReorderableList
          ref={reorderableListRef}
          data={visible}
          keyExtractor={(task, i) => task?.id ?? String(i)}
          onReorder={({ from, to }) => applyDrag(from, to)}
          ListHeaderComponent={header}
          ListEmptyComponent={emptyView}
          panGesture={dragPan}
          dragEnabled={!selection.mode}
          // Must be a worklet: the library calls this on the UI thread, and a plain JS function threw
          // there, leaving the row stuck lifted.
          onDragEnd={({ from, to }) => {
            "worklet";
            scheduleOnRN(onDragRelease, from, to);
          }}
          // Entering-only: the reorderable list owns the drag transform (see AnimatedRow). Only
          // reachable when `groupBy === "none"`, so `visible` is index-aligned with `visibleRows`.
          renderItem={({ item, index }) => (
            <AnimatedRow layout={false} exit={false}>
              <DragToReorder enabled={!selection.mode}>
                {(startDrag) => rowFor(item, visibleRows[index], startDrag, FLAT_GROUP, visible)}
              </DragToReorder>
            </AnimatedRow>
          )}
          contentContainerStyle={[contentWidth, { paddingBottom: dynamicBottomPadding }]}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          style={{ flex: 1 }}
          {...keyboardListProps}
        />
      ) : (
        <SectionList
          ref={sectionListRef}
          sections={sectionListData}
          keyExtractor={(task, i) => task?.id ?? String(i)}
          ListHeaderComponent={header}
          stickySectionHeadersEnabled={false}
          {...keyboardListProps}
          renderSectionHeader={({ section }) => {
            if (section.title === "") return null;
            const s = section as Section;
            const isCollapsed = collapsed.has(s.key);
            // Shows the real size while folded; counted over matched tasks so context parents are not counted or rescheduled.
            const groupTasksData = sections.find((g) => g.key === s.key)?.matched ?? [];
            const label = `${s.title} (${groupTasksData.length})`;
            const showReschedule = s.danger && onRescheduleOverdue && groupTasksData.length > 0;
            const chevronClass = s.danger ? "text-red-500" : "text-neutral-500";
            return (
              <View className="flex-row items-center justify-between px-4 pb-1 pt-4">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !isCollapsed }}
                  accessibilityLabel={label}
                  onPress={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.key)) next.delete(s.key);
                      else next.add(s.key);
                      return next;
                    })
                  }
                  className="flex-1 flex-row items-center gap-1.5"
                >
                  {isCollapsed ? (
                    <ChevronRight size={14} className={chevronClass} />
                  ) : (
                    <ChevronDown size={14} className={chevronClass} />
                  )}
                  <Text
                    className={
                      "text-xs font-medium uppercase " +
                      (s.danger ? "text-red-500" : "text-neutral-500")
                    }
                  >
                    {label}
                  </Text>
                </Pressable>
                {showReschedule && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("workspace.rescheduleAllToday")}
                    onPress={() => onRescheduleOverdue(groupTasksData)}
                    className="rounded px-2 py-0.5 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800"
                  >
                    <Text className="text-xs font-medium text-accent-600 dark:text-accent-400">
                      {t("workspace.rescheduleAllToday")}
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          }}
          // Entering-only: on return from the detail screen every row re-measures and a `layout`
          // animation would slide the whole list. `index` is section-relative, so meta resolves
          // exactly under `label` grouping.
          renderItem={({ item, index, section }) => (
            <AnimatedRow layout={false} exit={false}>
              {rowFor(
                item,
                rowsByKey.get((section as Section).key)?.[index],
                undefined,
                (section as Section).key,
                (section as Section).data,
              )}
            </AnimatedRow>
          )}
          contentContainerStyle={[contentWidth, { paddingBottom: dynamicBottomPadding }]}
          onScrollToIndexFailed={handleSectionScrollFailed}
          ListEmptyComponent={emptyView}
        />
      )}

      {/* Show while in select mode, not only when something is selected: deselecting the last row
          leaves you in select mode, so the bar (with its exit) must stay reachable. */}
      {selection.mode && (
        <SelectionToolbar
          count={selection.count}
          now={now}
          timeZone={timeZone}
          onSelectAll={() => selection.selectAll()}
          // Bulk actions keep the selection so several can run in a row; completed/deleted rows fall out via the prune.
          allCompleted={allSelectedCompleted()}
          onComplete={toggleSelected}
          onSetPriority={(p) => onBulkSetPriority(ids(), p)}
          onSetDue={(dueAt) => onBulkSetDue(ids(), dueAt)}
          onCopy={() => void copyTasks(selectedTasks())}
          onDuplicate={() => onBulkDuplicate(ids())}
          onMove={() => setMoving(ids())}
          onLabel={() => setLabeling(ids())}
          onDelete={() => onBulkDelete(ids())}
          onClear={() => selection.clear()}
        />
      )}

      <QuickRescheduleSheet
        title={rescheduling ? displayTitle(rescheduling, t) : null}
        now={now}
        timeZone={timeZone}
        onPick={(dueAt) => {
          if (rescheduling) onReschedule?.(rescheduling, dueAt);
          setRescheduling(null);
        }}
        onClose={() => setRescheduling(null)}
      />

      <MoveToPicker
        title={moving ? t("selection.count", { count: moving.length }) : null}
        projects={projects}
        sections={allSections.sections}
        onPick={(target) => {
          if (moving) onBulkMove(moving, target);
          setMoving(null);
        }}
        onClose={() => setMoving(null)}
      />

      <BulkLabelSheet
        title={labeling ? t("selection.count", { count: labeling.length }) : null}
        tasks={labeling ? visible.filter((task) => labeling.includes(task.id)) : []}
        onApply={(change) => {
          if (labeling) onBulkSetLabels(labeling, change);
        }}
        onClear={() => {
          if (labeling) onBulkClearLabels(labeling);
        }}
        onClose={() => setLabeling(null)}
      />

      {menu && (
        <TaskContextMenu
          task={menu.task}
          x={menu.pos.x}
          y={menu.pos.y}
          now={now}
          timeZone={timeZone}
          onClose={() => setMenu(null)}
          onToggle={onToggle}
          onSkip={onSkipTask}
          onSetPriority={(task, p) => onBulkSetPriority([task.id], p)}
          onSetDue={(task, dueAt) =>
            onReschedule ? onReschedule(task, dueAt) : onBulkSetDue([task.id], dueAt)
          }
          onCopy={(task) => void copyTasks([task])}
          onDuplicate={(task) => onBulkDuplicate([task.id])}
          onDelete={(task) => onBulkDelete([task.id])}
          onSelect={(task) => selection.beginWith(task.id)}
          onIndent={onReparent ? (task) => indentTask(task, menuSiblings) : undefined}
          onOutdent={onReparent ? (task) => outdentTask(task, menuSiblings) : undefined}
          canIndent={indentTarget(menuSiblings, menu.task.id, nestingSet) !== null}
          canOutdent={outdentTarget(menuSiblings, menu.task.id) !== null}
          bulk={
            menuOnSelection
              ? {
                  tasks: selectedTasks(),
                  onToggle: toggleSelected,
                  onSetPriority: (p) => onBulkSetPriority(ids(), p),
                  onSetDue: (dueAt) => onBulkSetDue(ids(), dueAt),
                  onCopy: () => void copyTasks(selectedTasks()),
                  onDuplicate: () => onBulkDuplicate(ids()),
                  onDelete: () => onBulkDelete(ids()),
                  onMove: () => setMoving(ids()),
                  onLabels: () => setLabeling(ids()),
                }
              : undefined
          }
        />
      )}

      {(!isWeb || isPhone) && onCreateTask && !selection.mode && !editingTaskId && (
        <FloatingAddButton onPress={() => setFabOpen(true)} />
      )}

      {(!isWeb || isPhone) && onCreateTask && (
        <KeyboardPinnedTaskAdd
          visible={fabOpen}
          onClose={() => setFabOpen(false)}
          onAdd={onCreateTask}
          defaults={quickAddDefaults}
          resolveLabels={resolveLabels}
          resolveProject={resolveProject}
          smartDates={smartDates}
          projects={projects}
          sections={allSections.sections}
          labels={labels}
          onCreateProject={createProject}
          onCreateLabel={createLabel}
          now={now}
          timeZone={timeZone}
          formatDue={formatDue}
        />
      )}

      {Platform.OS !== "web" && editingTask && (
        <KeyboardPinnedRenameBar
          task={editingTask}
          onOpenDescription={() => {
            // Commit the rename first so the draft is not lost.
            const finalTitle = editingRowRef.current?.commitRename() ?? editingTask.title;
            Keyboard.dismiss();
            onOpen?.({ ...editingTask, title: finalTitle });
          }}
          onOpenDue={() => {
            Keyboard.dismiss();
            setRescheduling(editingTask);
          }}
          onCyclePriority={() => {
            const cur = editingTask.priority ?? 4;
            const nextPriority: Priority = cur === 1 ? 2 : cur === 2 ? 3 : cur === 3 ? 4 : 1;
            onUpdateTask?.(editingTask, { priority: nextPriority });
          }}
          onOpenMove={() => {
            Keyboard.dismiss();
            setMoving([editingTask.id]);
          }}
          onDone={() => {
            Keyboard.dismiss();
            // Without the commit the dismiss-blur races the row unmount and the rename is lost.
            editingRowRef.current?.commitRename();
          }}
        />
      )}
    </View>
  );
}
