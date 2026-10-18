import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Keyboard, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import ReorderableList, { type ReorderableListReorderEvent } from "react-native-reorderable-list";
import { scheduleOnRN } from "react-native-worklets";
import type { CreateTaskInput, Priority, Section, Task } from "@atlastodo/client-core";
import {
  flattenTree,
  indentTarget,
  outdentTarget,
  rankAfterChildren,
  rankBetween,
  reorderRank,
  resolveIndentTarget,
  sortTasks,
  wouldCycle,
  type FlatTaskRow,
  type RankWrite,
} from "@atlastodo/shared";
import { useSelection } from "../data/SelectionProvider";
import { useSelectionSource } from "../hooks/useSelectionSource";
import { useOutsidePressExit } from "../hooks/useOutsidePressExit";
import { useRegisterSelectionActions } from "../data/SelectionActionsProvider";
import { useCursorList } from "../data/CursorProvider";
import { useReminderTaskIds } from "../hooks/useReminders";
import { useIsWide } from "../hooks/useIsWide";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { useDragPan } from "../hooks/useDragPan";
import { useLabels } from "../hooks/useLabels";
import { useProjects } from "../hooks/useProjects";
import { useAllSections } from "../hooks/useAllSections";
import { usePreferences } from "../hooks/usePreferences";
import { useStableCallback } from "../hooks/useStableCallback";
import { LIST_WIDTH_STYLE } from "./listWidth";
import type { MenuPos } from "../hooks/useContextMenu";
import { resolveSectionReorder, type SectionRow } from "../lib/sectionReorder";
import { dragReleaseAction } from "../lib/dragRelease";
import { haptics } from "../lib/haptics";
import { useTaskClipboard } from "../hooks/useTaskClipboard";
import { TaskRow, type TaskRowHandle } from "./TaskRow";
import { DraggableTaskRow } from "./DraggableTaskRow";
import { DragToReorder } from "./DragToReorder";
import { AnimatedRow } from "./AnimatedRow";
import { TaskContextMenu } from "./TaskContextMenu";
import { NoSectionHeaderRow, SectionHeaderRow } from "./ProjectListSection";
import { QuickAdd } from "./QuickAdd";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { SelectionToolbar } from "./SelectionToolbar";
import { BulkLabelSheet } from "./BulkLabelSheet";
import { MoveToPicker } from "./MoveToPicker";
import { QuickRescheduleSheet } from "./QuickRescheduleSheet";
import { FloatingAddButton } from "./FloatingAddButton";
import { KeyboardPinnedTaskAdd } from "./KeyboardPinnedTaskAdd";
import { KeyboardPinnedRenameBar } from "./KeyboardPinnedRenameBar";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CopyPlus,
  FolderInput,
  Inbox,
  ListChecks,
  Pencil,
  Plus,
  Trash2,
} from "./icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * A project's tasks as a manually reorderable list, grouped under collapsible section headers when
 * the project has sections.
 *
 * Drag is a long-press on the whole row (`useReorderableDrag`); the new position becomes a
 * fractional `sort_order` via `reorderRank`. Releasing without moving opens the action menu on
 * native (`lib/dragMenu`).
 *
 * RN can't drag between separate lists, so a project with sections renders one flat reorderable
 * list of interleaved header / task / add-task rows. Dragging a task past a header moves it into
 * that section: `lib/sectionReorder` turns the `{from,to}` move into a `{section_id, sort_order}`
 * patch. Drag is per item, so a header can never be lifted. A project with no sections keeps the
 * plain flat list.
 */

export interface ProjectTaskListProps {
  /** The project these tasks belong to (excluded as a "move to" target). */
  projectId: string;
  tasks: Task[];
  now: number;
  timeZone?: string;
  onToggle: (task: Task) => void;
  /** Reschedule one task; falls back to the bulk path. */
  onReschedule?: (task: Task, dueAt: number | null) => void;
  onSkipTask?: (task: Task) => void;
  onOpen?: (task: Task) => void;
  /** Persist a reordered task's new sort_order. */
  onReorder: (taskId: string, sortOrder: number) => void;
  /** Persist a subtask reparent. On a flat project a drag routes through the tree resolver. */
  onReparent?: (id: string, parentId: string | null, sortOrder: number) => void;
  /** Move a task to another section (new section_id + sort_order, + parent_id when the drop nests/un-nests it). */
  onMoveToSection: (
    task: Task,
    patch: { section_id: string | null; sort_order: number; parent_id?: string | null },
  ) => void;
  formatDue?: (ms: number) => string;
  /** The project's sections (its columns); when non-empty the list groups under section headers. */
  sections?: Section[];
  /** Bulk actions across the selection (from the view). */
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
  /** Create a new section named `name`. */
  onAddSection: (name: string) => void;
  /** Rename a section. */
  onRenameSection: (id: string, name: string) => void;
  /** Deep-duplicate a section (with an undo toast, owned by the caller). */
  onDuplicateSection: (id: string) => void;
  /** Soft-delete a section (with an undo toast, owned by the caller). */
  onDeleteSection: (id: string) => void;
  /** Archive a section (hide without deleting; with an undo toast, owned by the caller). */
  onArchiveSection: (id: string) => void;
  /** Move a whole section (and its tasks) to another project (with an undo toast). */
  onMoveSection: (id: string, targetProjectId: string) => void;
  /** Reorder a section one step up or down among its siblings. */
  onReorderSection: (id: string, direction: "up" | "down") => void;
  /** Enter select mode with all of a section's tasks selected. */
  onSelectSectionTasks: (cards: Task[]) => void;
  /** Add a task to a section (or the no-section group when `sectionId` is null), ranked at the end. */
  onAddTask: (sectionId: string | null, title: string) => void;
  /** Rendered above the list (the project header + quick-add). */
  header?: React.ReactElement;
  /** Completed tasks for the optional Done section at the bottom, newest completion first. */
  doneTasks?: Task[];
  /**
   * Whether "show completed" is on. The footer renders whenever set, even with no completed tasks:
   * `doneTasks` alone cannot tell "off" from "on with none".
   */
  showDone?: boolean;
  /** Update task fields (e.g. title after inline rename). */
  onUpdateTask?: (task: Task, patch: Partial<Task>) => void;
  /** Create a new task (used for Enter-to-create-below and FAB quick-add). */
  onCreateTask?: (input: CreateTaskInput) => string;
  /** Discard a task by id (e.g. newly created empty task cancelled or blurred with no title). */
  onDiscardTask?: (id: string) => void;
  quickAddDefaults?: Partial<CreateTaskInput>;
  resolveLabels?: (names: string[]) => string[];
  resolveProject?: (name: string) => string | null;
  smartDates?: boolean;
}

const isWeb = Platform.OS === "web";

/** A row of the flattened sectioned list: a header, a task, an add-task input, or the no-section head. */
type Row =
  | { kind: "none-header"; key: string; count: number }
  | { kind: "header"; key: string; sectionId: string; name: string; count: number }
  | { kind: "task"; key: string; sectionId: string | null; task: Task; meta: FlatTaskRow }
  | { kind: "add"; key: string; sectionId: string | null; name: string };

export function ProjectTaskList({
  projectId,
  tasks,
  now,
  timeZone,
  onToggle,
  onReschedule,
  onSkipTask,
  onOpen,
  onReorder,
  onReparent,
  onMoveToSection,
  formatDue,
  sections = [],
  onBulkSetPriority,
  onBulkSetDue,
  onBulkSetLabels,
  onBulkClearLabels,
  onBulkDuplicate,
  onBulkDelete,
  onBulkComplete,
  onBulkMove,
  onAddSection,
  onRenameSection,
  onDuplicateSection,
  onDeleteSection,
  onArchiveSection,
  onMoveSection,
  onReorderSection,
  onSelectSectionTasks,
  onAddTask,
  header,
  doneTasks,
  showDone,
  onUpdateTask,
  onCreateTask,
  onDiscardTask,
  quickAddDefaults,
  resolveLabels,
  resolveProject,
  smartDates = true,
}: ProjectTaskListProps) {
  const { t } = useTranslation();
  const selection = useSelection();
  const { copyTasks } = useTaskClipboard();
  const { labels, createLabel } = useLabels();
  const { projects, createProject } = useProjects();
  const allSections = useAllSections();
  const { swipeRightAction, swipeLeftAction } = usePreferences();

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const editingTask = editingTaskId ? tasks.find((t) => t.id === editingTaskId) : null;
  // Clearing `editingTaskId` alone unmounts the input before its blur can save, so the keyboard
  // toolbar commits the draft explicitly.
  const editingRowRef = useRef<TaskRowHandle | null>(null);
  const [fabOpen, setFabOpen] = useState(false);
  const [addSectionTarget, setAddSectionTarget] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<Task | null>(null);

  const rowListRef = useRef<FlatList<Row>>(null);
  const taskListRef = useRef<FlatList<Task>>(null);
  const keyboardHeight = useKeyboardHeight();

  // Small/touch web renders a plain FlatList: the reorder library's pan-gesture handler eats touch scrolling.
  const isWide = useIsWide();
  // The phone shell, native or web: bottom nav plus the add button (see `(drawer)/_layout`).
  const isPhone = !isWide;
  const dynamicBottomPadding =
    editingTaskId !== null
      ? Math.max(keyboardHeight, 300) + 80
      : keyboardHeight > 0
        ? keyboardHeight + 80
        : isPhone
          ? 88
          : 16;
  const dragDisabled = Platform.OS === "web" && !isWide;
  const pressPos = useRef<MenuPos>({ x: 0, y: 0 });
  // `handled` keeps taps on the quick-add header working while the keyboard is up.
  const keyboardListProps = {
    keyboardShouldPersistTaps: "handled",
  } as const;
  const ordered = useMemo(() => sortTasks(tasks, "manual"), [tasks]);

  // The row handlers are stable (`useStableCallback`): `TaskRow` is memoised, and a handler that
  // changed with the task list or a caller's inline prop would re-render every row on any change.
  // A blank row is dropped by the draft effect below; a locked task's "" title is a placeholder, so nothing is written.
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

  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(() => new Set());
  const toggleTaskExpand = useCallback(
    (task: Task) =>
      setCollapsedTasks((prev) => {
        const next = new Set(prev);
        if (next.has(task.id)) next.delete(task.id);
        else next.add(task.id);
        return next;
      }),
    [],
  );
  const orderedRows = useMemo(
    () => flattenTree(ordered, collapsedTasks),
    [ordered, collapsedTasks],
  );
  const orderedFlat = useMemo(() => orderedRows.map((r) => r.task), [orderedRows]);

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
    const currentIndex = orderedFlat.findIndex((t) => t.id === currentTask.id);
    const nextTask =
      currentIndex !== -1 && currentIndex + 1 < orderedFlat.length
        ? orderedFlat[currentIndex + 1]
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

  const rowMeta = useMemo(() => {
    const m = new Map<string, FlatTaskRow>();
    for (const r of orderedRows) m.set(r.task.id, r);
    return m;
  }, [orderedRows]);
  const projectHasSubtasks = useMemo(
    () => tasks.some((t) => t.parent_id !== null && tasks.some((p) => p.id === t.parent_id)),
    [tasks],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapsed = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [newSection, setNewSection] = useState("");
  const submitSection = () => {
    const name = newSection.trim();
    if (!name) return;
    onAddSection(name);
    setNewSection("");
  };
  const escapeSection = useCancelOnEscape(() => setNewSection(""));

  // `siblings` is the row's section, so the menu's Indent/Outdent match the swipe.
  const [menu, setMenu] = useState<{ task: Task; pos: MenuPos; siblings?: Task[] } | null>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  // Rendered at the list root: an RN absolute overlay is relative to its parent.
  const [sectionMenu, setSectionMenu] = useState<{ sectionId: string; pos: MenuPos } | null>(null);
  const [moving, setMoving] = useState<
    { kind: "tasks"; ids: string[] } | { kind: "section"; sectionId: string } | null
  >(null);
  const [labeling, setLabeling] = useState<string[] | null>(null);

  // Every section is shown even when empty, so it can be collapsed and receive dragged-in tasks.
  const { none, bySection } = useMemo(() => {
    const known = new Set(sections.map((s) => s.id));
    const map = new Map<string, Task[]>();
    for (const s of sections) map.set(s.id, []);
    const noneTasks: Task[] = [];
    for (const task of tasks) {
      if (task.section_id && known.has(task.section_id)) map.get(task.section_id)!.push(task);
      else noneTasks.push(task);
    }
    return { none: sortTasks(noneTasks, "manual"), bySection: map };
  }, [tasks, sections]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const s of sections) {
      const cards = sortTasks(bySection.get(s.id) ?? [], "manual");
      out.push({
        kind: "header",
        key: `header:${s.id}`,
        sectionId: s.id,
        name: s.name,
        count: cards.length,
      });
      if (!collapsed.has(s.id)) {
        for (const meta of flattenTree(cards, collapsedTasks))
          out.push({
            kind: "task",
            key: `task:${meta.task.id}`,
            sectionId: s.id,
            task: meta.task,
            meta,
          });
        out.push({ kind: "add", key: `add:${s.id}`, sectionId: s.id, name: s.name });
      }
    }
    out.push({ kind: "none-header", key: "none-header", count: none.length });
    for (const meta of flattenTree(none, collapsedTasks))
      out.push({
        kind: "task",
        key: `task:${meta.task.id}`,
        sectionId: null,
        task: meta.task,
        meta,
      });
    out.push({ kind: "add", key: "add:none", sectionId: null, name: t("board.noSection") });
    return out;
  }, [none, sections, bySection, collapsed, collapsedTasks, t]);

  const visible = useMemo(
    () =>
      sections.length === 0
        ? orderedFlat
        : rows.flatMap((r) => (r.kind === "task" ? [r.task] : [])),
    [sections.length, orderedFlat, rows],
  );
  // Prune against every task in the project: collapsing a section or a sync frame must not deselect its rows.
  useSelectionSource(visible, tasks);
  const outsidePress = useOutsidePressExit();

  const reminderTaskIds = useReminderTaskIds();

  const cursorId = useCursorList({
    getTasks: () => visible,
    open: (task) => onOpen?.(task),
    toggle: (task) => onToggle(task),
    reschedule: (task) => setRescheduling(task),
    remove: (task) => onBulkDelete([task.id]),
  });

  const scrollRaf = useRef<number | null>(null);

  const scrollToTask = useCallback(
    (taskId: string) => {
      if (Platform.OS === "web") return;
      if (scrollRaf.current !== null) {
        cancelAnimationFrame(scrollRaf.current);
      }
      scrollRaf.current = requestAnimationFrame(() => {
        if (sections.length > 0) {
          const idx = rows.findIndex((r) => r.kind === "task" && r.task?.id === taskId);
          if (idx >= 0) {
            try {
              (rowListRef.current ?? taskListRef.current)?.scrollToIndex({
                index: idx,
                viewPosition: 0.35,
                animated: true,
              });
            } catch {
              const offset = Math.max(0, idx * 56);
              (rowListRef.current ?? taskListRef.current)?.scrollToOffset({
                offset,
                animated: true,
              });
            }
          }
        } else {
          const idx = orderedFlat.findIndex((t) => t.id === taskId);
          if (idx >= 0) {
            try {
              (rowListRef.current ?? taskListRef.current)?.scrollToIndex({
                index: idx,
                viewPosition: 0.35,
                animated: true,
              });
            } catch {
              const offset = Math.max(0, idx * 56);
              (rowListRef.current ?? taskListRef.current)?.scrollToOffset({
                offset,
                animated: true,
              });
            }
          }
        }
      });
    },
    [sections.length, rows, orderedFlat],
  );

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      const offset = Math.max(0, info.index * (info.averageItemLength || 56));
      (rowListRef.current ?? taskListRef.current)?.scrollToOffset({ offset, animated: true });
      setTimeout(() => {
        try {
          (rowListRef.current ?? taskListRef.current)?.scrollToIndex({
            index: info.index,
            viewPosition: 0.35,
            animated: true,
          });
        } catch {}
      }, 100);
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
  const draftCheck = useRef({ tasks, onDiscardTask });
  draftCheck.current = { tasks, onDiscardTask };
  useEffect(() => {
    if (!editingTaskId) return;
    return () => {
      const latest = draftCheck.current;
      const left = latest.tasks.find((t) => t.id === editingTaskId);
      if (left && !left.locked && !left.title.trim()) latest.onDiscardTask?.(left.id);
    };
  }, [editingTaskId]);

  const copySelected = () => copyTasks(visible.filter((task) => selection.has(task.id)));

  const dragPan = useDragPan();
  const onDragRelease = useCallback(
    (from: number, to: number) => {
      // The library persists the reorder itself; a moved release only needs the drop thud.
      if (from !== to) haptics.impact("light");
      if (dragReleaseAction({ from, to, selectMode: selection.mode, isWeb }) !== "menu") return;
      // The sectioned list indexes into `rows` (non-task indexes are ignored); the flat one into `orderedFlat`.
      let task: Task | undefined;
      if (sections.length > 0) {
        const row = rows[from];
        if (row?.kind === "task") task = row.task;
      } else {
        task = orderedFlat[from];
      }
      if (task) setMenu({ task, pos: pressPos.current });
    },
    [selection.mode, sections.length, rows, orderedFlat],
  );
  useRegisterSelectionActions({
    copy: () => void copySelected(),
    duplicate: () => onBulkDuplicate([...selection.selected]),
    cut: () => {
      const chosen = visible.filter((task) => selection.has(task.id));
      void copySelected();
      onBulkDelete(chosen.map((task) => task.id));
    },
  });

  const rerankSiblings = (movedId: string, writes: RankWrite[]) => {
    for (const w of writes) if (w.id !== movedId) onReorder(w.id, w.sort_order);
  };

  // Flat reorder: reparent by drop position (the moved row takes the level of the row above it).
  const handleFlatReorder = ({ from, to }: ReorderableListReorderEvent) => {
    if (onReparent) {
      const move = resolveIndentTarget(orderedRows, from, to);
      if (move) {
        onReparent(move.id, move.parent_id, move.sort_order);
        rerankSiblings(move.id, move.writes);
      }
    } else {
      const move = reorderRank(orderedFlat, from, to);
      if (move) for (const w of move.writes) onReorder(w.id, w.sort_order);
    }
  };

  const indentTask = (task: Task, contextTasks: Task[] = tasks) => {
    const target = indentTarget(contextTasks, task.id, tasks);
    if (target && onReparent) onReparent(task.id, target.parent_id, target.sort_order);
  };
  const outdentTask = (task: Task, contextTasks: Task[] = tasks) => {
    const target = outdentTarget(contextTasks, task.id);
    if (target && onReparent) {
      onReparent(task.id, target.parent_id, target.sort_order);
      rerankSiblings(task.id, target.writes);
    }
  };

  const handleSectionAdd = useCallback(
    (sectionId: string | null, input: CreateTaskInput) => {
      const siblings = sortTasks(
        tasks.filter((tk) => (tk.section_id ?? null) === sectionId),
        "manual",
      );
      const last = siblings.at(-1);
      const sortOrder = rankBetween(last ? last.sort_order : null, null);
      const finalInput: CreateTaskInput = {
        project_id: projectId,
        section_id: sectionId,
        ...input,
        sort_order: input.sort_order ?? sortOrder,
      };
      if (onCreateTask) {
        return onCreateTask(finalInput);
      }
      onAddTask(sectionId, finalInput.title);
      return undefined;
    },
    [tasks, projectId, onCreateTask, onAddTask],
  );

  // Sectioned reorder: resolve the drop's new section + parent + rank. Parent is by position.
  const parentInProject = (task: Task): string | null =>
    task.parent_id !== null && tasks.some((p) => p.id === task.parent_id) ? task.parent_id : null;
  const handleSectionReorder = ({ from, to }: ReorderableListReorderEvent) => {
    const model: SectionRow[] = rows.map((r) =>
      r.kind === "task"
        ? {
            kind: "task",
            sectionId: r.sectionId,
            id: r.task.id,
            sortOrder: r.task.sort_order,
            depth: r.meta.depth,
            parentId: parentInProject(r.task),
          }
        : r.kind === "add"
          ? { kind: "add", sectionId: r.sectionId }
          : { kind: "header", sectionId: r.kind === "header" ? r.sectionId : null },
    );
    const drop = resolveSectionReorder(model, from, to);
    if (!drop) return;
    const moved = rows[from];
    const task = moved && moved.kind === "task" ? moved.task : undefined;
    if (!task) return;
    // Dragging a parent into its own subtree keeps it top-level.
    const parentId = wouldCycle(tasks, drop.id, drop.parent_id) ? null : drop.parent_id;
    if (drop.changedSection) {
      onMoveToSection(task, {
        section_id: drop.section_id,
        sort_order: drop.sort_order,
        parent_id: parentId,
      });
    } else if (onReparent) {
      onReparent(drop.id, parentId, drop.sort_order);
    } else {
      onReorder(drop.id, drop.sort_order);
    }
    rerankSiblings(drop.id, drop.writes);
  };

  // `startDrag` is the only difference between drag and non-drag rows; it decides the long-press
  // behaviour. Entering-only animations: reanimated layout would fight the lists' own transforms
  // (see AnimatedRow).
  const reparentOnto = (draggedId: string, target: Task) => {
    if (!onReparent || draggedId === target.id) return;
    onReparent(draggedId, target.id, rankAfterChildren(tasks, target.id));
  };

  const siblingsOf = (task: Task): Task[] =>
    sections.length > 0
      ? ((task.section_id ? bySection.get(task.section_id) : undefined) ?? none)
      : tasks;
  // A row's siblings follow from the task itself (its section), so one handler serves every row.
  const toggleRow = useStableCallback((task: Task) => onToggle(task));
  const openRow = useStableCallback((task: Task) => onOpen?.(task));
  const selectRow = useStableCallback((task: Task) => {
    if (!selection.paintConsumeClick(task.id)) selection.toggle(task.id);
  });
  const scheduleRow = useCallback((task: Task) => setRescheduling(task), []);
  const deleteRow = useStableCallback((task: Task) => onBulkDelete([task.id]));
  const indentRow = useStableCallback((task: Task) => indentTask(task, siblingsOf(task)));
  const outdentRow = useStableCallback((task: Task) => outdentTask(task, siblingsOf(task)));
  const openRowMenu = useStableCallback((task: Task, pos: MenuPos) =>
    setMenu({ task, pos, siblings: siblingsOf(task) }),
  );
  const notePressPos = useCallback((pos: MenuPos) => {
    pressPos.current = pos;
  }, []);

  const renderTask = (
    task: Task,
    meta: FlatTaskRow | undefined = rowMeta.get(task.id),
    startDrag?: () => void,
  ) => {
    const activeTasks = siblingsOf(task);
    const hasChildren = meta?.hasChildren ?? false;
    const lift = task.locked ? undefined : startDrag;
    const row = (
      <AnimatedRow layout={false} exit={false}>
        <View className="bg-white dark:bg-zinc-950">
          <TaskRow
            ref={editingTaskId === task.id ? editingRowRef : null}
            task={task}
            now={now}
            onToggle={toggleRow}
            onOpen={onOpen ? openRow : undefined}
            // The row a context menu is open for stays highlighted while the menu shows.
            focused={task.id === cursorId || task.id === menu?.task.id}
            isEditing={editingTaskId === task.id}
            onStartRename={handleStartRename}
            onSaveRename={handleSaveRename}
            onSubmitRenameAndAddBelow={handleCreateTaskBelow}
            onCancelRename={handleCancelRename}
            formatDue={formatDue}
            hasReminder={reminderTaskIds.has(task.id)}
            depth={meta?.depth ?? 0}
            indentGutter={projectHasSubtasks}
            subtaskProgress={
              hasChildren
                ? {
                    done: meta!.completedChildCount,
                    total: meta!.childCount + meta!.completedChildCount,
                  }
                : undefined
            }
            expanded={!collapsedTasks.has(task.id)}
            onToggleExpand={hasChildren ? toggleTaskExpand : undefined}
            selectMode={selection.mode}
            selected={selection.has(task.id)}
            onSelect={selectRow}
            onSchedule={scheduleRow}
            onDelete={deleteRow}
            onIndent={onReparent ? indentRow : undefined}
            onOutdent={onReparent ? outdentRow : undefined}
            canIndent={onReparent ? indentTarget(activeTasks, task.id, tasks) !== null : false}
            canOutdent={onReparent ? outdentTarget(activeTasks, task.id) !== null : false}
            onContextMenu={openRowMenu}
            // The library's lift is stable per cell and ignores the task argument.
            onLongPress={lift}
            // Derived from this row's own drag: `dragDisabled` is only true on web, where TaskRow's
            // `Platform.OS !== "web"` guard would kill the prop.
            enableLongPressMenu={!lift}
            onPressIn={notePressPos}
            swipeRightAction={swipeRightAction}
            swipeLeftAction={swipeLeftAction}
          />
        </View>
      </AnimatedRow>
    );
    if (task.locked) return row;
    return (
      <DraggableTaskRow task={task} onReparentDrop={reparentOnto}>
        {row}
      </DraggableTaskRow>
    );
  };

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "none-header":
        return <NoSectionHeaderRow count={item.count} />;
      case "header":
        return (
          <SectionHeaderRow
            name={item.name}
            count={item.count}
            collapsed={collapsed.has(item.sectionId)}
            onToggleCollapsed={() => toggleCollapsed(item.sectionId)}
            editing={editingSectionId === item.sectionId}
            onStartEdit={() => setEditingSectionId(item.sectionId)}
            onEndEdit={() => setEditingSectionId((cur) => (cur === item.sectionId ? null : cur))}
            onRename={(name) => onRenameSection(item.sectionId, name)}
            onOpenActions={(pos) => setSectionMenu({ sectionId: item.sectionId, pos })}
          />
        );
      case "task":
        // Per-item drag, so section headers stay put. Web-narrow renders a plain FlatList with no
        // reorder cell context, so rows there have no drag.
        return dragDisabled ? (
          renderTask(item.task, item.meta)
        ) : (
          <DragToReorder enabled={!selection.mode}>
            {(startDrag) => renderTask(item.task, item.meta, startDrag)}
          </DragToReorder>
        );
      case "add":
        if (Platform.OS === "web") {
          return (
            <View className="px-3 py-1 bg-white dark:bg-zinc-950">
              <QuickAdd
                accessibilityLabel={t("board.addTaskTo", { name: item.name })}
                placeholder={t("board.addTask")}
                onAdd={(input) => handleSectionAdd(item.sectionId, input)}
                defaults={{
                  ...quickAddDefaults,
                  project_id: projectId,
                  section_id: item.sectionId ?? null,
                }}
                projects={projects}
                sections={allSections.sections}
                labels={labels}
                onCreateProject={createProject}
                onCreateLabel={createLabel}
                resolveLabels={resolveLabels}
                resolveProject={resolveProject}
                smartDates={smartDates}
                now={now}
                timeZone={timeZone}
                formatDue={formatDue}
              />
            </View>
          );
        }

        return (
          <View className="px-4 py-1.5 bg-white dark:bg-zinc-950">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("board.addTaskTo", { name: item.name })}
              onPress={() => {
                setAddSectionTarget(item.sectionId);
                setFabOpen(true);
              }}
              hitSlop={6}
              className="flex-row items-center gap-2.5 rounded-xl px-2 py-2 active:bg-neutral-100 dark:active:bg-neutral-800/60"
            >
              <Plus size={18} className="text-neutral-500 dark:text-neutral-400 shrink-0" />
              <Text className="text-sm font-normal text-neutral-500 dark:text-neutral-400">
                {t("board.addTask")}
              </Text>
            </Pressable>
          </View>
        );
    }
  };

  const empty = (
    <View className="items-center gap-2 py-16">
      <Inbox size={32} className="text-neutral-500" />
      <Text className="text-sm text-neutral-500">{t("workspace.emptyTasks")}</Text>
    </View>
  );

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
  const toolbar = selection.mode ? (
    <SelectionToolbar
      count={selection.count}
      now={now}
      timeZone={timeZone}
      onSelectAll={() => selection.selectAll()}
      // Bulk actions keep the selection for a run of actions; completed/deleted rows fall out via the prune.
      allCompleted={allSelectedCompleted()}
      onComplete={toggleSelected}
      onSetPriority={(p) => onBulkSetPriority(ids(), p)}
      onSetDue={(dueAt) => onBulkSetDue(ids(), dueAt)}
      onCopy={() => void copySelected()}
      onDuplicate={() => onBulkDuplicate(ids())}
      onMove={() => setMoving({ kind: "tasks", ids: ids() })}
      onLabel={() => setLabeling(ids())}
      onDelete={() => onBulkDelete(ids())}
      onClear={() => selection.clear()}
    />
  ) : null;

  const menuSiblings = menu ? (menu.siblings ?? siblingsOf(menu.task)) : [];
  const rescheduleOne = (task: Task, dueAt: number | null) =>
    onReschedule ? onReschedule(task, dueAt) : onBulkSetDue([task.id], dueAt);
  const contextMenu = menu ? (
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
      onSetDue={rescheduleOne}
      onCopy={(task) => void copyTasks([task])}
      onDuplicate={(task) => onBulkDuplicate([task.id])}
      onDelete={(task) => onBulkDelete([task.id])}
      onSelect={(task) => selection.beginWith(task.id)}
      onIndent={onReparent ? (task) => indentTask(task, menuSiblings) : undefined}
      onOutdent={onReparent ? (task) => outdentTask(task, menuSiblings) : undefined}
      canIndent={indentTarget(menuSiblings, menu.task.id, tasks) !== null}
      canOutdent={outdentTarget(menuSiblings, menu.task.id) !== null}
      bulk={
        menuOnSelection
          ? {
              tasks: selectedTasks(),
              onToggle: toggleSelected,
              onSetPriority: (p) => onBulkSetPriority(ids(), p),
              onSetDue: (dueAt) => onBulkSetDue(ids(), dueAt),
              onCopy: () => void copySelected(),
              onDuplicate: () => onBulkDuplicate(ids()),
              onDelete: () => onBulkDelete(ids()),
              onMove: () => setMoving({ kind: "tasks", ids: ids() }),
              onLabels: () => setLabeling(ids()),
            }
          : undefined
      }
    />
  ) : null;

  const sectionMenuTarget = sectionMenu
    ? sections.find((s) => s.id === sectionMenu.sectionId)
    : null;
  const sectionActionsMenu =
    sectionMenu && sectionMenuTarget
      ? (() => {
          const sec = sectionMenuTarget;
          const cards = bySection.get(sec.id) ?? [];
          const secIndex = sections.findIndex((s) => s.id === sec.id);
          const items: ContextMenuItem[] = [
            {
              key: "rename",
              label: t("context.rename"),
              icon: Pencil,
              onPress: () => setEditingSectionId(sec.id),
            },
            ...(secIndex > 0
              ? [
                  {
                    key: "up",
                    label: t("common.moveUp"),
                    icon: ChevronUp,
                    onPress: () => onReorderSection(sec.id, "up"),
                  },
                ]
              : []),
            ...(secIndex < sections.length - 1
              ? [
                  {
                    key: "down",
                    label: t("common.moveDown"),
                    icon: ChevronDown,
                    onPress: () => onReorderSection(sec.id, "down"),
                  },
                ]
              : []),
            {
              key: "duplicate",
              label: t("common.duplicate"),
              icon: CopyPlus,
              onPress: () => onDuplicateSection(sec.id),
            },
            {
              key: "select",
              label: t("context.selectTasks"),
              icon: ListChecks,
              onPress: () => onSelectSectionTasks(cards),
            },
            {
              key: "move",
              label: t("section.moveToProject"),
              icon: FolderInput,
              onPress: () => setMoving({ kind: "section", sectionId: sec.id }),
            },
            {
              key: "archive",
              label: t("common.archive"),
              icon: Archive,
              onPress: () => onArchiveSection(sec.id),
            },
            {
              key: "delete",
              label: t("common.delete"),
              icon: Trash2,
              separatorBefore: true,
              danger: true,
              onPress: () => onDeleteSection(sec.id),
            },
          ];
          return (
            <ContextMenu items={items} pos={sectionMenu.pos} onClose={() => setSectionMenu(null)} />
          );
        })()
      : null;

  const movingSectionTitle =
    moving?.kind === "section"
      ? (sections.find((s) => s.id === moving.sectionId)?.name ?? "")
      : null;
  const moveToPicker = (
    <MoveToPicker
      title={
        moving?.kind === "tasks"
          ? t("selection.count", { count: moving.ids.length })
          : movingSectionTitle
      }
      projects={projects}
      sections={allSections.sections}
      mode={moving?.kind === "section" ? "section" : "task"}
      excludeProjectId={moving?.kind === "section" ? projectId : undefined}
      onPick={(target) => {
        if (moving?.kind === "tasks") onBulkMove(moving.ids, target);
        else if (moving?.kind === "section" && target.project_id != null)
          onMoveSection(moving.sectionId, target.project_id);
        setMoving(null);
      }}
      onClose={() => setMoving(null)}
    />
  );

  const labelingTasks = labeling ? visible.filter((task) => labeling.includes(task.id)) : [];
  const bulkLabelSheet = (
    <BulkLabelSheet
      title={labeling ? t("selection.count", { count: labeling.length }) : null}
      tasks={labelingTasks}
      onApply={(change) => {
        if (labeling) onBulkSetLabels(labeling, change);
      }}
      onClear={() => {
        if (labeling) onBulkClearLabels(labeling);
      }}
      onClose={() => setLabeling(null)}
    />
  );

  const addSectionRow = (
    <View style={LIST_WIDTH_STYLE} className="flex-row items-center gap-1 px-3 py-3">
      <Plus size={isWeb ? 16 : 18} className="text-neutral-500" />
      <TextInput
        accessibilityLabel={t("board.addSection")}
        placeholder={t("board.addSection")}
        ref={escapeSection.ref}
        value={newSection}
        onChangeText={setNewSection}
        onSubmitEditing={submitSection}
        onKeyPress={escapeSection.onKeyPress}
        returnKeyType="done"
        {...KEEP_FOCUS_SUBMIT}
        className={
          "flex-1 py-1 text-neutral-800 dark:text-neutral-100 " + (isWeb ? "text-sm" : "text-lg")
        }
      />
    </View>
  );

  // Done footer: outside the reorder data, so a completed task can't be dragged into the manual order.
  const doneFooter = showDone ? (
    <DoneSection tasks={doneTasks ?? []} sections={sections} renderTask={renderTask} />
  ) : undefined;

  const commonOverlays = (
    <>
      {addSectionRow}
      {toolbar}
      {contextMenu}
      {sectionActionsMenu}
      {moveToPicker}
      {bulkLabelSheet}
      <QuickRescheduleSheet
        title={rescheduling ? displayTitle(rescheduling, t) : null}
        now={now}
        timeZone={timeZone}
        onPick={(dueAt) => {
          if (rescheduling) rescheduleOne(rescheduling, dueAt);
          setRescheduling(null);
        }}
        onClose={() => setRescheduling(null)}
      />

      {(!isWeb || isPhone) && onCreateTask && !selection.mode && !editingTaskId && (
        <FloatingAddButton
          onPress={() => {
            setAddSectionTarget(null);
            setFabOpen(true);
          }}
        />
      )}

      {(!isWeb || isPhone) && onCreateTask && (
        <KeyboardPinnedTaskAdd
          visible={fabOpen}
          onClose={() => {
            setFabOpen(false);
            setAddSectionTarget(null);
          }}
          onAdd={(input) => handleSectionAdd(addSectionTarget, input)}
          defaults={{ ...quickAddDefaults, project_id: projectId, section_id: addSectionTarget }}
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
            setMoving({ kind: "tasks", ids: [editingTask.id] });
          }}
          onDone={() => {
            Keyboard.dismiss();
            // Without the commit the dismiss-blur races the row unmount and the rename is lost.
            editingRowRef.current?.commitRename();
          }}
        />
      )}
    </>
  );

  if (sections.length > 0) {
    return (
      <View className="flex-1" {...outsidePress}>
        {dragDisabled ? (
          <FlatList
            ref={rowListRef}
            data={rows}
            keyExtractor={(row, i) => row?.key ?? String(i)}
            ListHeaderComponent={header}
            ListFooterComponent={doneFooter}
            renderItem={renderRow}
            contentContainerStyle={[LIST_WIDTH_STYLE, { paddingBottom: dynamicBottomPadding }]}
            onScrollToIndexFailed={handleScrollToIndexFailed}
            style={{ flex: 1 }}
            {...keyboardListProps}
          />
        ) : (
          <ReorderableList
            ref={rowListRef}
            data={rows}
            keyExtractor={(row, i) => row?.key ?? String(i)}
            onReorder={handleSectionReorder}
            ListHeaderComponent={header}
            ListFooterComponent={doneFooter}
            renderItem={renderRow}
            contentContainerStyle={[LIST_WIDTH_STYLE, { paddingBottom: dynamicBottomPadding }]}
            onScrollToIndexFailed={handleScrollToIndexFailed}
            panGesture={dragPan}
            dragEnabled={!selection.mode}
            // A worklet: the library calls this on the UI thread (see lib/dragMenu).
            onDragEnd={({ from, to }) => {
              "worklet";
              scheduleOnRN(onDragRelease, from, to);
            }}
            style={{ flex: 1 }}
            {...keyboardListProps}
          />
        )}
        {commonOverlays}
      </View>
    );
  }

  return (
    <View className="flex-1" {...outsidePress}>
      {dragDisabled ? (
        <FlatList
          ref={taskListRef}
          data={orderedFlat}
          keyExtractor={(task, i) => task?.id ?? String(i)}
          ListHeaderComponent={header}
          ListFooterComponent={doneFooter}
          ListEmptyComponent={empty}
          renderItem={({ item }) => renderTask(item)}
          contentContainerStyle={[LIST_WIDTH_STYLE, { paddingBottom: dynamicBottomPadding }]}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          style={{ flex: 1 }}
          {...keyboardListProps}
        />
      ) : (
        <ReorderableList
          ref={taskListRef}
          data={orderedFlat}
          keyExtractor={(task, i) => task?.id ?? String(i)}
          onReorder={handleFlatReorder}
          ListHeaderComponent={header}
          ListFooterComponent={doneFooter}
          ListEmptyComponent={empty}
          contentContainerStyle={[LIST_WIDTH_STYLE, { paddingBottom: dynamicBottomPadding }]}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          panGesture={dragPan}
          dragEnabled={!selection.mode}
          onDragEnd={({ from, to }) => {
            "worklet";
            scheduleOnRN(onDragRelease, from, to);
          }}
          renderItem={({ item }) => (
            <DragToReorder enabled={!selection.mode}>
              {(startDrag) => renderTask(item, undefined, startDrag)}
            </DragToReorder>
          )}
          style={{ flex: 1 }}
          {...keyboardListProps}
        />
      )}
      {commonOverlays}
    </View>
  );
}

/**
 * The optional Done section rendered as the list footer: the project's completed tasks.
 *
 * Collapsed by default, but auto-expands once whenever the shown set goes empty to non-empty; a
 * manual collapse then wins. Collapsed rows are not rendered. Uses the caller's plain
 * `renderTask`, so footer tasks can't be dragged. In a sectioned project rows group by the
 * section each task lived in; tasks whose section is gone land in "No section".
 */
function DoneSection({
  tasks,
  sections,
  renderTask,
}: {
  tasks: Task[];
  sections: Section[];
  renderTask: (task: Task) => ReactNode;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  // A ref, so a footer mounting with tasks already present stays collapsed.
  const hadTasks = useRef(tasks.length > 0);
  useEffect(() => {
    if (!hadTasks.current && tasks.length > 0) setCollapsed(false);
    hadTasks.current = tasks.length > 0;
  }, [tasks.length]);

  const label = `${t("board.done")} (${tasks.length})`;

  // Anything whose section is gone falls into the fallback bucket so it can't vanish from the footer.
  const groups = useMemo(() => {
    if (sections.length === 0) return [{ section: null as Section | null, tasks }];
    const bySection = new Map<string, Task[]>();
    const homeless: Task[] = [];
    for (const task of tasks) {
      const section = task.section_id != null && sections.find((s) => s.id === task.section_id);
      if (section) {
        const list = bySection.get(section.id) ?? [];
        list.push(task);
        bySection.set(section.id, list);
      } else homeless.push(task);
    }
    const out: { section: Section | null; tasks: Task[] }[] = sections
      .filter((s) => bySection.has(s.id))
      .map((s) => ({ section: s as Section, tasks: bySection.get(s.id)! }));
    if (homeless.length > 0) out.push({ section: null, tasks: homeless });
    return out;
  }, [tasks, sections]);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={label}
        onPress={() => setCollapsed((c) => !c)}
        className="flex-row items-center gap-1 px-3 pb-1 pt-4"
      >
        {collapsed ? (
          <ChevronRight size={16} className="text-neutral-500" />
        ) : (
          <ChevronDown size={16} className="text-neutral-500" />
        )}
        <Text
          className={
            "font-medium uppercase text-neutral-500 " +
            (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {label}
        </Text>
      </Pressable>
      {/* An empty footer always shows its hint, even collapsed: it is the toggle's feedback. */}
      {tasks.length === 0 ? (
        <Text className="px-3 py-1 text-xs text-neutral-500">{t("board.noCompleted")}</Text>
      ) : (
        collapsed ||
        groups.map(({ section, tasks: groupTasks }) => (
          <View key={section?.id ?? "none"}>
            {section !== null && (
              <Text className="px-3 pb-1 pt-2 font-medium text-xs uppercase text-neutral-500">
                {section.name}
              </Text>
            )}
            {groupTasks.map((task) => (
              <View key={task.id}>{renderTask(task)}</View>
            ))}
          </View>
        ))
      )}
    </View>
  );
}
