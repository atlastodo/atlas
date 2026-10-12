import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { Label, Task } from "@atlas/client-core";
import {
  PRIORITY_COLOR,
  isOverdue,
  resolveTaskSwipe,
  type AvatarColor,
  type TaskSwipeAction,
} from "@atlas/shared";
import {
  Bell,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheckBig,
  CornerDownRight,
  CornerUpLeft,
  Flag,
  Info,
  KeyRound,
  Repeat,
  Trash2,
} from "./icons";
import { useCanHover } from "../hooks/useCanHover";
import { useIsWide } from "../hooks/useIsWide";

/** Horizontal indent per subtask nesting level, in px. Shared with the touch indent gesture. */
const INDENT_STEP = 20;
/** The row's left padding: the 16px list edge the toolbar, quick-add and group headers share. */
const ROW_EDGE = 16;
import { GestureDetector } from "react-native-gesture-handler";
import { LabelChips } from "./LabelChips";
import { SwipeableRow } from "./SwipeableRow";
import { usePaintHandlers, useCheckboxPaintGesture } from "../hooks/usePaintHandlers";
import { useSelectionRow } from "../data/SelectionProvider";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { isEscapeKey } from "../hooks/useCancelOnEscape";
import { haptics } from "../lib/haptics";

/** Where a task lives: its project and (optionally) section names. Absent parts are omitted. */
export interface TaskOrigin {
  project?: string;
  section?: string;
}

/** An assignee's avatar info for a row: initials + name + a stable colour. */
export interface RowAssignee {
  initials: string;
  name: string;
  color: AvatarColor;
}

/**
 * A single task row: completion toggle, title, optional markers, due date, and swipe actions.
 *
 * Presentational: every value and callback arrives as a prop. Swipe actions come from
 * `resolveTaskSwipe`. In select mode a tap toggles selection and swipe is disabled.
 *
 * Gestures: a tap opens the task. The action menu opens on a long-press, but the reorder library
 * lifts the row on the hold timer, so how differs by list:
 *   - Reorderable lists: the long-press lifts the row; releasing without moving opens the menu from
 *     the list's `onDragEnd`. The row only reports its press position (`onPressIn`).
 *   - Non-reorderable lists: a plain `Pressable` long-press opens the menu (`enableLongPressMenu`).
 * Web uses right-click (`useContextMenu`).
 *
 * Memoised (see {@link sameRowProps}): a list re-renders only the rows whose props changed, so a
 * list must pass stable callbacks. The row reads no context that changes with the list's data; the
 * swipe preferences and selection state arrive as props for that reason.
 */

import { defaultFormatDue } from "../lib/dueFormat";
import { displayTitle } from "../lib/taskTitle";

/**
 * An icon that says one thing to a screen reader.
 *
 * Labelling a lucide icon directly makes react-native-svg pass the label to the `<Svg>` and each
 * path, so it is announced three times. `accessible` on a wrapping View collapses it to one node.
 */
function Marker({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View accessible accessibilityLabel={label}>
      {children}
    </View>
  );
}

export interface TaskRowProps {
  task: Task;
  now: number;
  onToggle: (task: Task) => void;
  /** Open the task's detail screen; the screen wires it. */
  onOpen?: (task: Task) => void;
  /** Whether the row is currently in inline rename mode. */
  isEditing?: boolean;
  /** Callback to start inline renaming of this task. */
  onStartRename?: (task: Task) => void;
  /** Callback when title rename is saved (blur or submit). */
  onSaveRename?: (task: Task, newTitle: string) => void;
  /** Callback when Enter is pressed in rename mode to create a task below. */
  onSubmitRenameAndAddBelow?: (task: Task, newTitle: string) => void;
  /** Callback when inline rename is cancelled (e.g. Escape). */
  onCancelRename?: (task?: Task) => void;
  /** Whether the task has any reminders (shows a bell marker). */
  hasReminder?: boolean;
  /** Format the due instant (defaults to device-locale short date). */
  formatDue?: (ms: number) => string;
  /** Long-press starts a drag; the menu then comes from the list's `onDragEnd` (release without moving). */
  onLongPress?: (task: Task) => void;
  /** Whether the list is in select mode: a tap selects rather than opens. */
  selectMode?: boolean;
  /** Whether this row is selected. */
  selected?: boolean;
  /** Toggle this row's selection (select mode only). */
  onSelect?: (task: Task) => void;
  /** Swipe left to open the quick-reschedule sheet. */
  onSchedule?: (task: Task) => void;
  /** Delete the task (moves to trash). */
  onDelete?: (task: Task) => void;
  /** Where the task lives (project . section); shows a muted breadcrumb under the title. */
  origin?: TaskOrigin;
  /** Assignee avatar (initials + name + colour); shows a small avatar chip when assigned. */
  assignee?: RowAssignee;
  /** Resolve a label id to its label, for the row's label chips; unknown ids are skipped. */
  labelOf?: (id: string) => Label | undefined;
  /** Opens the action menu at a position: web right-click, or a native long-press (see below). */
  onContextMenu?: (task: Task, pos: MenuPos) => void;
  /** Native long-press that opens the action menu directly; only for non-reorderable lists. */
  enableLongPressMenu?: boolean;
  /** Report the press position (native), so a reorderable list's drag-end menu opens at the row. */
  onPressIn?: (pos: MenuPos) => void;
  /** The keyboard cursor is on this row (web j/k navigation): highlight it. */
  focused?: boolean;
  /** Subtask nesting level (0 = top-level); indents the row by `depth * INDENT_STEP`. */
  depth?: number;
  /** Direct-subtask progress shown as an "n/m" marker on a parent row. */
  subtaskProgress?: { done: number; total: number };
  /** Reserve the trailing caret slot so rows align whether or not they are parents (nested lists). */
  indentGutter?: boolean;
  /** Show when the task was completed in the date slot instead of its due date (Completed). */
  showCompletedAt?: boolean;
  /** Whether this parent's subtree is expanded (drives the caret); parent rows only. */
  expanded?: boolean;
  /** Toggle this parent's expand/collapse (given only for rows that have children). */
  onToggleExpand?: (task: Task) => void;
  /** Indent the task under its preceding sibling (make it a subtask). */
  onIndent?: (task: Task) => void;
  /** Outdent the task to its grandparent or top-level. */
  onOutdent?: (task: Task) => void;
  /** Whether the task can be indented. */
  canIndent?: boolean;
  /** Whether the task can be outdented. */
  canOutdent?: boolean;
  /** The swipe-right action preference (default indent). */
  swipeRightAction?: TaskSwipeAction;
  /** The swipe-left action preference (default schedule). */
  swipeLeftAction?: TaskSwipeAction;
}

/** Imperative handle for a row in inline rename mode: lets a parent commit the draft title. */
export interface TaskRowHandle {
  /**
   * Save the draft title (trimmed, falling back to the old title when empty) and leave rename mode:
   * the keyboard toolbar's Done. Returns the saved title. Guarded against the trailing blur so
   * dismissing the keyboard cannot save twice.
   */
  commitRename: () => string;
}

function TaskRowView({
  task,
  now,
  onToggle,
  onOpen,
  isEditing: isEditingProp = false,
  onStartRename,
  onSaveRename,
  onSubmitRenameAndAddBelow,
  onCancelRename,
  hasReminder,
  formatDue = defaultFormatDue,
  onLongPress,
  selectMode = false,
  selected = false,
  onSelect,
  onSchedule,
  onDelete,
  onIndent,
  onOutdent,
  canIndent,
  canOutdent,
  origin,
  assignee,
  labelOf,
  onContextMenu,
  enableLongPressMenu = false,
  onPressIn,
  focused = false,
  depth = 0,
  subtaskProgress,
  indentGutter = false,
  showCompletedAt = false,
  expanded = true,
  onToggleExpand,
  swipeRightAction = "indent",
  swipeLeftAction = "schedule",
  ref,
}: TaskRowProps & { ref?: Ref<TaskRowHandle> }) {
  const { t } = useTranslation();
  // Undecryptable task: its "" title is a placeholder, so it is never renamed, completed or dragged from here.
  const locked = task.locked === true;
  const isEditing = isEditingProp && !locked;
  const [localTitle, setLocalTitle] = useState(task.title);
  const [cursorSelection, setCursorSelection] = useState<
    { start: number; end: number } | undefined
  >(undefined);
  const inputRef = useRef<TextInput>(null);
  const submittedRef = useRef(false);
  const openingDetailsRef = useRef(false);

  useEffect(() => {
    if (!isEditing) {
      setLocalTitle(task.title);
      setCursorSelection(undefined);
      submittedRef.current = false;
      openingDetailsRef.current = false;
    } else {
      submittedRef.current = false;
      openingDetailsRef.current = false;
      const len = task.title.length;
      setCursorSelection({ start: len, end: len });
      if (Platform.OS === "web") {
        const focusAndSelectEnd = () => {
          inputRef.current?.focus();
          const el = inputRef.current as unknown as HTMLInputElement;
          if (el && typeof el.setSelectionRange === "function") {
            const currentLen = el.value ? el.value.length : len;
            el.setSelectionRange(currentLen, currentLen);
          }
        };
        const raf = requestAnimationFrame(focusAndSelectEnd);
        return () => cancelAnimationFrame(raf);
      }
    }
  }, [task.title, isEditing]);

  const handleOpenFromEdit = (e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    inputRef.current?.blur();
    Keyboard.dismiss();
    if (openingDetailsRef.current) return;
    openingDetailsRef.current = true;
    setTimeout(() => {
      openingDetailsRef.current = false;
    }, 400);

    const trimmed = localTitle.trim();
    const finalTitle =
      trimmed.length > 0 ? trimmed : task.title.trim().length > 0 ? task.title : "";
    setLocalTitle(finalTitle);
    onSaveRename?.(task, finalTitle);
    onOpen?.({ ...task, title: finalTitle });
  };

  const handleSave = () => {
    if (submittedRef.current || openingDetailsRef.current) return;
    const trimmed = localTitle.trim();
    const finalTitle =
      trimmed.length > 0 ? trimmed : task.title.trim().length > 0 ? task.title : "";
    setLocalTitle(finalTitle);
    onSaveRename?.(task, finalTitle);
  };

  const handleSubmit = () => {
    submittedRef.current = true;
    const trimmed = localTitle.trim();
    const isNewTask = !task.title.trim();
    const titleChanged = trimmed !== task.title.trim();
    const finalTitle =
      trimmed.length > 0 ? trimmed : task.title.trim().length > 0 ? task.title : "";
    setLocalTitle(finalTitle);

    if (isNewTask) {
      if (onSubmitRenameAndAddBelow && trimmed.length > 0) {
        onSubmitRenameAndAddBelow(task, finalTitle);
      } else {
        handleCancel();
      }
    } else if (titleChanged) {
      onSaveRename?.(task, finalTitle);
    } else {
      if (onSubmitRenameAndAddBelow) {
        onSubmitRenameAndAddBelow(task, finalTitle);
      } else {
        onSaveRename?.(task, finalTitle);
      }
    }
  };

  const handleCancel = () => {
    setLocalTitle(task.title);
    onCancelRename?.(task);
  };

  /** Commit the draft and leave rename mode without Enter's add-below. Marks the row submitted so the dismissing blur cannot save again. */
  const commitRename = useCallback((): string => {
    if (!isEditing) return task.title;
    submittedRef.current = true;
    const trimmed = localTitle.trim();
    const finalTitle =
      trimmed.length > 0 ? trimmed : task.title.trim().length > 0 ? task.title : "";
    setLocalTitle(finalTitle);
    onSaveRename?.(task, finalTitle);
    return finalTitle;
  }, [isEditing, localTitle, task, onSaveRename]);

  useImperativeHandle(ref, () => ({ commitRename }), [commitRename]);

  const hasOrigin = origin && (origin.project || origin.section);
  const overdue = isOverdue(task, now);
  const paint = usePaintHandlers(task.id, selectMode);
  const checkboxGesture = useCheckboxPaintGesture(task.id, selectMode);
  const selection = useSelectionRow();
  useEffect(() => {
    return () => {
      selection?.unregisterRowHeight(task.id);
    };
  }, [selection, task.id]);
  const contextRef = useContextMenu((pos) => onContextMenu?.(task, pos));
  const noteLines = task.notes ? task.notes.split("\n") : [];
  const firstNoteLine = noteLines.find((l) => l.trim() !== "")?.trim() ?? "";
  const hasMoreNotes = firstNoteLine !== "" && task.notes.trim() !== firstNoteLine;

  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragDistanceRef = useRef(0);

  const press = () => {
    if (dragDistanceRef.current > 6) {
      dragDistanceRef.current = 0;
      pointerStartRef.current = null;
      return;
    }
    dragDistanceRef.current = 0;
    pointerStartRef.current = null;

    if (selectMode) {
      haptics.selection();
      onSelect?.(task);
    } else if (onOpen) {
      Keyboard.dismiss();
      onOpen(task);
    } else if (onStartRename && !locked) {
      onStartRename(task);
    }
  };

  const pos = (e: GestureResponderEvent): MenuPos => ({
    x: e?.nativeEvent?.pageX ?? 0,
    y: e?.nativeEvent?.pageY ?? 0,
  });
  // Off on reorderable lists: the drag owns the long-press and the list's onDragEnd opens the menu.
  const longPressMenu =
    enableLongPressMenu && Platform.OS !== "web" && !selectMode && onContextMenu
      ? (e: GestureResponderEvent) => {
          haptics.impact("medium");
          onContextMenu(task, pos(e));
        }
      : undefined;

  const dragLongPress = locked ? undefined : onLongPress;
  const canPressRow =
    !isEditing && (Boolean(onOpen) || (Boolean(onStartRename) && !locked) || selectMode);
  const isWeb = Platform.OS === "web";
  const iconSize = isWeb ? 16 : 18;
  // Hover actions (and the drag grip) exist only for a pointer that can hover: on touch they stick
  // after a tap and would take room the title needs.
  const canHover = useCanHover();
  const hoverActions =
    canHover && !isEditing && !selectMode && (Boolean(onOpen) || (Boolean(onSchedule) && !locked));
  // Wide layouts give the flag, date and caret fixed slots so they line up from row to row.
  const columns = useIsWide();
  const dateMs = showCompletedAt ? task.completed_at : task.due_at;

  const isSubtask = task.parent_id !== null || depth > 0;

  const resolveSwipe = (action: TaskSwipeAction): { handler?: () => void; icon?: ReactNode } => {
    const effect = resolveTaskSwipe(action, {
      locked,
      isSubtask,
      canIndent: Boolean(onIndent) && canIndent !== false,
      canOutdent: Boolean(onOutdent) && canOutdent !== false,
    });
    switch (effect) {
      case "complete":
        return {
          handler: () => onToggle(task),
          icon: <Check size={22} className="text-emerald-600" />,
        };
      case "schedule":
        return {
          handler: onSchedule ? () => onSchedule(task) : undefined,
          icon: <CalendarClock size={22} className="text-amber-600" />,
        };
      case "indent":
        return {
          handler: () => onIndent?.(task),
          icon: <CornerDownRight size={22} className="text-blue-600 dark:text-blue-400" />,
        };
      case "outdent":
        return {
          handler: () => onOutdent?.(task),
          icon: <CornerUpLeft size={22} className="text-indigo-600 dark:text-indigo-400" />,
        };
      case "delete":
        return {
          handler: onDelete ? () => onDelete(task) : undefined,
          icon: <Trash2 size={22} className="text-red-600" />,
        };
      default:
        return {};
    }
  };

  const rightSwipe = resolveSwipe(swipeRightAction);
  const leftSwipe = resolveSwipe(swipeLeftAction);

  return (
    // Swipe is off in select mode.
    <SwipeableRow
      onSwipeRight={rightSwipe.handler}
      swipeRightIcon={rightSwipe.icon}
      onSwipeLeft={leftSwipe.handler}
      swipeLeftIcon={leftSwipe.icon}
      enabled={!selectMode && !isEditing}
    >
      <Pressable
        ref={contextRef}
        {...paint}
        onLayout={(e) => {
          selection?.registerRowHeight(task.id, e.nativeEvent.layout.height);
        }}
        onPressIn={(e) => {
          pointerStartRef.current = {
            x: e?.nativeEvent?.pageX ?? 0,
            y: e?.nativeEvent?.pageY ?? 0,
          };
          dragDistanceRef.current = 0;
          if (onPressIn) onPressIn(pos(e));
        }}
        onPointerMove={(e: { nativeEvent?: { pageX?: number; pageY?: number } }) => {
          if (pointerStartRef.current) {
            const pageX = e?.nativeEvent?.pageX ?? 0;
            const pageY = e?.nativeEvent?.pageY ?? 0;
            const dx = pageX - pointerStartRef.current.x;
            const dy = pageY - pointerStartRef.current.y;
            dragDistanceRef.current = Math.max(dragDistanceRef.current, Math.hypot(dx, dy));
          }
        }}
        // The whole row is the open target. The button role is native-only: on web the row contains
        // action buttons, and `accessibilityRole="button"` renders a `<button>`, nesting buttons.
        accessibilityRole={Platform.OS !== "web" && canPressRow ? "button" : undefined}
        accessibilityLabel={displayTitle(task, t)}
        onPress={canPressRow ? press : undefined}
        onLongPress={
          dragLongPress
            ? () => {
                haptics.impact("medium");
                dragLongPress(task);
              }
            : longPressMenu
        }
        delayLongPress={dragLongPress ? 200 : 500}
        disabled={!canPressRow && !dragLongPress && !longPressMenu}
        style={depth > 0 ? { paddingLeft: ROW_EDGE + depth * INDENT_STEP } : undefined}
        className={
          "group relative flex-row items-center border-b border-neutral-100 dark:border-neutral-800 " +
          // `pr-9` keeps the drag grip (DraggableTaskRow.web) clear of the meta.
          (isWeb ? "pl-4 py-3 gap-3 " + (canHover ? "pr-9 " : "pr-4 ") : "px-4 py-3.5 gap-3.5 ") +
          (onOpen || selectMode ? "web:cursor-pointer " : "") +
          (!isEditing ? "web:select-none " : "") +
          (selected
            ? "bg-accent-50 dark:bg-accent-900"
            : focused
              ? "bg-neutral-100 dark:bg-neutral-800"
              : // `group-hover` too: hovering the drag grip (DraggableTaskRow.web's wrapper, outside
                // this element) shows the hover actions, whose background must match the row's.
                "web:hover:bg-neutral-50 dark:web:hover:bg-neutral-900 group-hover:bg-neutral-50 dark:group-hover:bg-neutral-900")
        }
      >
        {depth > 0 &&
          Array.from({ length: depth }).map((_, level) => (
            <View
              key={level}
              className="absolute bottom-0 top-0 w-px bg-neutral-200 dark:bg-neutral-700"
              style={{
                pointerEvents: "none",
                left: ROW_EDGE + level * INDENT_STEP + (isWeb ? 9 : 10),
              }}
            />
          ))}

        {locked && !selectMode ? (
          <View className="p-1.5 -m-1.5">
            <KeyRound size={isWeb ? 20 : 24} className="text-neutral-400" />
          </View>
        ) : (
          <GestureDetector gesture={checkboxGesture}>
            <Pressable
              accessibilityRole={selectMode ? "checkbox" : "button"}
              accessibilityState={selectMode ? { checked: selected } : undefined}
              accessibilityLabel={
                selectMode
                  ? t("selection.toggleRow")
                  : task.is_completed
                    ? t("task.reopen")
                    : t("task.complete")
              }
              onPress={(e) => {
                e?.stopPropagation?.();
                if (selectMode) {
                  if (!selection?.paintConsumeClick(task.id)) {
                    haptics.selection();
                    onSelect?.(task);
                  }
                } else {
                  if (task.is_completed) haptics.impact("light");
                  else haptics.success();
                  onToggle(task);
                }
              }}
              hitSlop={12}
              className="web:cursor-pointer p-1.5 -m-1.5"
            >
              {selectMode ? (
                <View
                  className={
                    (isWeb ? "h-5 w-5 " : "h-6 w-6 ") +
                    "items-center justify-center rounded border " +
                    (selected ? "border-accent-600 bg-accent-600" : "border-neutral-400")
                  }
                >
                  {selected && <Check size={isWeb ? 14 : 16} className="text-white" />}
                </View>
              ) : task.is_completed ? (
                <CircleCheckBig size={isWeb ? 20 : 24} className="text-accent-500" />
              ) : (
                <Circle size={isWeb ? 20 : 24} className="text-neutral-400" />
              )}
            </Pressable>
          </GestureDetector>
        )}

        {/* The title keeps at least 45% of the row: when the meta needs more, it wraps onto a line
            of its own under the title, right-aligned (`ml-auto`). */}
        <View
          className={
            isWeb
              ? "min-w-0 flex-1 flex-row flex-wrap items-center gap-x-3 gap-y-1"
              : "min-w-0 flex-1 flex-row flex-wrap items-center gap-x-3.5 gap-y-1"
          }
        >
          <View className="min-w-[45%] flex-1">
            {isEditing ? (
              <TextInput
                ref={inputRef}
                accessibilityLabel={t("task.renameTitle", "Task title")}
                value={localTitle}
                onChangeText={(text) => {
                  setLocalTitle(text);
                  setCursorSelection(undefined);
                }}
                onSelectionChange={() => {
                  setCursorSelection(undefined);
                }}
                selection={cursorSelection}
                onBlur={handleSave}
                onSubmitEditing={handleSubmit}
                onKeyPress={(e) => {
                  if (isEscapeKey(e)) {
                    handleCancel();
                  }
                }}
                autoFocus
                returnKeyType="next"
                className={
                  "py-0.5 px-0 border-b border-accent-500 bg-transparent dark:text-neutral-100 font-normal " +
                  (isWeb ? "text-sm text-neutral-900" : "text-lg text-neutral-900")
                }
              />
            ) : (
              <Text
                className={
                  (isWeb ? "text-sm " : "text-lg font-normal leading-snug ") +
                  (locked
                    ? "italic text-neutral-400"
                    : task.is_completed
                      ? "text-neutral-400 line-through"
                      : "text-neutral-800 dark:text-neutral-100") +
                  (!isEditing ? " web:select-none" : "")
                }
              >
                {displayTitle(task, t)}
              </Text>
            )}
            {firstNoteLine !== "" && (
              <Text
                numberOfLines={1}
                className={
                  isWeb ? "mt-0.5 text-xs text-neutral-400" : "mt-1 text-base text-neutral-400"
                }
              >
                {firstNoteLine}
                {hasMoreNotes ? " ..." : ""}
              </Text>
            )}
            {hasOrigin && (
              <View
                className={
                  isWeb
                    ? "mt-0.5 flex-row items-center gap-1"
                    : "mt-1 flex-row items-center gap-1.5"
                }
              >
                {origin!.project && (
                  <Text
                    numberOfLines={1}
                    className={
                      isWeb
                        ? "shrink text-xs text-neutral-400"
                        : "shrink text-base text-neutral-400"
                    }
                  >
                    {origin!.project}
                  </Text>
                )}
                {origin!.project && origin!.section && (
                  <ChevronRight
                    size={isWeb ? 11 : 14}
                    strokeWidth={2.5}
                    className="shrink-0 text-neutral-300 dark:text-neutral-600"
                  />
                )}
                {origin!.section && (
                  <Text
                    numberOfLines={1}
                    className={
                      isWeb
                        ? "shrink text-xs text-neutral-400"
                        : "shrink text-base text-neutral-400"
                    }
                  >
                    {origin!.section}
                  </Text>
                )}
              </View>
            )}
            {labelOf && task.label_ids.length > 0 && (
              <LabelChips
                labelIds={task.label_ids}
                resolve={labelOf}
                className={isWeb ? "mt-0.5" : "mt-1"}
              />
            )}
          </View>

          <View className={"ml-auto flex-row items-center " + (isWeb ? "gap-3" : "gap-3.5")}>
            {isEditing && onOpen && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.details", "Task details")}
                onPressIn={handleOpenFromEdit}
                onPress={handleOpenFromEdit}
                {...(Platform.OS === "web"
                  ? ({
                      onMouseDown: (e: { preventDefault?: () => void }) => {
                        e?.preventDefault?.();
                      },
                    } as object)
                  : undefined)}
                hitSlop={8}
                className="p-1 rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Info size={iconSize} className="text-accent-600 dark:text-accent-400" />
              </Pressable>
            )}

            {assignee && (
              <View
                accessible
                accessibilityLabel={t("task.assignedTo", { name: assignee.name })}
                style={{ backgroundColor: assignee.color.background }}
                className={
                  (isWeb ? "h-5 w-5 " : "h-6 w-6 ") + "items-center justify-center rounded-full"
                }
              >
                <Text
                  style={{ color: assignee.color.color }}
                  className={isWeb ? "text-[10px] font-medium" : "text-xs font-medium"}
                >
                  {assignee.initials}
                </Text>
              </View>
            )}

            {subtaskProgress && subtaskProgress.total > 0 && (
              <Pressable
                disabled={!onToggleExpand}
                onPress={
                  onToggleExpand
                    ? (e) => {
                        e?.stopPropagation?.();
                        onToggleExpand(task);
                      }
                    : undefined
                }
                accessible
                accessibilityLabel={t("task.subtaskProgress", {
                  done: subtaskProgress.done,
                  total: subtaskProgress.total,
                })}
                className="flex-row items-center gap-1"
              >
                <CircleCheckBig size={isWeb ? 13 : 16} className="text-neutral-400" />
                <Text
                  className={(isWeb ? "text-xs " : "text-base ") + "tabular-nums text-neutral-400"}
                >
                  {subtaskProgress.done}/{subtaskProgress.total}
                </Text>
              </Pressable>
            )}

            {task.recurrence !== null && (
              <Marker label={t("task.recurring")}>
                <Repeat size={iconSize} className="text-neutral-400" />
              </Marker>
            )}

            {hasReminder && (
              <Marker label={t("task.hasReminder")}>
                <Bell size={iconSize} className="text-neutral-400" />
              </Marker>
            )}

            {task.priority < 4 && (
              <Marker label={t("task.priority", { level: task.priority })}>
                <Flag size={iconSize} className={PRIORITY_COLOR[task.priority] ?? ""} />
              </Marker>
            )}

            {/* On wide layouts the date takes a fixed-width column, left-aligned so the markers
                pack right up against it and dates still line up across rows. A row without a date
                reserves nothing, so its markers sit at the edge. */}
            {dateMs !== null && (
              <View style={columns ? { minWidth: isWeb ? 80 : 104 } : undefined}>
                <Text
                  accessibilityLabel={
                    showCompletedAt ? t("task.completedOn", { date: formatDue(dateMs) }) : undefined
                  }
                  className={
                    (isWeb ? "text-xs " : "text-base font-normal ") +
                    (overdue && !showCompletedAt ? "text-red-500" : "text-neutral-500")
                  }
                >
                  {formatDue(dateMs)}
                </Text>
              </View>
            )}

            {onToggleExpand ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  expanded ? t("task.collapseSubtasks") : t("task.expandSubtasks")
                }
                onPress={(e) => {
                  e?.stopPropagation?.();
                  onToggleExpand(task);
                }}
                hitSlop={8}
                className="p-1 items-center justify-center rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {expanded ? (
                  <ChevronDown
                    size={isWeb ? 16 : 18}
                    className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  />
                ) : (
                  <ChevronRight
                    size={isWeb ? 16 : 18}
                    className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                  />
                )}
              </Pressable>
            ) : columns && indentGutter ? (
              <View style={{ width: (isWeb ? 16 : 18) + 8 }} />
            ) : null}
          </View>
        </View>

        {/* Out of the layout flow: it takes no room until hovered or focused, then covers the meta
            (with the row's hover background) and repeats the caret so it stays reachable. */}
        {hoverActions && (
          <View
            className={
              "absolute bottom-0 right-9 top-0 flex-row items-center gap-2 pl-3 opacity-0 group-hover:opacity-100 web:focus-within:opacity-100 " +
              // Unfocused, its background is the row's hover colour reached through the same hover
              // (and global.css's same 250ms fade). It fades from the list's opaque surface, not from
              // transparent: two half-faded layers stacked over the row would light this box up
              // ahead of the row.
              (focused
                ? "bg-neutral-100 dark:bg-neutral-800"
                : "bg-white dark:bg-zinc-950 group-hover:bg-neutral-50 dark:group-hover:bg-neutral-900 web:focus-within:bg-neutral-50 dark:web:focus-within:bg-neutral-900")
            }
          >
            {onOpen && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.details", "Task details")}
                onPress={(e) => {
                  e?.stopPropagation?.();
                  onOpen(task);
                }}
                className="web:cursor-pointer"
              >
                <Info
                  size={16}
                  className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                />
              </Pressable>
            )}
            {onSchedule && !locked && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.reschedule")}
                onPress={(e) => {
                  e?.stopPropagation?.();
                  onSchedule(task);
                }}
                className="web:cursor-pointer"
              >
                <CalendarClock
                  size={16}
                  className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                />
              </Pressable>
            )}
            {onToggleExpand && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  expanded ? t("task.collapseSubtasks") : t("task.expandSubtasks")
                }
                onPress={(e) => {
                  e?.stopPropagation?.();
                  onToggleExpand(task);
                }}
                className="p-1 rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {expanded ? (
                  <ChevronDown size={16} className="text-neutral-400" />
                ) : (
                  <ChevronRight size={16} className="text-neutral-400" />
                )}
              </Pressable>
            )}
          </View>
        )}
      </Pressable>
    </SwipeableRow>
  );
}

/** Props compared by value: lists build them fresh on every render. */
const VALUE_PROPS = new Set(["task", "origin", "assignee", "subtaskProgress"]);

/**
 * Equal plain data: primitives by `Object.is`, arrays and objects member by member. Only for the
 * small JSON-like values in {@link VALUE_PROPS}.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * The row's `memo` comparison. The store re-derives every `Task` object on any change, and lists
 * build `origin`, `assignee` and `subtaskProgress` per render, so those compare by value; every
 * other prop, callbacks included, by identity, which is why lists keep their callbacks stable.
 */
function sameRowProps(prev: Record<string, unknown>, next: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const a = prev[key];
    const b = next[key];
    if (Object.is(a, b)) continue;
    if (!VALUE_PROPS.has(key) || !sameValue(a, b)) return false;
  }
  return true;
}

export const TaskRow = memo(TaskRowView, sameRowProps);
