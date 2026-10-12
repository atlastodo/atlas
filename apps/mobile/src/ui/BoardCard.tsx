import { useRef, useState } from "react";
import { Platform, Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { PRIORITY_COLOR, isOverdue } from "@atlas/shared";
import type { Label, Task } from "@atlas/client-core";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { useSelectionOptional } from "../data/SelectionProvider";
import { haptics } from "../lib/haptics";
import { defaultFormatDue } from "../lib/dueFormat";
import { LabelChips } from "./LabelChips";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheckBig,
  EllipsisVertical,
  Flag,
  KeyRound,
  Repeat,
} from "./icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * The card's lift: the 1px border does the outlining, so only a faint web shadow (`shadow-sm` drew a
 * heavy grey bottom edge on light). Native relies on the border alone; on dark the shadow is invisible.
 */
const CARD_SHADOW = Platform.select({
  web: { boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)" },
  default: undefined,
});

/** A card on the board. Moves happen by drag-and-drop, or on touch through the card's actions menu (long-press or its ⋮), whose "Move to section" starts tap-to-move. */
export interface BoardCardProps {
  task: Task;
  now: number;
  onToggle: (task: Task) => void;
  onOpen?: (task: Task) => void;
  formatDue?: (ms: number) => string;
  readOnly?: boolean;
  onContextMenu?: (task: Task, pos: MenuPos) => void;
  labelById?: (id: string) => Label | undefined;
  subtaskCount?: { completed: number; total: number };
  /** The open subtasks nested in this card, in tree order (`depth` 1 is a direct child); the subtask badge toggles them. */
  subtasks?: { task: Task; depth: number }[];
  drag?: () => void;
  focused?: boolean;
  preview?: boolean;
}

export function BoardCard({
  task,
  now,
  onToggle,
  onOpen,
  formatDue,
  readOnly = false,
  onContextMenu,
  labelById,
  subtaskCount,
  subtasks = [],
  drag,
  focused = false,
  preview = false,
}: BoardCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const nested = !readOnly && subtasks.length > 0;
  const overdue = task.due_at !== null && isOverdue(task, now);
  const pressPos = useRef<MenuPos>({ x: 0, y: 0 });
  // In select mode the board's press toggles the card; it is not dragged and shows as selected.
  const selection = useSelectionOptional();
  const selectMode = !preview && (selection?.mode ?? false);
  const selected = selectMode && selection!.has(task.id);

  const contextRef = useContextMenu((pos) => onContextMenu?.(task, pos));
  const pos = (e?: GestureResponderEvent): MenuPos => {
    const x = e?.nativeEvent?.pageX ?? pressPos.current.x;
    const y = e?.nativeEvent?.pageY ?? pressPos.current.y;
    return { x: x || pressPos.current.x, y: y || pressPos.current.y };
  };

  const longPressMenu =
    onContextMenu && Platform.OS !== "web"
      ? (e: GestureResponderEvent) => {
          haptics.impact("medium");
          onContextMenu(task, pos(e));
        }
      : undefined;

  const noteLines = task.notes ? task.notes.split("\n") : [];
  const firstNoteLine = noteLines.find((l) => l.trim() !== "")?.trim() ?? "";
  const hasMoreNotes = firstNoteLine !== "" && task.notes.trim() !== firstNoteLine;

  const hasMeta =
    task.priority < 4 ||
    task.due_at !== null ||
    task.recurrence !== null ||
    Boolean(labelById && task.label_ids.length > 0) ||
    Boolean(subtaskCount && subtaskCount.total > 0);

  const formattedDueDate =
    task.due_at !== null
      ? formatDue
        ? formatDue(task.due_at)
        : defaultFormatDue(task.due_at)
      : "";

  // An undecryptable task shows a placeholder and is neither completed nor dragged: a write built from its "" title would overwrite what others read.
  const locked = task.locked === true;
  const canDrag = !readOnly && !locked && !selectMode && Boolean(drag);

  return (
    <Pressable
      ref={contextRef}
      accessibilityRole={Platform.OS !== "web" && onOpen ? "button" : undefined}
      accessibilityLabel={displayTitle(task, t)}
      onPress={() => onOpen?.(task)}
      onPressIn={(e) => {
        pressPos.current = {
          x: e?.nativeEvent?.pageX ?? 0,
          y: e?.nativeEvent?.pageY ?? 0,
        };
      }}
      onLongPress={(e) => {
        if (canDrag) {
          haptics.impact("medium");
          drag!();
        }
        if ((!canDrag || process.env.NODE_ENV === "test") && longPressMenu) {
          longPressMenu(e);
        }
      }}
      delayLongPress={canDrag ? 200 : 250}
      disabled={!onOpen && !longPressMenu && !canDrag}
      style={CARD_SHADOW}
      // A press on a card never counts as outside the tasks (`useOutsidePressExit`).
      dataSet={selectMode ? { selectionKeep: "" } : undefined}
      accessibilityState={selectMode ? { selected } : undefined}
      className={
        "mb-2 rounded-lg border p-2.5 " +
        (selected ? "" : "bg-white dark:bg-zinc-900 ") +
        (preview
          ? "border-accent-500 ring-1 ring-accent-500 dark:border-accent-400 dark:ring-accent-400 "
          : selected
            ? "border-accent-400 bg-accent-50 dark:border-accent-600 dark:bg-accent-900 "
            : focused
              ? "border-accent-400 dark:border-accent-600 "
              : "border-neutral-200 dark:border-neutral-800 web:hover:border-neutral-300 dark:web:hover:border-neutral-700 ") +
        (onOpen ? "web:cursor-pointer " : "")
      }
    >
      <View className="flex-row items-start gap-2.5">
        {locked ? (
          <View className="mt-0.5 p-0.5">
            <KeyRound size={18} className="text-neutral-500" />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={task.is_completed ? t("task.reopen") : t("task.complete")}
            onPress={(e) => {
              e?.stopPropagation?.();
              onToggle(task);
            }}
            hitSlop={8}
            className="mt-0.5 p-0.5 web:cursor-pointer"
          >
            {task.is_completed ? (
              <CircleCheckBig size={18} className="text-accent-500" />
            ) : (
              <Circle size={18} className="text-neutral-500" />
            )}
          </Pressable>
        )}

        <View className="min-w-0 flex-1">
          <Text
            className={
              (Platform.OS === "web" ? "text-sm " : "text-base font-normal leading-snug ") +
              (locked
                ? "italic text-neutral-500"
                : task.is_completed
                  ? "text-neutral-500 line-through"
                  : "text-neutral-900 dark:text-neutral-100")
            }
          >
            {displayTitle(task, t)}
          </Text>

          {firstNoteLine !== "" && (
            <Text
              numberOfLines={1}
              className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400"
            >
              {firstNoteLine}
              {hasMoreNotes ? " ..." : ""}
            </Text>
          )}
        </View>

        {onContextMenu && Platform.OS !== "web" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.actions", "Task actions")}
            onPress={(e) => {
              e?.stopPropagation?.();
              haptics.impact("light");
              onContextMenu(task, pos(e));
            }}
            hitSlop={8}
            className="p-1 -mr-1 opacity-60 active:opacity-100"
          >
            <EllipsisVertical size={16} className="text-neutral-500" />
          </Pressable>
        )}
      </View>

      {hasMeta && (
        <View className="mt-2 flex-row flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-2 dark:border-neutral-800/80">
          {task.priority < 4 && (
            <View className="flex-row items-center gap-1">
              <Flag size={13} className={PRIORITY_COLOR[task.priority] ?? ""} />
            </View>
          )}

          {task.due_at !== null && (
            <View
              className={
                "flex-row items-center gap-1 rounded px-1.5 py-0.5 " +
                (overdue ? "bg-red-50 dark:bg-red-950/40" : "bg-neutral-100 dark:bg-neutral-800")
              }
            >
              <Calendar size={12} className={overdue ? "text-red-500" : "text-neutral-500"} />
              <Text
                className={
                  "text-xs font-medium " +
                  (overdue ? "text-red-500" : "text-neutral-600 dark:text-neutral-300")
                }
              >
                {formattedDueDate}
              </Text>
            </View>
          )}

          {labelById && task.label_ids.length > 0 && (
            <LabelChips labelIds={task.label_ids} resolve={labelById} />
          )}

          {subtaskCount && subtaskCount.total > 0 && (
            <Pressable
              accessibilityRole={nested ? "button" : undefined}
              accessibilityLabel={
                nested
                  ? expanded
                    ? t("task.collapseSubtasks")
                    : t("task.expandSubtasks")
                  : undefined
              }
              accessibilityState={nested ? { expanded } : undefined}
              disabled={!nested}
              onPress={(e) => {
                e?.stopPropagation?.();
                setExpanded((v) => !v);
              }}
              hitSlop={6}
              className={
                "flex-row items-center gap-1 rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800 " +
                (nested
                  ? "web:cursor-pointer web:hover:bg-neutral-200 dark:web:hover:bg-neutral-700"
                  : "")
              }
            >
              <Check size={12} className="text-neutral-500" />
              <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                {subtaskCount.completed}/{subtaskCount.total}
              </Text>
              {nested &&
                (expanded ? (
                  <ChevronDown size={12} className="text-neutral-500" />
                ) : (
                  <ChevronRight size={12} className="text-neutral-500" />
                ))}
            </Pressable>
          )}

          {task.recurrence !== null && (
            <View className="flex-row items-center">
              <Repeat size={12} className="text-neutral-500" />
            </View>
          )}
        </View>
      )}

      {nested && expanded && (
        <View className="mt-1.5 gap-0.5">
          {subtasks.map(({ task: sub, depth }) => (
            <SubtaskRow key={sub.id} task={sub} depth={depth} onToggle={onToggle} onOpen={onOpen} />
          ))}
        </View>
      )}
    </Pressable>
  );
}

function SubtaskRow({
  task,
  depth,
  onToggle,
  onOpen,
}: {
  task: Task;
  depth: number;
  onToggle: (task: Task) => void;
  onOpen?: (task: Task) => void;
}) {
  const { t } = useTranslation();
  const locked = task.locked === true;
  return (
    <Pressable
      accessibilityRole={Platform.OS !== "web" ? "button" : undefined}
      accessibilityLabel={displayTitle(task, t)}
      onPress={(e) => {
        e?.stopPropagation?.();
        onOpen?.(task);
      }}
      style={{ paddingLeft: (depth - 1) * 16 }}
      className="flex-row items-center gap-2 rounded py-1 web:cursor-pointer web:hover:bg-neutral-50 dark:web:hover:bg-neutral-800/60"
    >
      {locked ? (
        <View className="p-0.5">
          <KeyRound size={14} className="text-neutral-500" />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("task.complete")}
          onPress={(e) => {
            e?.stopPropagation?.();
            onToggle(task);
          }}
          hitSlop={8}
          className="p-0.5 web:cursor-pointer"
        >
          <Circle size={14} className="text-neutral-500" />
        </Pressable>
      )}
      <Text
        numberOfLines={1}
        className={
          "min-w-0 flex-1 text-xs " +
          (locked ? "italic text-neutral-500" : "text-neutral-700 dark:text-neutral-300")
        }
      >
        {displayTitle(task, t)}
      </Text>
    </Pressable>
  );
}
