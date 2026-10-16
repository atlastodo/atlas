import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputInstance,
  type ViewInstance,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { useSheetScroll } from "./TaskDetailWebFrame";
import DateTimePicker, { type DateTimePickerEvent } from "../ui/DateTimePicker";
import type { CreateTaskInput, Priority, Task } from "@atlas/client-core";
import {
  DEFAULT_DUE_HOUR,
  DEFAULT_DUE_MINUTE,
  endOfDay,
  isAllDayTask,
  type RecurEditScope,
} from "@atlas/shared";
import { RecurrenceEditor } from "../ui/RecurrenceEditor";
import { RecurringEditModal } from "../ui/RecurringEditModal";
import { LabelPicker } from "../ui/LabelPicker";
import { ReminderSection } from "../ui/ReminderSection";
import { CommentSection } from "../ui/CommentSection";
import { AttachmentsSection } from "../ui/AttachmentsSection";
import { AssigneePicker } from "../ui/AssigneePicker";
import { FocusSection } from "../ui/FocusSection";
import { MoveToPicker } from "../ui/MoveToPicker";
import { useProjects } from "../hooks/useProjects";
import { useAllSections } from "../hooks/useAllSections";
import { useLabels } from "../hooks/useLabels";
import { usePreferences } from "../hooks/usePreferences";
import { useNow } from "../hooks/useNow";
import { QuickAdd } from "../ui/QuickAdd";
import { KeyboardPinnedTaskAdd } from "../ui/KeyboardPinnedTaskAdd";
import { isEscapeKey } from "../hooks/useCancelOnEscape";
import { useKeyboardHeight } from "../hooks/useKeyboardHeight";
import { useDismissKeyboardOnOpen } from "../hooks/useDismissKeyboardOnOpen";
import { useIsWide } from "../hooks/useIsWide";
import {
  Archive,
  CalendarClock,
  CalendarDays,
  ChevronRight,
  Circle,
  CircleCheckBig,
  Clock,
  CopyPlus,
  Flag,
  FolderInput,
  Info,
  KeyRound,
  ListChecks,
  Plus,
  Repeat,
  SkipForward,
  Tag,
  Trash2,
} from "../ui/icons";

/**
 * Edit one task: title, notes, due date and priority.
 *
 * Title and notes are buffered per field in local state and written on blur or unmount, so typing
 * does not emit one sync op per keystroke. An untouched field shows the live value and is never
 * written, so an incoming sync is not reverted on the way out and cannot clobber an edit in
 * progress. An empty title is refused. Title and notes are written immediately even on a recurring
 * task: they are not the schedule, so there is no scope prompt.
 *
 * Recurrence, reminders, assignee, comments and focus mount as self-contained sections.
 */

/** The four priority levels, highest first; P4 is "None" (no flag). */
const PRIORITIES: Priority[] = [1, 2, 3, 4];

/**
 * Apply a picked calendar date to a due instant, keeping its time of day (a task with no due date
 * starts at the beginning of the day). Pure and exported for tests.
 */
export function mergeDueDate(existingDueAt: number | null, picked: Date): number {
  const next = existingDueAt != null ? new Date(existingDueAt) : new Date(picked);
  next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
  if (existingDueAt == null) next.setHours(DEFAULT_DUE_HOUR, DEFAULT_DUE_MINUTE, 0, 0);
  return next.getTime();
}

/**
 * What a picker callback should write, or `null` for "leave the task alone". A dismissal arrives
 * through the same callback as a pick, distinguished only by `event.type`; without this guard,
 * backing out would set a due date. Pure and exported for tests.
 */
export function pickedDueDate(
  existingDueAt: number | null,
  eventType: string,
  picked: Date | undefined,
): number | null {
  if (eventType !== "set" || picked === undefined) return null;
  return mergeDueDate(existingDueAt, picked);
}

/** Apply a picked time of day to a due instant, keeping its date (today if none). */
function mergeDueTime(existingDueAt: number | null, picked: Date): number {
  const next = existingDueAt != null ? new Date(existingDueAt) : new Date();
  next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  return next.getTime();
}

/** What a time picker callback should write, or `null` for "leave the task alone". */
function pickedDueTime(
  existingDueAt: number | null,
  eventType: string,
  picked: Date | undefined,
): number | null {
  if (eventType !== "set" || picked === undefined) return null;
  return mergeDueTime(existingDueAt, picked);
}

function formatTimeOnly(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
}

/** Priority to flag colour. */
const PRIORITY_COLOR: Record<number, string> = {
  1: "text-red-500",
  2: "text-orange-500",
  3: "text-blue-500",
};

export interface TaskDetailScreenProps {
  task: Task;
  isWide?: boolean;
  onUpdate: (task: Task, patch: Partial<Task>) => void;
  onUpdateRecurring?: (task: Task, patch: Partial<Task>, scope: RecurEditScope) => void;
  onToggle?: (task: Task) => void;
  formatDue?: (ms: number) => string;
  onArchive?: () => void;
  onDelete?: () => void;
  /** Duplicate the task (create an open copy); the screen stays on the original. */
  onDuplicate?: () => void;
  /** Skip this occurrence of a recurring task. Absent means no Skip button. */
  onSkip?: () => void;
  subtasks?: Task[];
  onOpenSubtask?: (task: Task) => void;
  onToggleSubtask?: (task: Task) => void;
  onAddSubtask?: (input: CreateTaskInput) => void | string;
  onRequestAddSubtask?: () => void;
  isSubtaskModalOpen?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onRegisterDiscard?: (fn: () => void) => void;
  onRegisterSaveAndClose?: (fn: () => void) => void;
}

// The detail's scroll view is a Reanimated component, which NativeWind does not style: plain styles.
const SCROLL_STYLE = { flex: 1 } as const;
const WEB_CONTENT = { paddingHorizontal: 24, paddingVertical: 20, alignItems: "center" } as const;
const NATIVE_CONTENT = { padding: 16 } as const;

/** The title/notes the user has typed and not yet written; an absent field was not touched. */
interface TextDraft {
  title?: string;
  notes?: string;
}

/** The write a draft makes against `task`: its edited fields that differ from the current values. */
function draftPatch(task: Task, draft: TextDraft): Partial<Task> {
  const patch: Partial<Task> = {};
  const title = draft.title?.trim();
  if (title && title !== task.title) patch.title = title;
  if (draft.notes !== undefined && draft.notes !== task.notes) patch.notes = draft.notes;
  return patch;
}

function defaultFormatDue(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function TaskDetailScreen({
  task,
  isWide: propIsWide,
  onUpdate,
  onUpdateRecurring,
  onToggle,
  formatDue = defaultFormatDue,
  onArchive,
  onDelete,
  onDuplicate,
  onSkip,
  subtasks = [],
  onOpenSubtask,
  onToggleSubtask,
  onAddSubtask,
  onRequestAddSubtask,
  isSubtaskModalOpen: propIsSubtaskModalOpen,
  onDirtyChange,
  onRegisterDiscard,
  onRegisterSaveAndClose,
}: TaskDetailScreenProps) {
  const { t } = useTranslation();
  const detectedWide = useIsWide();
  const isWide = propIsWide ?? detectedWide;
  const { projects } = useProjects();
  const allSections = useAllSections();
  const { labels, createLabel } = useLabels();
  const { timezone, smartDatesEnabled } = usePreferences();
  const now = useNow();
  const [draft, setDraftState] = useState<TextDraft>({});
  // Updated in the same event as the keystroke: a blur, close or unmount can precede the re-render and must still save it.
  const draftRef = useRef(draft);
  const setDraft = useCallback((next: TextDraft) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const editDraft = (field: keyof TextDraft, value: string | undefined) =>
    setDraft({ ...draftRef.current, [field]: value });
  const taskRef = useRef(task);
  taskRef.current = task;
  const title = draft.title ?? task.title;
  const notes = draft.notes ?? task.notes;
  const [subtaskHasDraft, setSubtaskHasDraft] = useState(false);
  const [subtaskModalOpen, setSubtaskModalOpen] = useState(false);
  const isModalOpen = propIsSubtaskModalOpen ?? subtaskModalOpen;

  const titleRef = useRef<TextInputInstance>(null);
  const notesRef = useRef<TextInputInstance>(null);
  const [inputsBlocked, setInputsBlocked] = useState(false);
  const subtaskModalJustClosedRef = useRef(false);
  const subtaskCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      dismissTimersRef.current.forEach(clearTimeout);
      dismissTimersRef.current = [];
      if (subtaskCloseTimerRef.current) clearTimeout(subtaskCloseTimerRef.current);
    };
  }, []);

  const dismissAndBlurTaskInputs = useCallback(() => {
    subtaskModalJustClosedRef.current = true;
    titleRef.current?.blur();
    notesRef.current?.blur();
    Keyboard.dismiss();
    dismissTimersRef.current.push(
      setTimeout(() => {
        titleRef.current?.blur();
        notesRef.current?.blur();
        Keyboard.dismiss();
      }, 50),
    );
    dismissTimersRef.current.push(
      setTimeout(() => {
        titleRef.current?.blur();
        notesRef.current?.blur();
        Keyboard.dismiss();
      }, 150),
    );
  }, []);

  const handleOpenSubtaskAdd = useCallback(() => {
    titleRef.current?.blur();
    notesRef.current?.blur();
    commitRef.current();

    if (onRequestAddSubtask) {
      onRequestAddSubtask();
    } else {
      setSubtaskModalOpen(true);
    }
  }, [onRequestAddSubtask]);

  const prevModalOpenRef = useRef(isModalOpen);
  useEffect(() => {
    if (prevModalOpenRef.current && !isModalOpen) {
      setInputsBlocked(true);
      dismissAndBlurTaskInputs();
      if (subtaskCloseTimerRef.current) clearTimeout(subtaskCloseTimerRef.current);
      subtaskCloseTimerRef.current = setTimeout(() => {
        setInputsBlocked(false);
        subtaskModalJustClosedRef.current = false;
      }, 350);
    }
    prevModalOpenRef.current = isModalOpen;
  }, [isModalOpen, dismissAndBlurTaskInputs]);

  const discardedRef = useRef(false);
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [picking, setPicking] = useState<"start_at" | "due_at" | "start_time" | "due_time" | null>(
    null,
  );
  const [moving, setMoving] = useState(false);
  const [pendingRecurringPatch, setPendingRecurringPatch] = useState<Partial<Task> | null>(null);

  const resolveLabels = useCallback(
    (names: string[]) =>
      names
        .map((name) => {
          const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
          return existing ? existing.id : null;
        })
        .filter((id): id is string => id != null),
    [labels],
  );

  const subtaskDefaults = useMemo(
    () => ({
      parent_id: task.id,
      project_id: task.project_id,
      section_id: task.section_id,
    }),
    [task.id, task.project_id, task.section_id],
  );

  const handleAddSubtask = useCallback(
    (input: CreateTaskInput) => {
      return onAddSubtask?.({
        ...input,
        parent_id: task.id,
        project_id: task.project_id,
        section_id: task.section_id,
      });
    },
    [onAddSubtask, task.id, task.project_id, task.section_id],
  );

  const applyUpdate = useCallback(
    (t: Task, patch: Partial<Task>) => {
      // A recurrence-rule edit is a series edit by definition, so it skips the scope prompt.
      if (t.recurrence && onUpdateRecurring && patch.recurrence === undefined) {
        setPendingRecurringPatch(patch);
        return;
      }
      onUpdate(t, patch);
    },
    [onUpdate, onUpdateRecurring],
  );

  const isDirty = Object.keys(draftPatch(task, draft)).length > 0 || subtaskHasDraft;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Writes only drafted fields that differ from the task; empty titles are ignored.
  const commit = () => {
    if (discardedRef.current) return;
    const current = taskRef.current;
    const patch = draftPatch(current, draftRef.current);
    setDraft({});
    if (Object.keys(patch).length > 0) onUpdate(current, patch);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    onRegisterDiscard?.(() => {
      discardedRef.current = true;
      setDraft({});
      setSubtaskHasDraft(false);
      setPendingRecurringPatch(null);
    });
  }, [onRegisterDiscard, setDraft]);

  useEffect(() => {
    onRegisterSaveAndClose?.(() => {
      discardedRef.current = false;
      commitRef.current();
    });
  }, [onRegisterSaveAndClose]);

  const projectName = task.project_id
    ? (projects.find((p) => p.id === task.project_id)?.name ?? t("moveTo.inbox"))
    : t("moveTo.inbox");
  const sectionName = task.section_id ? allSections.byId(task.section_id)?.name : undefined;

  const rootRef = useRef<ViewInstance>(null);
  useDismissKeyboardOnOpen(rootRef);

  // Flush the current buffer through the ref: navigating back unmounts without a blur.
  useEffect(() => {
    return () => {
      if (!discardedRef.current) {
        commitRef.current();
      }
    };
  }, []);

  const subtasksDone = subtasks.filter((s) => s.is_completed).length;

  const onPickDate =
    (field: "start_at" | "due_at") => (event: DateTimePickerEvent, date?: Date) => {
      // One event ends the pick on every platform; leaving iOS's inline picker mounted re-seeded it mid-entry.
      setPicking(null);
      const next = pickedDueDate(task[field], event.type, date);
      if (next !== null) applyUpdate(task, { [field]: next });
    };

  const onPickTime =
    (field: "start_at" | "due_at") => (event: DateTimePickerEvent, date?: Date) => {
      setPicking(null);
      const next = pickedDueTime(task[field], event.type, date);
      if (next !== null) applyUpdate(task, { [field]: next });
    };

  const keyboardHeight = useKeyboardHeight();
  const sheetScroll = useSheetScroll();

  const isWeb = Platform.OS === "web";
  const withSheetGesture = (element: React.ReactElement) =>
    sheetScroll?.composedGesture ? (
      <GestureDetector gesture={sheetScroll.composedGesture}>{element}</GestureDetector>
    ) : (
      element
    );

  if (task.locked) {
    // Undecryptable here: every value would be a placeholder and any edit would overwrite what
    // readers see. Show the reason and the subtasks, with no edit affordances.
    return withSheetGesture(
      <Animated.ScrollView
        showsVerticalScrollIndicator={false}
        style={SCROLL_STYLE}
        contentContainerStyle={isWeb ? WEB_CONTENT : NATIVE_CONTENT}
        scrollEventThrottle={16}
        onScroll={sheetScroll?.scrollHandler}
        animatedProps={sheetScroll?.scrollAnimatedProps}
      >
        <View
          ref={rootRef}
          className={isWeb ? "w-full max-w-[460px] self-center gap-5" : "w-full gap-6"}
        >
          <View className="gap-2">
            <View className="flex-row items-center gap-2">
              <KeyRound size={isWeb ? 18 : 20} className="text-neutral-500" />
              <Text className={"flex-1 italic text-neutral-500 " + (isWeb ? "text-lg" : "text-xl")}>
                {t("task.lockedTitle")}
              </Text>
            </View>
            <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
              {t("taskDetail.lockedHint")}
            </Text>
          </View>
          {subtasks.length > 0 && (
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ListChecks size={isWeb ? 16 : 18} className="text-neutral-500" />
                <Text
                  className={
                    "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
                  }
                >
                  {t("taskDetail.subtasks")}
                </Text>
              </View>
              {subtasks.map((sub) => (
                <SubtaskRow
                  key={sub.id}
                  task={sub}
                  toggleLabel={sub.is_completed ? t("task.reopen") : t("task.complete")}
                  onToggle={() => onToggleSubtask?.(sub)}
                  onOpen={onOpenSubtask ? () => onOpenSubtask(sub) : undefined}
                />
              ))}
            </View>
          )}
        </View>
      </Animated.ScrollView>,
    );
  }

  const heroSection = (
    <View className="gap-2.5">
      <View className="flex-row items-start gap-3">
        {onToggle && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={task.is_completed ? t("task.reopen") : t("task.complete")}
            onPress={() => onToggle(task)}
            hitSlop={8}
            className="mt-1"
          >
            {task.is_completed ? (
              <CircleCheckBig size={24} className="text-accent-500" />
            ) : (
              <Circle size={24} className="text-neutral-500 dark:text-neutral-600" />
            )}
          </Pressable>
        )}
        <TextInput
          ref={titleRef}
          editable={!inputsBlocked}
          accessibilityLabel={t("taskDetail.title")}
          value={title}
          onChangeText={(text) => editDraft("title", text)}
          multiline
          onFocus={() => {
            if (inputsBlocked || subtaskModalJustClosedRef.current) {
              titleRef.current?.blur();
              Keyboard.dismiss();
              return;
            }
          }}
          onBlur={() => {
            if (draftRef.current.title?.trim() === "") editDraft("title", undefined);
            else commit();
          }}
          className={
            "flex-1 font-semibold text-neutral-900 dark:text-neutral-100 " +
            (task.is_completed ? "line-through text-neutral-500 dark:text-neutral-400 " : "") +
            (isWide ? "text-2xl font-bold" : isWeb ? "text-lg" : "text-xl font-bold")
          }
        />
      </View>

      <View className="gap-1.5">
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-xs font-semibold")
          }
        >
          {t("taskDetail.notes")}
        </Text>
        <TextInput
          ref={notesRef}
          editable={!inputsBlocked}
          accessibilityLabel={t("taskDetail.notes")}
          value={notes}
          onChangeText={(text) => editDraft("notes", text)}
          onFocus={() => {
            if (inputsBlocked || subtaskModalJustClosedRef.current) {
              notesRef.current?.blur();
              Keyboard.dismiss();
              return;
            }
          }}
          onBlur={commit}
          multiline
          numberOfLines={isWide ? 4 : 3}
          textAlignVertical="top"
          placeholder={t("taskDetail.notesPlaceholder")}
          placeholderTextColor="#737373"
          className={
            (isWide ? "min-h-24 " : "min-h-20 ") +
            "rounded-xl border border-neutral-200 px-3.5 py-2.5 text-neutral-900 dark:border-neutral-800 dark:text-neutral-100 " +
            (isWeb ? "text-sm " : "text-base ") +
            "focus:border-accent-500 dark:focus:border-accent-400"
          }
        />
      </View>
    </View>
  );

  const quickPropertiesRibbon = (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="flex-row py-0.5 -mx-1"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}
    >
      {/* Due date pill */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          task.due_at != null
            ? t("taskDetail.dueOn", { date: formatDue(task.due_at) })
            : t("taskDetail.dueDate")
        }
        onPress={() => setPicking("due_at")}
        className={
          "flex-row items-center gap-1.5 rounded-lg border px-3 py-1.5 " +
          (task.due_at != null
            ? task.due_at < Date.now() && !task.is_completed
              ? "border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40"
              : "border-accent-200 bg-accent-50 dark:border-accent-900 dark:bg-accent-950"
            : "border-neutral-200 bg-neutral-100/80 dark:border-neutral-800 dark:bg-neutral-900/60")
        }
      >
        <CalendarDays
          size={14}
          className={
            task.due_at != null
              ? task.due_at < Date.now() && !task.is_completed
                ? "text-red-500"
                : "text-accent-600 dark:text-accent-400"
              : "text-neutral-500"
          }
        />
        <Text
          className={
            "text-xs font-medium " +
            (task.due_at != null
              ? task.due_at < Date.now() && !task.is_completed
                ? "text-red-600 dark:text-red-400 font-semibold"
                : "text-accent-700 dark:text-accent-300 font-semibold"
              : "text-neutral-700 dark:text-neutral-300")
          }
        >
          {task.due_at != null
            ? t("taskDetail.dueOn", { date: formatDue(task.due_at) })
            : `+ ${t("taskDetail.dueDate")}`}
        </Text>
      </Pressable>

      {/* Priority pill */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Priority: ${task.priority === 4 ? t("taskDetail.priorityNone") : `P${task.priority}`}`}
        onPress={() => {
          const next: Priority = task.priority === 4 ? 1 : ((task.priority + 1) as Priority);
          applyUpdate(task, { priority: next });
        }}
        className={
          "flex-row items-center gap-1.5 rounded-lg border px-3 py-1.5 " +
          (task.priority === 1
            ? "border-red-200 bg-red-50 dark:border-red-900/60 dark:bg-red-950/40"
            : task.priority === 2
              ? "border-orange-200 bg-orange-50 dark:border-orange-900/60 dark:bg-orange-950/40"
              : task.priority === 3
                ? "border-blue-200 bg-blue-50 dark:border-blue-900/60 dark:bg-blue-950/40"
                : "border-neutral-200 bg-neutral-100/80 dark:border-neutral-800 dark:bg-neutral-900/60")
        }
      >
        <Flag size={14} className={PRIORITY_COLOR[task.priority] ?? "text-neutral-500"} />
        <Text
          className={
            "text-xs font-medium " +
            (task.priority === 1
              ? "text-red-600 dark:text-red-400 font-semibold"
              : task.priority === 2
                ? "text-orange-600 dark:text-orange-400 font-semibold"
                : task.priority === 3
                  ? "text-blue-600 dark:text-blue-400 font-semibold"
                  : "text-neutral-700 dark:text-neutral-300")
          }
        >
          {task.priority === 4 ? t("taskDetail.priorityNone") : `P${task.priority}`}
        </Text>
      </Pressable>

      {/* Project pill */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("moveTo.title")}
        onPress={() => setMoving(true)}
        className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-100/80 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-900/60"
      >
        <FolderInput size={14} className="text-neutral-500" />
        <Text
          className="max-w-[140px] text-xs font-medium text-neutral-700 dark:text-neutral-300"
          numberOfLines={1}
        >
          {sectionName ? `${projectName} / ${sectionName}` : projectName}
        </Text>
      </Pressable>

      {/* Start date pill */}
      {task.start_at != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("taskDetail.startsOn", { date: formatDue(task.start_at) })}
          onPress={() => setPicking("start_at")}
          className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-100/80 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-900/60"
        >
          <CalendarClock size={14} className="text-neutral-500" />
          <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {t("taskDetail.startsOn", { date: formatDue(task.start_at) })}
          </Text>
        </Pressable>
      )}

      {/* Recurrence pill */}
      {task.recurrence && (
        <View className="flex-row items-center gap-1.5 rounded-lg border border-accent-200 bg-accent-50 px-3 py-1.5 dark:border-accent-900 dark:bg-accent-950">
          <Repeat size={14} className="text-accent-600 dark:text-accent-400" />
          <Text className="text-xs font-medium text-accent-700 dark:text-accent-300">
            {t("recurrence.repeat")}
          </Text>
        </View>
      )}

      {/* Labels pill */}
      {task.label_ids.length > 0 && (
        <View className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 bg-neutral-100/80 px-3 py-1.5 dark:border-neutral-800 dark:bg-neutral-900/60">
          <Tag size={14} className="text-neutral-500" />
          <Text className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            {task.label_ids.length} {t("label.heading")}
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const subtasksSection = onAddSubtask ? (
    <View className="gap-2.5 rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-neutral-800 dark:bg-neutral-900/40">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <ListChecks size={isWeb ? 16 : 18} className="text-neutral-500" />
          <Text
            className={
              "font-semibold text-neutral-800 dark:text-neutral-200 " +
              (isWeb ? "text-xs" : "text-sm font-semibold")
            }
          >
            {t("taskDetail.subtasks")}
          </Text>
          {subtasks.length > 0 && (
            <Text
              className={
                (isWeb ? "text-xs " : "text-sm ") + "font-mono tabular-nums text-neutral-500"
              }
            >
              {subtasksDone}/{subtasks.length}
            </Text>
          )}
        </View>
        {subtasks.length > 0 && (
          <Text className="text-xs font-semibold text-accent-600 dark:text-accent-400">
            {Math.round((subtasksDone / subtasks.length) * 100)}%
          </Text>
        )}
      </View>

      {/* Visual Progress Bar */}
      {subtasks.length > 0 && (
        <View className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <View
            style={{
              width: `${Math.round((subtasksDone / subtasks.length) * 100)}%`,
            }}
            className="h-full rounded-full bg-accent-500"
          />
        </View>
      )}

      {subtasks.map((sub) => (
        <SubtaskRow
          key={sub.id}
          task={sub}
          toggleLabel={sub.is_completed ? t("task.reopen") : t("task.complete")}
          onToggle={() => onToggleSubtask?.(sub)}
          onOpen={onOpenSubtask ? () => onOpenSubtask(sub) : undefined}
          isEditing={editingSubtaskId === sub.id}
          onStartRename={() => setEditingSubtaskId(sub.id)}
          onSaveRename={(newTitle) => {
            if (newTitle !== sub.title) onUpdate(sub, { title: newTitle });
            setEditingSubtaskId(null);
          }}
          onSubmitRenameAndAddBelow={(newTitle) => {
            if (newTitle !== sub.title) onUpdate(sub, { title: newTitle });
            setEditingSubtaskId(null);
          }}
          onCancelRename={() => setEditingSubtaskId(null)}
        />
      ))}

      {isWeb || isWide ? (
        <View className="pt-1 border-t border-neutral-200/60 dark:border-neutral-800/60">
          <QuickAdd
            onAdd={handleAddSubtask}
            defaults={subtaskDefaults}
            placeholder={t("taskDetail.addSubtask")}
            accessibilityLabel={t("taskDetail.addSubtask")}
            onDraftChange={setSubtaskHasDraft}
            labels={labels}
            resolveLabels={resolveLabels}
            onCreateLabel={createLabel}
            smartDates={smartDatesEnabled}
            projects={task.project_id ? projects.filter((p) => p.id === task.project_id) : []}
            sections={
              task.project_id
                ? allSections.sections.filter((s) => s.project_id === task.project_id)
                : []
            }
            now={now}
            timeZone={timezone || undefined}
            formatDue={formatDue}
          />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("taskDetail.addSubtask")}
          onPress={handleOpenSubtaskAdd}
          className="w-full min-w-0 flex-row items-center gap-2 pt-2.5 pb-1 border-t border-neutral-200/60 dark:border-neutral-800/60 web:cursor-pointer"
        >
          <Plus size={18} className="text-neutral-500 shrink-0" />
          <Text numberOfLines={1} className="flex-1 min-w-0 text-base font-normal text-neutral-500">
            {t("taskDetail.addSubtask")}
          </Text>
        </Pressable>
      )}
    </View>
  ) : null;

  const startDateSection = (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <CalendarClock size={isWeb ? 16 : 18} className="text-neutral-500" />
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {t("taskDetail.startDate")}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("taskDetail.startDate")}
          onPress={() => setPicking("start_at")}
          className="flex-1 min-w-[130px] rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-700"
        >
          <Text
            className={
              (isWeb ? "text-sm " : "text-base ") + "text-neutral-900 dark:text-neutral-100"
            }
          >
            {task.start_at != null ? formatDue(task.start_at) : t("task.scheduleNoDate")}
          </Text>
        </Pressable>
        {task.start_at != null && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isAllDayTask(task.start_at) ? t("task.addDueTime") : t("task.changeDueTime")
              }
              onPress={() => setPicking("start_time")}
              className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
            >
              <Clock size={isWeb ? 14 : 16} className="text-neutral-500" />
              <Text
                className={
                  (isWeb ? "text-sm " : "text-base ") +
                  "font-medium text-neutral-900 dark:text-neutral-100"
                }
              >
                {isAllDayTask(task.start_at) ? t("task.allDay") : formatTimeOnly(task.start_at)}
              </Text>
            </Pressable>
            {!isAllDayTask(task.start_at) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.makeAllDay")}
                onPress={() => applyUpdate(task, { start_at: endOfDay(task.start_at!) })}
                className="rounded-lg border border-neutral-200 px-2.5 py-2.5 dark:border-neutral-700"
              >
                <Text className={(isWeb ? "text-xs " : "text-sm ") + "text-neutral-500"}>
                  {t("task.allDay")}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.setTime")}
                onPress={() =>
                  // 9:00, not the 23:59 default, which would leave the task all-day.
                  applyUpdate(task, {
                    start_at: new Date(new Date(task.start_at!).setHours(9, 0, 0, 0)).getTime(),
                  })
                }
                className="rounded-lg border border-neutral-200 px-2.5 py-2.5 dark:border-neutral-700"
              >
                <Text className={(isWeb ? "text-xs " : "text-sm ") + "text-neutral-500"}>
                  {t("task.setTime")}
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("task.scheduleNoDate")}
              onPress={() => applyUpdate(task, { start_at: null })}
              className="rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-700"
            >
              <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
                {t("common.clear")}
              </Text>
            </Pressable>
          </>
        )}
      </View>
      {picking === "start_at" && (
        <DateTimePicker
          value={task.start_at != null ? new Date(task.start_at) : new Date()}
          mode="date"
          onChange={onPickDate("start_at")}
        />
      )}
      {picking === "start_time" && (
        <DateTimePicker
          value={
            task.start_at != null && !isAllDayTask(task.start_at)
              ? new Date(task.start_at)
              : new Date(
                  new Date(task.start_at ?? Date.now()).setHours(
                    DEFAULT_DUE_HOUR,
                    DEFAULT_DUE_MINUTE,
                    0,
                    0,
                  ),
                )
          }
          mode="time"
          onChange={onPickTime("start_at")}
        />
      )}
    </View>
  );

  const dueDateSection = (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <CalendarDays size={isWeb ? 16 : 18} className="text-neutral-500" />
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {t("taskDetail.dueDate")}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("task.scheduleMore")}
          onPress={() => setPicking("due_at")}
          className="flex-1 min-w-[130px] rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-700"
        >
          <Text
            className={
              (isWeb ? "text-sm " : "text-base ") + "text-neutral-900 dark:text-neutral-100"
            }
          >
            {task.due_at != null ? formatDue(task.due_at) : t("task.scheduleNoDate")}
          </Text>
        </Pressable>
        {task.due_at != null && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isAllDayTask(task.due_at) ? t("task.addDueTime") : t("task.changeDueTime")
              }
              onPress={() => setPicking("due_time")}
              className="flex-row items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-700"
            >
              <Clock size={isWeb ? 14 : 16} className="text-neutral-500" />
              <Text
                className={
                  (isWeb ? "text-sm " : "text-base ") +
                  "font-medium text-neutral-900 dark:text-neutral-100"
                }
              >
                {isAllDayTask(task.due_at) ? t("task.allDay") : formatTimeOnly(task.due_at)}
              </Text>
            </Pressable>
            {!isAllDayTask(task.due_at) ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.makeAllDay")}
                onPress={() => applyUpdate(task, { due_at: endOfDay(task.due_at!) })}
                className="rounded-lg border border-neutral-200 px-2.5 py-2.5 dark:border-neutral-700"
              >
                <Text className={(isWeb ? "text-xs " : "text-sm ") + "text-neutral-500"}>
                  {t("task.allDay")}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("task.setTime")}
                onPress={() =>
                  // 9:00, not the 23:59 default, which would leave the task all-day.
                  applyUpdate(task, {
                    due_at: new Date(new Date(task.due_at!).setHours(9, 0, 0, 0)).getTime(),
                  })
                }
                className="rounded-lg border border-neutral-200 px-2.5 py-2.5 dark:border-neutral-700"
              >
                <Text className={(isWeb ? "text-xs " : "text-sm ") + "text-neutral-500"}>
                  {t("task.setTime")}
                </Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("task.scheduleNoDate")}
              onPress={() => applyUpdate(task, { due_at: null })}
              className="rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-700"
            >
              <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
                {t("common.clear")}
              </Text>
            </Pressable>
          </>
        )}
      </View>
      {picking === "due_at" && (
        <DateTimePicker
          value={
            task.due_at != null
              ? new Date(task.due_at)
              : new Date(new Date().setHours(DEFAULT_DUE_HOUR, DEFAULT_DUE_MINUTE, 0, 0))
          }
          mode="date"
          onChange={onPickDate("due_at")}
        />
      )}
      {picking === "due_time" && (
        <DateTimePicker
          value={
            task.due_at != null && !isAllDayTask(task.due_at)
              ? new Date(task.due_at)
              : new Date(
                  new Date(task.due_at ?? Date.now()).setHours(
                    DEFAULT_DUE_HOUR,
                    DEFAULT_DUE_MINUTE,
                    0,
                    0,
                  ),
                )
          }
          mode="time"
          onChange={onPickTime("due_at")}
        />
      )}
    </View>
  );

  const prioritySection = (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Flag size={isWeb ? 16 : 18} className="text-neutral-500" />
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {t("taskDetail.priority")}
        </Text>
      </View>
      <View accessibilityRole="radiogroup" className="flex-row gap-2">
        {PRIORITIES.map((level) => {
          const active = task.priority === level;
          const label = level === 4 ? t("taskDetail.priorityNone") : `P${level}`;
          return (
            <Pressable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={label}
              onPress={() => applyUpdate(task, { priority: level })}
              className={
                "flex-1 flex-row items-center justify-center gap-1.5 rounded-lg border px-3 py-2.5 " +
                (active
                  ? "border-accent-500 bg-accent-50 dark:bg-accent-900"
                  : "border-neutral-200 dark:border-neutral-800")
              }
            >
              {level < 4 && <Flag size={isWeb ? 14 : 16} className={PRIORITY_COLOR[level] ?? ""} />}
              <Text
                className={
                  (isWeb ? "text-xs " : "text-sm font-medium ") +
                  (active ? "text-accent-700 dark:text-accent-300" : "text-neutral-500")
                }
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const projectSection = (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <FolderInput size={isWeb ? 16 : 18} className="text-neutral-500" />
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {t("taskDetail.project")}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("moveTo.title")}
        onPress={() => setMoving(true)}
        className="flex-row items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800 web:cursor-pointer"
      >
        <Text
          className={
            (isWeb ? "text-sm " : "text-base ") + "flex-1 text-neutral-900 dark:text-neutral-100"
          }
        >
          {sectionName ? `${projectName} / ${sectionName}` : projectName}
        </Text>
        <ChevronRight size={16} className="text-neutral-500" />
      </Pressable>
    </View>
  );

  const recurrenceSection = (
    <View className="gap-2">
      <RecurrenceEditor
        value={task.recurrence}
        onChange={(rule) => applyUpdate(task, { recurrence: rule })}
      />
    </View>
  );

  const labelsSection = (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Tag size={isWeb ? 16 : 18} className="text-neutral-500" />
        <Text
          className={
            "font-medium text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
          }
        >
          {t("label.heading")}
        </Text>
      </View>
      <LabelPicker
        labelIds={task.label_ids}
        onChange={(ids) => applyUpdate(task, { label_ids: ids })}
      />
    </View>
  );

  const actionButtonsSection =
    onArchive || onDelete || onDuplicate || onSkip ? (
      <View className="mt-2 flex-row flex-wrap items-center gap-2">
        {onSkip && !task.is_completed && task.recurrence && task.due_at != null && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.skipOccurrence")}
            onPress={onSkip}
            className="flex-row items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800 web:cursor-pointer"
          >
            <SkipForward size={16} className="text-neutral-500" />
            <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
              {t("task.skipOccurrence")}
            </Text>
          </Pressable>
        )}
        {onDuplicate && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.duplicate")}
            onPress={onDuplicate}
            className="flex-row items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800 web:cursor-pointer"
          >
            <CopyPlus size={16} className="text-neutral-500" />
            <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
              {t("common.duplicate")}
            </Text>
          </Pressable>
        )}
        {onArchive && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.archive")}
            onPress={onArchive}
            className="flex-row items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800 web:cursor-pointer"
          >
            <Archive size={16} className="text-neutral-500" />
            <Text className={(isWeb ? "text-sm " : "text-base ") + "text-neutral-500"}>
              {t("common.archive")}
            </Text>
          </Pressable>
        )}
        {onDelete && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.delete")}
            onPress={onDelete}
            className="flex-row items-center gap-2 rounded-lg border border-neutral-200 px-4 py-2.5 dark:border-neutral-800 web:cursor-pointer"
          >
            <Trash2 size={16} className="text-red-500" />
            <Text className={(isWeb ? "text-sm " : "text-base ") + "text-red-500"}>
              {t("common.delete")}
            </Text>
          </Pressable>
        )}
      </View>
    ) : null;

  const scrollElement = (
    <Animated.ScrollView
      showsVerticalScrollIndicator={false}
      style={SCROLL_STYLE}
      contentContainerStyle={[
        isWide
          ? { paddingHorizontal: 28, paddingVertical: 24 }
          : isWeb
            ? WEB_CONTENT
            : NATIVE_CONTENT,
        { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 40 : 24 },
      ]}
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={16}
      onScroll={sheetScroll?.scrollHandler}
      animatedProps={sheetScroll?.scrollAnimatedProps}
    >
      <View
        ref={rootRef}
        focusable={true}
        className={
          isWide
            ? "w-full gap-6"
            : isWeb
              ? "w-full max-w-[460px] self-center gap-5"
              : "w-full gap-6"
        }
      >
        {isWide ? (
          <View className="w-full flex-row items-start gap-8">
            {/* Left Column: Hero, Subtasks, Attachments, Comments */}
            <View className="flex-1 min-w-0 gap-6">
              {heroSection}
              {subtasksSection}
              <AttachmentsSection task={task} />
              <CommentSection task={task} />
            </View>

            {/* Right Column: Properties Sidebar */}
            <View className="w-[320px] shrink-0 gap-5 border-l border-neutral-200 pl-6 dark:border-neutral-800">
              <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                {t("taskDetail.properties")}
              </Text>
              {projectSection}
              {dueDateSection}
              {startDateSection}
              {prioritySection}
              {labelsSection}
              {recurrenceSection}
              <ReminderSection task={task} />
              <AssigneePicker task={task} onUpdate={applyUpdate} />
              <FocusSection task={task} onUpdate={applyUpdate} />
              {actionButtonsSection}
            </View>
          </View>
        ) : (
          <>
            {heroSection}
            {quickPropertiesRibbon}
            {subtasksSection}
            {startDateSection}
            {dueDateSection}
            {prioritySection}
            {projectSection}
            {recurrenceSection}
            {labelsSection}
            <AssigneePicker task={task} onUpdate={applyUpdate} />
            <FocusSection task={task} onUpdate={applyUpdate} />
            <ReminderSection task={task} />
            <AttachmentsSection task={task} />
            <CommentSection task={task} />
            {actionButtonsSection}
          </>
        )}
      </View>

      <MoveToPicker
        title={moving ? task.title : null}
        projects={projects}
        sections={allSections.sections}
        currentProjectId={task.project_id}
        currentSectionId={task.section_id}
        onPick={(target) => {
          applyUpdate(task, { project_id: target.project_id, section_id: target.section_id });
          setMoving(false);
        }}
        onClose={() => setMoving(false)}
      />

      <RecurringEditModal
        visible={pendingRecurringPatch !== null}
        onThisTask={() => {
          if (pendingRecurringPatch && onUpdateRecurring) {
            onUpdateRecurring(task, pendingRecurringPatch, "this_occurrence");
          }
          setPendingRecurringPatch(null);
        }}
        onAllTasks={() => {
          if (pendingRecurringPatch && onUpdateRecurring) {
            onUpdateRecurring(task, pendingRecurringPatch, "all_occurrences");
          } else if (pendingRecurringPatch) {
            onUpdate(task, pendingRecurringPatch);
          }
          setPendingRecurringPatch(null);
        }}
        onCancel={() => setPendingRecurringPatch(null)}
      />
    </Animated.ScrollView>
  );

  return (
    <>
      {withSheetGesture(scrollElement)}
      {Platform.OS !== "web" && !isWide && !onRequestAddSubtask && onAddSubtask && (
        <KeyboardPinnedTaskAdd
          visible={subtaskModalOpen}
          onClose={() => {
            dismissAndBlurTaskInputs();
            setSubtaskModalOpen(false);
          }}
          onAdd={handleAddSubtask}
          defaults={subtaskDefaults}
          placeholder={t("taskDetail.addSubtask")}
          accessibilityLabel={t("taskDetail.addSubtask")}
          hasBottomNav={false}
          labels={labels}
          resolveLabels={resolveLabels}
          onCreateLabel={createLabel}
          smartDates={smartDatesEnabled}
          projects={task.project_id ? projects.filter((p) => p.id === task.project_id) : []}
          sections={
            task.project_id
              ? allSections.sections.filter((s) => s.project_id === task.project_id)
              : []
          }
          now={now}
          timeZone={timezone || undefined}
          formatDue={formatDue}
        />
      )}
    </>
  );
}

/** A compact child-task row: a completion toggle and a tap-to-open title, lighter than `TaskRow` so it doesn't fight the detail's scroll. */
function SubtaskRow({
  task,
  toggleLabel,
  onToggle,
  onOpen,
  isEditing,
  onStartRename,
  onSaveRename,
  onSubmitRenameAndAddBelow,
  onCancelRename,
}: {
  task: Task;
  toggleLabel: string;
  onToggle: () => void;
  onOpen?: () => void;
  isEditing?: boolean;
  onStartRename?: () => void;
  onSaveRename?: (newTitle: string) => void;
  onSubmitRenameAndAddBelow?: (newTitle: string) => void;
  onCancelRename?: () => void;
}) {
  const { t } = useTranslation();
  const [localTitle, setLocalTitle] = useState(task.title);

  useEffect(() => {
    if (!isEditing) {
      setLocalTitle(task.title);
    }
  }, [task.title, isEditing]);

  const handleSave = () => {
    const trimmed = localTitle.trim();
    const finalTitle = trimmed.length > 0 ? trimmed : task.title;
    setLocalTitle(finalTitle);
    onSaveRename?.(finalTitle);
  };

  const handleSubmit = () => {
    const trimmed = localTitle.trim();
    const finalTitle = trimmed.length > 0 ? trimmed : task.title;
    setLocalTitle(finalTitle);
    if (onSubmitRenameAndAddBelow) {
      onSubmitRenameAndAddBelow(finalTitle);
    } else {
      onSaveRename?.(finalTitle);
    }
  };

  const handleCancel = () => {
    setLocalTitle(task.title);
    onCancelRename?.();
  };

  if (task.locked) {
    // Undecryptable here: no toggle or rename (both would write placeholder fields); a tap opens the subtask.
    return (
      <View className="group flex-row items-center gap-3 py-0.5">
        <KeyRound size={18} className="text-neutral-500" />
        <Pressable
          accessibilityRole={Platform.OS !== "web" ? "button" : undefined}
          accessibilityLabel={t("task.lockedTitle")}
          onPress={onOpen}
          disabled={!onOpen}
          className="min-w-0 flex-1 py-1 web:cursor-pointer"
        >
          <Text
            numberOfLines={1}
            className={
              "italic text-neutral-500 " + (Platform.OS === "web" ? "text-sm" : "text-base")
            }
          >
            {t("task.lockedTitle")}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="group flex-row items-center gap-3 py-0.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        onPress={onToggle}
        hitSlop={10}
        className="web:cursor-pointer"
      >
        {task.is_completed ? (
          <CircleCheckBig size={18} className="text-accent-500" />
        ) : (
          <Circle size={18} className="text-neutral-500" />
        )}
      </Pressable>

      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        {isEditing ? (
          <TextInput
            accessibilityLabel={t("task.renameTitle", "Task title")}
            value={localTitle}
            onChangeText={setLocalTitle}
            onBlur={handleSave}
            onSubmitEditing={handleSubmit}
            onKeyPress={(e) => {
              if (isEscapeKey(e)) {
                handleCancel();
              }
            }}
            autoFocus
            selectTextOnFocus
            returnKeyType="next"
            className={
              "flex-1 py-0 px-0 text-neutral-900 border-b border-accent-500 bg-transparent dark:text-neutral-100 " +
              (Platform.OS === "web" ? "text-sm" : "text-base")
            }
          />
        ) : (
          <Pressable
            accessibilityRole={Platform.OS !== "web" ? "button" : undefined}
            accessibilityLabel={task.title}
            onPress={onStartRename}
            className="min-w-0 flex-1 py-1 web:cursor-pointer"
          >
            <Text
              numberOfLines={1}
              className={
                (Platform.OS === "web" ? "text-sm " : "text-base ") +
                (task.is_completed
                  ? "text-neutral-500 line-through"
                  : "text-neutral-800 dark:text-neutral-100")
              }
            >
              {task.title}
            </Text>
          </Pressable>
        )}

        {isEditing && onOpen && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.details", "Task details")}
            onPress={onOpen}
            hitSlop={8}
            className="p-1 rounded web:cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Info size={16} className="text-accent-600 dark:text-accent-400" />
          </Pressable>
        )}

        {Platform.OS === "web" && !isEditing && onOpen && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.details", "Task details")}
            onPress={onOpen}
            className="opacity-0 group-hover:opacity-100 web:focus-visible:opacity-100 web:cursor-pointer"
          >
            <Info
              size={16}
              className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200"
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}
