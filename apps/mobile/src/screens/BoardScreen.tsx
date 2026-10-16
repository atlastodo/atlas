import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type ViewInstance,
} from "react-native";
import { useTranslation } from "react-i18next";
import ReorderableList, { type ReorderableListReorderEvent } from "react-native-reorderable-list";
import { scheduleOnRN } from "react-native-worklets";
import {
  columnCards,
  columnRoots,
  flattenTree,
  columnMoveManyWrites,
  columnMoveWrites,
  openTasks,
  rankBetween,
  type BoardMoveWrite,
} from "@atlas/shared";
import type { CreateTaskInput, Label, Section, Task } from "@atlas/client-core";
import { useSections } from "../hooks/useSections";
import { useTaskListView } from "../hooks/useTaskListView";
import { useDragLift, useDragSource, useDropTarget } from "../hooks/useCardDnd";
import { useColumnDragSource, useColumnDropTarget } from "../hooks/useColumnDnd";
import { useIsWide } from "../hooks/useIsWide";
import { useDragPan } from "../hooks/useDragPan";
import { useProjects } from "../hooks/useProjects";
import { useLabels } from "../hooks/useLabels";
import { useAllSections } from "../hooks/useAllSections";
import { usePreferences } from "../hooks/usePreferences";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { useToast } from "../data/ToastProvider";
import { haptics } from "../lib/haptics";
import { dragReleaseAction } from "../lib/dragRelease";
import { KEEP_FOCUS_SUBMIT } from "../lib/submitBehavior";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";
import { useTaskClipboard } from "../hooks/useTaskClipboard";
import { useCursorList } from "../data/CursorProvider";
import { BoardCard } from "../ui/BoardCard";
import { DragToReorder } from "../ui/DragToReorder";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { TaskContextMenu, type TaskContextMenuBulk } from "../ui/TaskContextMenu";
import { SelectionToolbar } from "../ui/SelectionToolbar";
import { BulkLabelSheet } from "../ui/BulkLabelSheet";
import { useSelection } from "../data/SelectionProvider";
import { useSelectionSource } from "../hooks/useSelectionSource";
import { useOutsidePressExit } from "../hooks/useOutsidePressExit";
import { MoveToPicker } from "../ui/MoveToPicker";
import { QuickRescheduleSheet } from "../ui/QuickRescheduleSheet";
import { QuickAdd } from "../ui/QuickAdd";
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CopyPlus,
  EllipsisVertical,
  FolderInput,
  Pencil,
  Plus,
  Trash2,
  X,
} from "../ui/icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * A project's board: columns are its sections (plus a "No section" column), cards are the
 * project's open tasks. Cross-column and within-column drag-and-drop with undo toasts on section
 * moves, and a QuickAdd in each column footer.
 */

export interface BoardScreenProps {
  projectId: string;
  onOpenTask?: (task: Task) => void;
}

interface Column {
  id: string | null;
  name: string;
}

export function BoardScreen({ projectId, onOpenTask }: BoardScreenProps) {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const view = useTaskListView(`board:${projectId}`);
  const {
    sections,
    createSection,
    renameSection,
    duplicateSection,
    removeSection,
    archiveSection,
    moveSectionToProject,
    reorderSection,
    reorderSectionTo,
  } = useSections(projectId);
  const { projects, createProject } = useProjects();
  const { labels, createLabel, byId: labelById } = useLabels();
  const allSections = useAllSections();
  const { showDoneFor } = usePreferences();
  const { copyTasks } = useTaskClipboard();
  const toast = useToast();
  const showDone = showDoneFor(projectId);

  // Cards being tap-moved to another column: one from its menu, or a whole selection.
  const [moving, setMoving] = useState<Task[] | null>(null);
  const [movingTasks, setMovingTasks] = useState<string[] | null>(null);
  const [labeling, setLabeling] = useState<string[] | null>(null);
  const selection = useSelection();
  const [newSection, setNewSection] = useState("");
  const [sectionMenu, setSectionMenu] = useState<{ sectionId: string; pos: MenuPos } | null>(null);
  const [taskMenu, setTaskMenu] = useState<{ task: Task; pos: MenuPos } | null>(null);
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [movingSection, setMovingSection] = useState<string | null>(null);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [draggingCard, setDraggingCard] = useState<Task | null>(null);
  const [rescheduling, setRescheduling] = useState<Task | null>(null);

  const duplicateSectionWithUndo = (id: string) => {
    const { undo } = duplicateSection(id);
    toast.show(t("toast.sectionDuplicated"), { label: t("common.undo"), run: undo });
  };
  const deleteSectionWithUndo = (id: string) => {
    const undo = removeSection(id);
    toast.show(t("toast.sectionDeleted"), { label: t("common.undo"), run: undo });
  };
  const archiveSectionWithUndo = (id: string) => {
    const undo = archiveSection(id);
    toast.show(t("toast.sectionArchived"), { label: t("common.undo"), run: undo });
  };
  const moveSectionWithUndo = (id: string, targetProjectId: string) => {
    const undo = moveSectionToProject(id, targetProjectId);
    toast.show(t("toast.sectionMoved"), { label: t("common.undo"), run: undo });
  };

  const projectTasks = useMemo(
    () => view.tasks.filter((task) => task.project_id === projectId),
    [view.tasks, projectId],
  );

  const tasks = useMemo(() => openTasks(projectTasks), [projectTasks]);

  const subtasksMap = useMemo(() => {
    const map = new Map<string, { completed: number; total: number }>();
    for (const t of projectTasks) {
      if (t.parent_id) {
        const current = map.get(t.parent_id) ?? { completed: 0, total: 0 };
        current.total += 1;
        if (t.is_completed) current.completed += 1;
        map.set(t.parent_id, current);
      }
    }
    return map;
  }, [projectTasks]);

  const doneTasks = useMemo(
    () =>
      showDone
        ? projectTasks
            .filter((task) => task.is_completed)
            .sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0))
        : [],
    [projectTasks, showDone],
  );

  // Every card on the board is selectable, the Done column's too.
  const selectable = useMemo(() => [...tasks, ...doneTasks], [tasks, doneTasks]);
  useSelectionSource(selectable);
  const outsidePress = useOutsidePressExit();
  const selectedTasks = () => selectable.filter((task) => selection.has(task.id));
  const selectedIds = () => [...selection.selected];
  const allSelectedCompleted = () => {
    const chosen = selectedTasks();
    return chosen.length > 0 && chosen.every((task) => task.is_completed);
  };
  // Complete the selection, or reopen it when every selected task is already done.
  const toggleSelected = () => {
    const chosen = selectedTasks();
    if (allSelectedCompleted()) for (const task of chosen) view.toggle(task);
    else view.bulkComplete(chosen.map((task) => task.id));
  };
  // In select mode a click on a card toggles it instead of opening it.
  const openOrSelect = selection.mode ? (task: Task) => selection.toggle(task.id) : onOpenTask;

  const columns = useMemo<Column[]>(
    () => [
      ...sections.map((s: Section) => ({ id: s.id, name: s.name })),
      { id: null, name: t("board.noSection") },
    ],
    [sections, t],
  );

  const nestedByCard = useMemo(() => {
    const map = new Map<string, { task: Task; depth: number }[]>();
    for (const col of columns) {
      let card: { task: Task; depth: number }[] = [];
      for (const row of flattenTree(columnCards(tasks, col.id))) {
        if (row.depth === 0) map.set(row.task.id, (card = []));
        else card.push({ task: row.task, depth: row.depth });
      }
    }
    return map;
  }, [columns, tasks]);

  // The dragged card's preview is an inert copy at the hovered drop point while the card collapses
  // out of its column. `pointerEvents: "none"` (GhostCard) keeps hover counting on the target below.
  const ghostCard =
    draggingCard != null ? (
      <GhostCard
        task={draggingCard}
        now={view.now}
        onToggle={view.toggle}
        formatDue={view.formatDue}
        labelById={labelById}
        subtaskCount={subtasksMap.get(draggingCard.id)}
        subtasks={nestedByCard.get(draggingCard.id)}
      />
    ) : null;

  const cursorId = useCursorList({
    getTasks: () => columns.flatMap((col) => columnRoots(tasks, col.id)),
    open: (task) => onOpenTask?.(task),
    toggle: (task) => view.toggle(task),
    reschedule: (task) => setRescheduling(task),
    remove: (task) => view.bulkDelete([task.id]),
  });

  const addSection = () => {
    const name = newSection.trim();
    if (name === "") return;
    createSection(name);
    setNewSection("");
  };
  const escapeSection = useCancelOnEscape(() => setNewSection(""));

  const applyWrites = (writes: BoardMoveWrite[]) => {
    for (const w of writes)
      view.moveCard(w.id, { section_id: w.section_id, sort_order: w.sort_order });
  };

  const moveCardWithUndo = (
    taskId: string,
    targetSectionId: string | null,
    targetIndex: number,
  ) => {
    const movingTask = tasks.find((t) => t.id === taskId);
    if (!movingTask || movingTask.locked) return;
    const prevSectionId = movingTask.section_id ?? null;
    const prevSortOrder = movingTask.sort_order;

    const writes = columnMoveWrites(projectTasks, taskId, targetSectionId, targetIndex);
    const carried = writes
      .filter((w) => w.id !== taskId && w.sort_order === undefined)
      .map((w) => ({ id: w.id, section_id: projectTasks.find((p) => p.id === w.id)!.section_id }));
    applyWrites(writes);

    if (prevSectionId !== targetSectionId) {
      const targetName = targetSectionId
        ? (sections.find((s) => s.id === targetSectionId)?.name ?? t("board.noSection"))
        : t("board.noSection");
      toast.show(t("toast.movedToSection", { name: targetName }), {
        label: t("common.undo"),
        run: () => {
          view.moveCard(taskId, {
            section_id: prevSectionId,
            sort_order: prevSortOrder,
          });
          for (const c of carried) view.moveCard(c.id, { section_id: c.section_id });
        },
      });
    }
  };

  const reorderColumnTo = (draggedSectionId: string, targetSectionId: string | null) => {
    const to =
      targetSectionId != null
        ? sections.findIndex((s) => s.id === targetSectionId)
        : sections.length - 1;
    if (to >= 0) reorderSectionTo(draggedSectionId, to);
  };

  /** Several cards to the end of one column, undone together. */
  const moveCardsWithUndo = (cards: Task[], targetSectionId: string | null) => {
    const movable = cards.filter((c) => !c.locked);
    const writes = columnMoveManyWrites(
      projectTasks,
      movable.map((c) => c.id),
      targetSectionId,
    );
    const before = writes.map((w) => projectTasks.find((p) => p.id === w.id)!);
    applyWrites(writes);
    const targetName = targetSectionId
      ? (sections.find((s) => s.id === targetSectionId)?.name ?? t("board.noSection"))
      : t("board.noSection");
    toast.show(t("toast.movedToSection", { name: targetName }), {
      label: t("common.undo"),
      run: () => {
        for (const p of before)
          view.moveCard(p.id, { section_id: p.section_id, sort_order: p.sort_order });
      },
    });
  };

  const moveToColumn = (sectionId: string | null) => {
    if (!moving) return;
    if (moving.length === 1) moveCardWithUndo(moving[0]!.id, sectionId, Number.MAX_SAFE_INTEGER);
    else moveCardsWithUndo(moving, sectionId);
    haptics.selection();
    setMoving(null);
  };

  const startMove = (cards: Task[]) => {
    haptics.impact("light");
    setMoving(cards);
  };

  useEffect(() => {
    if (!moving) return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMoving(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moving]);

  // The web drag state must outlive the source card: a cross-column drop re-renders it under its new
  // column, so its own `dragend` can be lost. Reset from the window's capture phase, which sees every drop/dragend.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const clear = () => setDraggingCard(null);
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, []);

  const colWidth = Math.min(320, width * 0.85);

  // An empty "No section" column is only noise once the project has sections: it stays hidden
  // until a card is being dragged or moved, when it is a drop target. A project without sections
  // keeps it, as its only column.
  const visibleColumns = columns.filter(
    (col) =>
      col.id != null ||
      sections.length === 0 ||
      draggingCard != null ||
      moving != null ||
      columnRoots(tasks, null).length > 0,
  );

  const sectionMenuTarget = sectionMenu
    ? sections.find((s) => s.id === sectionMenu.sectionId)
    : null;
  const sectionActionsMenu =
    sectionMenu && sectionMenuTarget
      ? (() => {
          const sec = sectionMenuTarget;
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
                    key: "left",
                    label: t("board.moveLeft"),
                    icon: ChevronLeft,
                    onPress: () => reorderSection(sec.id, "up"),
                  },
                ]
              : []),
            ...(secIndex < sections.length - 1
              ? [
                  {
                    key: "right",
                    label: t("board.moveRight"),
                    icon: ChevronRight,
                    onPress: () => reorderSection(sec.id, "down"),
                  },
                ]
              : []),
            {
              key: "duplicate",
              label: t("common.duplicate"),
              icon: CopyPlus,
              onPress: () => duplicateSectionWithUndo(sec.id),
            },
            {
              key: "move",
              label: t("section.moveToProject"),
              icon: FolderInput,
              onPress: () => setMovingSection(sec.id),
            },
            {
              key: "archive",
              label: t("common.archive"),
              icon: Archive,
              onPress: () => archiveSectionWithUndo(sec.id),
            },
            {
              key: "delete",
              label: t("common.delete"),
              icon: Trash2,
              separatorBefore: true,
              danger: true,
              onPress: () => deleteSectionWithUndo(sec.id),
            },
          ];
          return (
            <ContextMenu items={items} pos={sectionMenu.pos} onClose={() => setSectionMenu(null)} />
          );
        })()
      : null;

  const taskActionsMenu = taskMenu ? (
    <TaskContextMenu
      task={taskMenu.task}
      x={taskMenu.pos.x}
      y={taskMenu.pos.y}
      now={view.now}
      timeZone={view.timeZone}
      onClose={() => setTaskMenu(null)}
      onToggle={view.toggle}
      onSetPriority={(task, p) => view.bulkSetPriority([task.id], p)}
      onSetDue={view.reschedule}
      onCopy={(task) => void copyTasks([task])}
      onDuplicate={(task) => view.bulkDuplicate([task.id])}
      onDelete={(task) => view.bulkDelete([task.id])}
      onMoveToColumn={(task) => startMove([task])}
      onSelect={(task) => selection.beginWith(task.id)}
      bulk={
        selection.mode && selection.has(taskMenu.task.id) && selection.count > 1
          ? ({
              tasks: selectedTasks(),
              onToggle: toggleSelected,
              onSetPriority: (p) => view.bulkSetPriority(selectedIds(), p),
              onSetDue: (dueAt) => view.bulkSetDue(selectedIds(), dueAt),
              onCopy: () => void copyTasks(selectedTasks()),
              onDuplicate: () => view.bulkDuplicate(selectedIds()),
              onDelete: () => view.bulkDelete(selectedIds()),
              onMove: () => setMovingTasks(selectedIds()),
              onLabels: () => setLabeling(selectedIds()),
              onMoveToColumn: () => startMove(selectedTasks().filter((x) => !x.is_completed)),
            } satisfies TaskContextMenuBulk)
          : undefined
      }
    />
  ) : null;

  const moveToPicker = (
    <MoveToPicker
      title={movingSection ? (sections.find((s) => s.id === movingSection)?.name ?? "") : null}
      projects={projects}
      sections={allSections.sections}
      mode="section"
      excludeProjectId={projectId}
      onPick={(target) => {
        if (movingSection && target.project_id != null)
          moveSectionWithUndo(movingSection, target.project_id);
        setMovingSection(null);
      }}
      onClose={() => setMovingSection(null)}
    />
  );

  return (
    <View className="flex-1 bg-white dark:bg-zinc-950" {...outsidePress}>
      {/* Native tap-to-move banner */}
      {moving && (
        <View
          dataSet={{ selectionKeep: "" }}
          className="flex-row items-center gap-2 border-b border-neutral-200 bg-neutral-100 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800"
        >
          <Text numberOfLines={1} className="flex-1 text-sm text-neutral-700 dark:text-neutral-200">
            {moving.length === 1
              ? t("board.movingCard", { title: displayTitle(moving[0]!, t) })
              : t("board.movingCards", { count: moving.length })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.cancel")}
            onPress={() => setMoving(null)}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 web:cursor-pointer"
          >
            <X size={14} className="text-neutral-600 dark:text-neutral-300" />
            <Text className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {t("common.cancel")}
            </Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="px-4 py-3 gap-4"
      >
        {visibleColumns.map((col, colIndex) => (
          <BoardColumn
            key={col.id ?? "__none__"}
            column={col}
            cards={columnRoots(tasks, col.id)}
            nestedByCard={nestedByCard}
            width={colWidth}
            now={view.now}
            timeZone={view.timeZone}
            formatDue={view.formatDue}
            resolveLabels={view.resolveLabels}
            labelById={labelById}
            resolveProject={view.resolveProject}
            smartDates={view.smartDates}
            cursorId={cursorId}
            menuTaskId={taskMenu?.task.id ?? null}
            projects={projects}
            labels={labels}
            onCreateProject={createProject}
            onCreateLabel={createLabel}
            projectId={projectId}
            subtasksMap={subtasksMap}
            ghost={ghostCard}
            onCardDragStart={setDraggingCard}
            moving={moving}
            onMoveHere={moveToColumn}
            onReorderColumn={(draggedId) => reorderColumnTo(draggedId, col.id)}
            sectionIndex={colIndex}
            draggedSectionIndex={
              draggingColId != null ? sections.findIndex((s) => s.id === draggingColId) : -1
            }
            onColumnDragStart={() => col.id != null && setDraggingColId(col.id)}
            onColumnDragEnd={() => setDraggingColId(null)}
            editing={col.id != null && editingSectionId === col.id}
            onStartRename={col.id != null ? () => setEditingSectionId(col.id!) : undefined}
            onCommitRename={(name) => {
              if (col.id != null) renameSection(col.id, name);
              setEditingSectionId(null);
            }}
            onCancelRename={() => setEditingSectionId(null)}
            onOpenActions={
              col.id != null ? (pos) => setSectionMenu({ sectionId: col.id!, pos }) : undefined
            }
            onToggle={view.toggle}
            onOpen={openOrSelect}
            onCardActions={(task, pos) => setTaskMenu({ task, pos })}
            onAddTask={(input) => {
              const last = columnRoots(tasks, col.id).at(-1);
              const sortOrder = rankBetween(last ? last.sort_order : null, null);
              return view.create({
                ...input,
                project_id: projectId,
                section_id: col.id,
                sort_order: input.sort_order ?? sortOrder,
              });
            }}
            onReorder={(from, to, cards) => {
              const active = cards[from];
              if (active) applyWrites(columnMoveWrites(projectTasks, active.id, col.id, to));
            }}
            onDropCard={(taskId, targetIndex) => {
              const colCards = columnRoots(tasks, col.id, taskId);
              moveCardWithUndo(
                taskId,
                col.id,
                targetIndex ?? (colCards.length === 0 ? 0 : Number.MAX_SAFE_INTEGER),
              );
            }}
            onDropOnCard={(draggedId, targetTask) => {
              const colCards = columnRoots(tasks, targetTask.section_id, draggedId);
              const idx = colCards.findIndex((c) => c.id === targetTask.id);
              moveCardWithUndo(draggedId, targetTask.section_id, idx < 0 ? colCards.length : idx);
            }}
          />
        ))}

        {/* Optional Done column */}
        {showDone && (
          <DoneColumn
            tasks={doneTasks}
            width={colWidth}
            now={view.now}
            onToggle={view.toggle}
            onOpen={openOrSelect}
            onCardActions={(task, pos) => setTaskMenu({ task, pos })}
            formatDue={view.formatDue}
            labelById={labelById}
            subtasksMap={subtasksMap}
          />
        )}

        {/* Add a column lane */}
        <View
          style={{ width: colWidth }}
          className="gap-2 rounded-xl border border-dashed border-neutral-300/80 p-3 dark:border-neutral-800 self-start web:hover:border-neutral-400 dark:web:hover:border-neutral-700"
        >
          <View className="flex-row items-center gap-2">
            <TextInput
              ref={escapeSection.ref}
              accessibilityLabel={t("board.addSectionName")}
              value={newSection}
              onChangeText={setNewSection}
              onSubmitEditing={addSection}
              onKeyPress={escapeSection.onKeyPress}
              placeholder={t("board.addSection")}
              placeholderTextColor="#737373"
              returnKeyType="done"
              {...KEEP_FOCUS_SUBMIT}
              className="flex-1 py-1 text-sm text-neutral-900 dark:text-neutral-100"
            />
            {newSection.trim() !== "" && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("board.addSection")}
                onPress={addSection}
              >
                <Plus size={20} className="text-accent-600" />
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>

      {sectionActionsMenu}
      {taskActionsMenu}
      {moveToPicker}
      {selection.mode && (
        <SelectionToolbar
          count={selection.count}
          allCompleted={allSelectedCompleted()}
          now={view.now}
          timeZone={view.timeZone}
          onSelectAll={() => selection.selectAll()}
          onComplete={toggleSelected}
          onSetPriority={(p) => view.bulkSetPriority(selectedIds(), p)}
          onSetDue={(dueAt) => view.bulkSetDue(selectedIds(), dueAt)}
          onCopy={() => void copyTasks(selectedTasks())}
          onDuplicate={() => view.bulkDuplicate(selectedIds())}
          onMove={() => setMovingTasks(selectedIds())}
          onLabel={() => setLabeling(selectedIds())}
          onDelete={() => view.bulkDelete(selectedIds())}
          onClear={() => selection.clear()}
        />
      )}
      <MoveToPicker
        title={movingTasks ? t("selection.count", { count: movingTasks.length }) : null}
        projects={projects}
        sections={allSections.sections}
        onPick={(target) => {
          if (movingTasks) view.bulkMove(movingTasks, target);
          setMovingTasks(null);
        }}
        onClose={() => setMovingTasks(null)}
      />
      <BulkLabelSheet
        title={labeling ? t("selection.count", { count: labeling.length }) : null}
        tasks={labeling ? selectable.filter((task) => labeling.includes(task.id)) : []}
        onApply={(change) => {
          if (labeling) view.bulkSetLabels(labeling, change);
        }}
        onClear={() => {
          if (labeling) view.bulkClearLabels(labeling);
        }}
        onClose={() => setLabeling(null)}
      />
      <QuickRescheduleSheet
        title={rescheduling ? displayTitle(rescheduling, t) : null}
        now={view.now}
        timeZone={view.timeZone}
        onPick={(dueAt) => {
          if (rescheduling) view.reschedule(rescheduling, dueAt);
          setRescheduling(null);
        }}
        onClose={() => setRescheduling(null)}
      />
    </View>
  );
}

function BoardColumn({
  column,
  cards,
  width,
  now,
  timeZone,
  formatDue,
  resolveLabels,
  labelById,
  resolveProject,
  smartDates,
  cursorId,
  menuTaskId,
  projects,
  labels,
  onCreateProject,
  onCreateLabel,
  projectId,
  subtasksMap,
  nestedByCard,
  ghost,
  onCardDragStart,
  moving,
  onMoveHere,
  onReorderColumn,
  sectionIndex,
  draggedSectionIndex,
  onColumnDragStart,
  onColumnDragEnd,
  editing,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onOpenActions,
  onToggle,
  onOpen,
  onAddTask,
  onReorder,
  onDropCard,
  onDropOnCard,
  onCardActions,
}: {
  column: Column;
  cards: Task[];
  width: number;
  now: number;
  timeZone?: string;
  formatDue?: (ms: number) => string;
  /** Quick-add's `@label` names to ids (creating missing labels). */
  resolveLabels?: (names: string[]) => string[];
  labelById?: (id: string) => Label | undefined;
  resolveProject?: (name: string) => string | null | undefined;
  smartDates?: boolean;
  cursorId?: string | null;
  /** The card a task menu is open for: highlighted like the cursor while the menu shows. */
  menuTaskId?: string | null;
  projects?: { id: string; name: string }[];
  labels?: { id: string; name: string; color?: string }[];
  onCreateProject?: (name: string) => string;
  onCreateLabel?: (name: string, color?: string) => string;
  projectId: string;
  subtasksMap: Map<string, { completed: number; total: number }>;
  nestedByCard: Map<string, { task: Task; depth: number }[]>;
  ghost?: ReactNode;
  onCardDragStart: (task: Task) => void;
  moving: Task[] | null;
  onMoveHere: (sectionId: string | null) => void;
  onReorderColumn: (draggedSectionId: string) => void;
  sectionIndex: number;
  draggedSectionIndex: number;
  onColumnDragStart: () => void;
  onColumnDragEnd: () => void;
  editing: boolean;
  onStartRename?: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onOpenActions?: (pos: MenuPos) => void;
  onToggle: (task: Task) => void;
  onOpen?: (task: Task) => void;
  onAddTask: (input: CreateTaskInput) => void | string;
  onReorder: (from: number, to: number, cards: Task[]) => void;
  onDropCard: (taskId: string, targetIndex?: number) => void;
  onDropOnCard: (draggedId: string, targetTask: Task) => void;
  onCardActions?: (task: Task, pos: MenuPos) => void;
}) {
  const { t } = useTranslation();
  const columnRef = useRef<ViewInstance>(null);
  const headerRef = useRef<ViewInstance>(null);
  const topDropRef = useRef<ViewInstance>(null);

  const [renameDraft, setRenameDraft] = useState(column.name);
  useEffect(() => {
    if (editing) setRenameDraft(column.name);
  }, [editing, column.name]);

  const headerContextRef = useContextMenu((pos) => onOpenActions?.(pos));
  const commitRename = () => {
    if (escapeRename.consume()) return;
    const trimmed = renameDraft.trim();
    if (trimmed) onCommitRename(trimmed);
    else onCancelRename();
  };
  const escapeRename = useCancelOnEscape(() => {
    setRenameDraft(column.name);
    onCancelRename();
  });

  const over = useDropTarget(columnRef, (draggedId) => {
    onDropCard(draggedId, cards.length === 0 ? 0 : Number.MAX_SAFE_INTEGER);
  });
  const headerCardOver = useDropTarget(headerRef, (draggedId) => {
    onDropCard(draggedId, 0);
  });
  const topOver = useDropTarget(topDropRef, (draggedId) => {
    onDropCard(draggedId, 0);
  });
  const bottomDropRef = useRef<ViewInstance>(null);
  const footerDropRef = useRef<ViewInstance>(null);
  const bottomOver = useDropTarget(bottomDropRef, (draggedId) => {
    onDropCard(draggedId, Number.MAX_SAFE_INTEGER);
  });
  const footerOver = useDropTarget(footerDropRef, (draggedId) => {
    onDropCard(draggedId, Number.MAX_SAFE_INTEGER);
  });
  const columnDragging = useColumnDragSource(headerRef, () => column.id ?? "", {
    onDragStart: onColumnDragStart,
    onDragEnd: onColumnDragEnd,
  });
  const columnOver = useColumnDropTarget(columnRef, onReorderColumn);

  const dropBar =
    columnOver && !columnDragging && draggedSectionIndex >= 0
      ? draggedSectionIndex < sectionIndex
        ? "right"
        : "left"
      : null;

  // Every moving card already sits in this column: nothing to move here.
  const isSourceColumn =
    moving != null && moving.every((m) => (m.section_id ?? null) === column.id);
  const isMoveTarget = moving != null && !isSourceColumn;

  const isWide = useIsWide();
  const dragDisabled = Platform.OS === "web" && !isWide;
  const dragPan = useDragPan();

  const handleReorder = ({ from, to }: ReorderableListReorderEvent) => {
    if (from !== to) {
      haptics.impact("light");
    }
    onReorder(from, to, cards);
  };

  const triggerIndexHaptic = useCallback(() => {
    haptics.selection();
  }, []);

  const handleIndexChange = useCallback(() => {
    "worklet";
    scheduleOnRN(triggerIndexHaptic);
  }, [triggerIndexHaptic]);

  const onDragRelease = useCallback(
    (from: number, to: number) => {
      const action = dragReleaseAction({
        from,
        to,
        selectMode: false,
        isWeb: Platform.OS === "web",
      });
      if (action !== "menu") return;
      const task = cards[from];
      if (task) onCardActions?.(task, { x: 0, y: 0 });
    },
    [cards, onCardActions],
  );

  const renderCard = ({ item, index, drag }: { item: Task; index: number; drag?: () => void }) => (
    <DraggableCard
      task={item}
      now={now}
      dimmed={moving?.some((m) => m.id === item.id)}
      focused={item.id === cursorId || item.id === menuTaskId}
      isLast={index === cards.length - 1}
      onToggle={onToggle}
      onOpen={onOpen}
      onDropOnCard={onDropOnCard}
      onDropAfterCard={(draggedId) => {
        onDropCard(draggedId, Number.MAX_SAFE_INTEGER);
      }}
      formatDue={formatDue}
      labelById={labelById}
      subtaskCount={subtasksMap.get(item.id)}
      subtasks={nestedByCard.get(item.id)}
      ghost={ghost}
      onCardDragStart={onCardDragStart}
      onContextMenu={onCardActions}
      drag={drag}
    />
  );

  return (
    <View
      ref={columnRef}
      style={{ width }}
      className={
        "relative max-h-full self-start rounded-xl p-1.5 web:transition-colors " +
        (columnDragging ? "opacity-40 " : "") +
        (over || isMoveTarget ? "bg-accent-50 dark:bg-accent-950 ring-1 ring-accent-300 " : "")
      }
    >
      {dropBar && (
        <View
          aria-hidden
          style={{ pointerEvents: "none" }}
          className={
            "absolute bottom-0 top-0 z-10 w-1/3 rounded-xl border-2 border-dashed border-accent-300 bg-accent-50 opacity-70 " +
            (dropBar === "right" ? "right-0" : "left-0")
          }
        />
      )}

      {/* Column header */}
      {editing ? (
        <TextInput
          ref={escapeRename.ref}
          autoFocus
          accessibilityLabel={t("board.renameSection", { name: column.name })}
          value={renameDraft}
          onChangeText={setRenameDraft}
          onBlur={commitRename}
          onSubmitEditing={commitRename}
          onKeyPress={escapeRename.onKeyPress}
          returnKeyType="done"
          className="rounded bg-neutral-100 px-2 py-1 text-sm text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
        />
      ) : (
        <View ref={headerRef} className="flex-row items-center gap-1.5 pb-2.5 px-1 web:cursor-grab">
          <View ref={headerContextRef} className="min-w-0 flex-1 flex-row items-center gap-1.5">
            <Text
              numberOfLines={1}
              className="text-xs font-bold uppercase tracking-wider text-neutral-700 dark:text-neutral-300"
            >
              {`${column.name} (${cards.length})`}
            </Text>
          </View>

          {onStartRename && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("board.renameSection", { name: column.name })}
              onPress={onStartRename}
              hitSlop={8}
              className="p-1 web:cursor-pointer opacity-70 hover:opacity-100"
            >
              <Pencil size={14} className="text-neutral-500" />
            </Pressable>
          )}

          {onOpenActions && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("board.sectionActions", { name: column.name })}
              onPress={(e) =>
                onOpenActions({ x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 })
              }
              hitSlop={8}
              className="p-1 web:cursor-pointer opacity-70 hover:opacity-100"
            >
              <EllipsisVertical size={15} className="text-neutral-500" />
            </Pressable>
          )}
        </View>
      )}

      {/* Native tap-to-move drop button */}
      {isMoveTarget && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("board.moveHereTo", { name: column.name })}
          onPress={() => onMoveHere(column.id)}
          // Moving a selection keeps it: not an outside press (`useOutsidePressExit`).
          dataSet={{ selectionKeep: "" }}
          className="mb-2 items-center rounded-md border border-accent-300 py-2 dark:border-accent-700 web:cursor-pointer"
        >
          <Text className="text-sm font-medium text-accent-600 dark:text-accent-300">
            {t("board.moveHere")}
          </Text>
        </Pressable>
      )}

      {/* Card list */}
      {cards.length === 0 ? (
        <View
          className={
            "my-2 min-h-[80px] items-center justify-center rounded-lg border-2 border-dashed p-3 " +
            (over
              ? "border-accent-500 bg-accent-50 dark:border-accent-500 dark:bg-accent-950"
              : "border-neutral-200 dark:border-neutral-800")
          }
        >
          {over ? (
            ghost
          ) : (
            <Text className="text-xs text-neutral-500 dark:text-neutral-400">
              {t("board.noTasks", "No tasks")}
            </Text>
          )}
        </View>
      ) : (
        <View className="shrink">
          {/* Top drop zone: hit target when dragging to the top of the column */}
          <View
            ref={topDropRef}
            className={"w-full " + (topOver || headerCardOver ? "py-0.5" : "h-1")}
          >
            {(headerCardOver || topOver) && ghost}
          </View>
          {dragDisabled ? (
            <FlatList
              data={cards}
              keyExtractor={(task, i) => task?.id ?? String(i)}
              style={CARD_LIST}
              contentContainerStyle={{ paddingTop: 4, paddingBottom: 4 }}
              renderItem={({ item, index }) => renderCard({ item, index })}
              ListFooterComponent={
                <View ref={bottomDropRef} className="w-full min-h-[16px] justify-start py-1">
                  {(bottomOver || footerOver) && ghost}
                </View>
              }
            />
          ) : (
            <ReorderableList
              data={cards}
              keyExtractor={(task, i) => task?.id ?? String(i)}
              onReorder={handleReorder}
              onIndexChange={handleIndexChange}
              panGesture={dragPan}
              onDragEnd={({ from, to }) => {
                "worklet";
                scheduleOnRN(onDragRelease, from, to);
              }}
              style={CARD_LIST}
              contentContainerStyle={{ paddingTop: 4, paddingBottom: 4 }}
              renderItem={({ item, index }) => (
                <DragToReorder enabled={!dragDisabled}>
                  {(startDrag) => renderCard({ item, index, drag: startDrag })}
                </DragToReorder>
              )}
              ListFooterComponent={
                <View ref={bottomDropRef} className="w-full min-h-[16px] justify-start py-1">
                  {(bottomOver || footerOver) && ghost}
                </View>
              }
            />
          )}
        </View>
      )}

      {/* Column Footer: Standard QuickAdd */}
      <View
        ref={footerDropRef}
        className="mt-1.5 border-t border-dashed border-neutral-200/70 pt-2 dark:border-zinc-800/70"
      >
        <QuickAdd
          accessibilityLabel={t("board.addTaskTo", { name: column.name })}
          placeholder={t("board.addTask")}
          onAdd={onAddTask}
          defaults={{ project_id: projectId, section_id: column.id }}
          projects={projects}
          labels={labels}
          onCreateProject={onCreateProject}
          onCreateLabel={onCreateLabel}
          resolveLabels={resolveLabels}
          resolveProject={resolveProject}
          smartDates={smartDates}
          now={now}
          timeZone={timeZone}
          formatDue={formatDue}
        />
      </View>
    </View>
  );
}

function DoneColumn({
  tasks,
  width,
  now,
  onToggle,
  onOpen,
  onCardActions,
  formatDue,
  labelById,
  subtasksMap,
}: {
  tasks: Task[];
  width: number;
  now: number;
  onToggle: (task: Task) => void;
  onOpen?: (task: Task) => void;
  onCardActions?: (task: Task, pos: MenuPos) => void;
  formatDue?: (ms: number) => string;
  labelById?: (id: string) => Label | undefined;
  subtasksMap: Map<string, { completed: number; total: number }>;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const label = `${t("board.done")} (${tasks.length})`;

  return (
    <View style={{ width }} className="max-h-full rounded-xl p-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={label}
        onPress={() => setCollapsed((c) => !c)}
        className="flex-row items-center gap-1.5 px-1 py-1"
      >
        {collapsed ? (
          <ChevronRight size={14} className="text-neutral-500" />
        ) : (
          <ChevronDown size={14} className="text-neutral-500" />
        )}
        <Text className="text-xs font-bold uppercase tracking-wider text-neutral-500">{label}</Text>
      </Pressable>

      {!collapsed && (
        <ReorderableList
          data={tasks}
          keyExtractor={(task, i) => task?.id ?? String(i)}
          dragEnabled={false}
          onReorder={() => {}}
          style={{ flex: 1 }}
          renderItem={({ item }) => (
            <BoardCard
              task={item}
              now={now}
              onToggle={onToggle}
              onOpen={onOpen}
              formatDue={formatDue}
              labelById={labelById}
              subtaskCount={subtasksMap.get(item.id)}
              onContextMenu={onCardActions}
              readOnly
            />
          )}
        />
      )}
    </View>
  );
}

/** An inert copy of the dragged card, rendered at the hovered insertion point to preview where it lands. */
function GhostCard({
  task,
  now,
  onToggle,
  formatDue,
  labelById,
  subtaskCount,
  subtasks,
}: {
  task: Task;
  now: number;
  onToggle: (task: Task) => void;
  formatDue?: (ms: number) => string;
  labelById?: (id: string) => Label | undefined;
  subtaskCount?: { completed: number; total: number };
  subtasks?: { task: Task; depth: number }[];
}) {
  return (
    <View aria-hidden style={{ pointerEvents: "none" }} className="w-full">
      <BoardCard
        task={task}
        now={now}
        onToggle={onToggle}
        formatDue={formatDue}
        labelById={labelById}
        subtaskCount={subtaskCount}
        subtasks={subtasks}
        preview
      />
    </View>
  );
}

/**
 * A column's card list sizes to its cards (so the column's Add task sits under the last one) and
 * shrinks to scroll once the column reaches the board's height. Not `flex: 1`: a zero basis in a
 * content-sized column collapses the list.
 */
const CARD_LIST = { flexGrow: 0, flexShrink: 1 } as const;

/** A dragged card's footprint while lifted: none, with the element kept in the page. */
const LIFTED = { height: 0, overflow: "hidden" } as const;

function DraggableCard({
  task,
  now,
  dimmed,
  focused,
  isLast,
  onToggle,
  onOpen,
  onDropOnCard,
  onDropAfterCard,
  formatDue,
  labelById,
  subtaskCount,
  subtasks,
  ghost,
  onCardDragStart,
  onContextMenu,
  drag,
}: {
  task: Task;
  now: number;
  dimmed?: boolean;
  focused?: boolean;
  isLast?: boolean;
  onToggle: (task: Task) => void;
  onOpen?: (task: Task) => void;
  onDropOnCard: (draggedId: string, targetTask: Task) => void;
  onDropAfterCard?: (draggedId: string, targetTask: Task) => void;
  formatDue?: (ms: number) => string;
  labelById?: (id: string) => Label | undefined;
  subtaskCount?: { completed: number; total: number };
  subtasks?: { task: Task; depth: number }[];
  ghost?: ReactNode;
  onCardDragStart: (task: Task) => void;
  onContextMenu?: (task: Task, pos: MenuPos) => void;
  drag?: () => void;
}) {
  const ref = useRef<ViewInstance>(null);
  const bottomEdgeRef = useRef<ViewInstance>(null);
  const selectMode = useSelection().mode;
  const dragging = useDragSource(ref, () => task.id, {
    enabled: !task.locked && !selectMode,
    onDragStart: () => onCardDragStart(task),
  });
  // Mid-drag the card collapses out of its column, leaving the preview at the drop point. Collapsed,
  // not unmounted: the source must stay in the page for its dragend.
  const lifted = useDragLift(dragging);
  const over = useDropTarget(ref, (draggedId) => {
    if (draggedId !== task.id) onDropOnCard(draggedId, task);
  });
  const bottomEdgeOver = useDropTarget(bottomEdgeRef, (draggedId) => {
    if (draggedId === task.id) return;
    if (onDropAfterCard) onDropAfterCard(draggedId, task);
    else onDropOnCard(draggedId, task);
  });

  return (
    <View
      ref={ref}
      aria-hidden={lifted || undefined}
      style={lifted ? LIFTED : undefined}
      className={"relative " + (dimmed ? "opacity-50" : "")}
    >
      {/* The preview renders in flow, so the hovered card (and those below it) slide down to make
          room. */}
      {over && !bottomEdgeOver && !dragging && ghost}
      <BoardCard
        task={task}
        now={now}
        onToggle={onToggle}
        onOpen={onOpen}
        formatDue={formatDue}
        labelById={labelById}
        subtaskCount={subtaskCount}
        subtasks={subtasks}
        onContextMenu={onContextMenu}
        drag={drag}
        focused={focused}
      />
      {isLast && (
        <>
          <View ref={bottomEdgeRef} className="absolute -bottom-2.5 left-0 right-0 h-5 z-20" />
          {bottomEdgeOver && !dragging && ghost}
        </>
      )}
    </View>
  );
}
