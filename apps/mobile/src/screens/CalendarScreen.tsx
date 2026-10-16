import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type ScrollViewInstance,
  type ViewInstance,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { useDragSource, useDropTarget } from "../hooks/useCardDnd";
import { displayTitle } from "../lib/taskTitle";
import {
  addDays,
  endOfDay,
  isAllDayTask,
  isOverdue,
  isoWeek,
  makeInstant,
  monthGrid,
  partitionDayTasks,
  startOfDay,
  tasksByDay,
  weekDays,
  weekdayLabels,
  zonedParts,
  type DayCell,
} from "@atlas/shared";
import type { Task } from "@atlas/client-core";
import { useLocalTasks } from "../hooks/useLocalTasks";
import { usePreferences } from "../hooks/usePreferences";
import { useFormat } from "../hooks/useFormat";
import { useNow } from "../hooks/useNow";
import { haptics } from "../lib/haptics";
import { Segmented } from "../ui/Segmented";
import { ChevronLeft, ChevronRight, X } from "../ui/icons";

type CalendarMode = "month" | "week";

const MAX_CHIPS = 3;
/** Dots a compact (phone) day cell shows before a "+N". */
const MAX_DOTS = 4;
/** Window width below which the month grid is compact: dots instead of titled chips, no week numbers. */
const COMPACT_MAX_WIDTH = 600;

/**
 * Month/Week calendar. Active tasks sit on their due day; overdue ones read red; week numbers head
 * each row. Rescheduling is tap-based, like the board: long-press a chip to pick it up, then tap a
 * day to drop it there (`due_at` becomes the end of that day). Navigation is injected (`onOpenTask`).
 */
export function CalendarScreen({ onOpenTask }: { onOpenTask?: (task: Task) => void }) {
  const { t } = useTranslation();
  const now = useNow();
  const { tasks, move } = useLocalTasks();
  const { weekStartsOn, timezone, showWeekNumbers } = usePreferences();
  const fmt = useFormat();
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(() => startOfDay(now, timezone));
  const [movingId, setMovingId] = useState<string | null>(null);
  const anchorParts = zonedParts(anchor, timezone);

  const { width: windowWidth } = useWindowDimensions();
  // A phone's ~50px cells cut every chip to "Fi…": show dots there and leave the titles to the
  // agenda below. The week-number column goes too, so the seven days get its width.
  const compact = windowWidth < COMPACT_MAX_WIDTH;
  const weekNumbers = showWeekNumbers && !compact;
  const translateX = useSharedValue(0);
  const isTransitioning = useRef(false);

  const rows = useMemo<DayCell[][]>(
    () =>
      mode === "week"
        ? [weekDays(anchor, weekStartsOn, timezone)]
        : monthGrid(anchorParts.year, anchorParts.month, weekStartsOn, timezone),
    [mode, anchor, anchorParts.year, anchorParts.month, weekStartsOn, timezone],
  );
  const byDay = useMemo(() => tasksByDay(tasks, timezone), [tasks, timezone]);
  const today = startOfDay(now, timezone);
  // ISO weeks are Monday-based; label each row from its Thursday so the number is right whichever day the week starts on.
  const thursdayIndex = (4 - (((weekStartsOn % 7) + 7) % 7) + 7) % 7;
  const weekOf = (row: DayCell[]) => isoWeek(row[thursdayIndex]!.date, timezone);

  const agenda = useMemo(() => {
    const rangeStart = rows[0]![0]!.date;
    const rangeEnd = endOfDay(rows[rows.length - 1]![6]!.date, timezone);
    return tasks
      .filter(
        (task) =>
          !task.is_completed &&
          task.due_at !== null &&
          task.due_at >= rangeStart &&
          task.due_at <= rangeEnd,
      )
      .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0));
  }, [tasks, rows, timezone]);

  const movingTask = movingId ? (tasks.find((task) => task.id === movingId) ?? null) : null;

  function shift(delta: number) {
    setAnchor((a) => {
      if (mode === "week") return addDays(a, delta * 7, timezone);
      // The 1st at midnight in the preferred zone; a device-local date lands in the wrong month when the zones differ.
      const p = zonedParts(a, timezone);
      return makeInstant(p.year, p.month + delta, 1, 0, 0, 0, timezone);
    });
  }

  const shiftRef = useRef(shift);
  shiftRef.current = shift;

  const triggerShift = (delta: number) => {
    shiftRef.current(delta);
  };

  useEffect(() => {
    translateX.value = 0;
    isTransitioning.current = false;
  }, [mode, translateX]);

  function shiftWithTransition(delta: number) {
    if (Platform.OS === "web" || process.env.NODE_ENV === "test") {
      shift(delta);
      return;
    }
    if (isTransitioning.current) return;
    isTransitioning.current = true;
    const targetX = delta > 0 ? -windowWidth * 0.35 : windowWidth * 0.35;
    const startX = delta > 0 ? windowWidth * 0.35 : -windowWidth * 0.35;

    translateX.value = withTiming(
      targetX,
      { duration: 120, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) {
          runOnJS(triggerShift)(delta);
          translateX.value = startX;
          translateX.value = withTiming(
            0,
            { duration: 150, easing: Easing.out(Easing.cubic) },
            () => {
              isTransitioning.current = false;
            },
          );
        } else {
          isTransitioning.current = false;
        }
      },
    );
  }

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(Platform.OS !== "web" && !movingId)
        .activeOffsetX([-15, 15])
        .failOffsetY([-20, 20])
        .onUpdate((event) => {
          if (!isTransitioning.current) {
            translateX.value = event.translationX;
          }
        })
        .onEnd((event) => {
          if (isTransitioning.current) return;
          if (event.translationX < -50 || event.velocityX < -500) {
            isTransitioning.current = true;
            translateX.value = withTiming(
              -windowWidth,
              { duration: 150, easing: Easing.in(Easing.cubic) },
              (finished) => {
                if (finished) {
                  runOnJS(triggerShift)(1);
                  translateX.value = windowWidth;
                  translateX.value = withTiming(
                    0,
                    { duration: 180, easing: Easing.out(Easing.cubic) },
                    () => {
                      isTransitioning.current = false;
                    },
                  );
                } else {
                  isTransitioning.current = false;
                }
              },
            );
          } else if (event.translationX > 50 || event.velocityX > 500) {
            isTransitioning.current = true;
            translateX.value = withTiming(
              windowWidth,
              { duration: 150, easing: Easing.in(Easing.cubic) },
              (finished) => {
                if (finished) {
                  runOnJS(triggerShift)(-1);
                  translateX.value = -windowWidth;
                  translateX.value = withTiming(
                    0,
                    { duration: 180, easing: Easing.out(Easing.cubic) },
                    () => {
                      isTransitioning.current = false;
                    },
                  );
                } else {
                  isTransitioning.current = false;
                }
              },
            );
          } else {
            translateX.value = withTiming(0, { duration: 150, easing: Easing.out(Easing.cubic) });
          }
        }),
    [movingId, windowWidth, translateX],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  function onDayPress(dayMs: number) {
    if (!movingId) return;
    const existing = tasks.find((t) => t.id === movingId);
    let nextDue: number;
    if (existing?.due_at != null && !isAllDayTask(existing.due_at, timezone)) {
      const ep = zonedParts(existing.due_at, timezone);
      const dp = zonedParts(dayMs, timezone);
      nextDue = makeInstant(dp.year, dp.month, dp.day, ep.hour, ep.minute, 0, timezone);
    } else {
      nextDue = endOfDay(dayMs, timezone);
    }
    move(movingId, { due_at: nextDue });
    setMovingId(null);
  }

  function onAllDayPress(dayMs: number) {
    if (!movingId) return;
    move(movingId, { due_at: endOfDay(dayMs, timezone) });
    setMovingId(null);
  }

  function onSlotPress(dayMs: number, hour: number) {
    if (!movingId) return;
    const p = zonedParts(dayMs, timezone);
    move(movingId, { due_at: makeInstant(p.year, p.month, p.day, hour, 0, 0, timezone) });
    setMovingId(null);
  }

  const headerLabel =
    mode === "week"
      ? showWeekNumbers
        ? `${fmt.monthYear(anchorParts.year, anchorParts.month)} · ${t("calendar.weekNumber", {
            n: weekOf(rows[0]!),
          })}`
        : fmt.monthYear(anchorParts.year, anchorParts.month)
      : fmt.monthYear(anchorParts.year, anchorParts.month);

  const labels = weekdayLabels(weekStartsOn);

  return (
    <View className="flex-1 bg-white dark:bg-zinc-950">
      <View className="flex-row items-center gap-1 px-3 pb-2 pt-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            mode === "week" ? t("calendar.previousWeek") : t("calendar.previousMonth")
          }
          onPress={() => shiftWithTransition(-1)}
          hitSlop={8}
          className="p-1"
        >
          <ChevronLeft size={20} className="text-neutral-600 dark:text-neutral-300" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={mode === "week" ? t("calendar.nextWeek") : t("calendar.nextMonth")}
          onPress={() => shiftWithTransition(1)}
          hitSlop={8}
          className="p-1"
        >
          <ChevronRight size={20} className="text-neutral-600 dark:text-neutral-300" />
        </Pressable>
        <Text className="flex-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {headerLabel}
        </Text>
        <Segmented
          value={mode}
          options={[
            { value: "month", label: t("calendar.month") },
            { value: "week", label: t("calendar.week") },
          ]}
          onChange={setMode}
          label={t("calendar.viewMode")}
        />
      </View>

      {movingTask && (
        <View className="mx-3 mb-2 flex-row items-center gap-2 rounded-md bg-accent-50 px-3 py-2 dark:bg-accent-950">
          <Text className="flex-1 text-xs text-accent-700 dark:text-accent-300">
            {t("calendar.moveHint", { title: displayTitle(movingTask, t) })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.cancel")}
            onPress={() => setMovingId(null)}
            hitSlop={8}
          >
            <X size={16} className="text-accent-700 dark:text-accent-300" />
          </Pressable>
        </View>
      )}

      <View className="flex-1 overflow-hidden">
        <GestureDetector gesture={panGesture}>
          <Animated.View style={[{ flex: 1 }, animatedStyle]}>
            {mode === "month" ? (
              <ScrollView className="flex-1" contentContainerClassName="pb-8">
                {/* Weekday header: an optional spacer for the week-number column, then the seven day labels. */}
                <View className="flex-row px-2">
                  {weekNumbers && <View className="w-7" />}
                  {labels.map((d) => (
                    <Text
                      key={d}
                      className="flex-1 px-1 pb-1 text-center text-xs font-medium text-neutral-500"
                    >
                      {d}
                    </Text>
                  ))}
                </View>

                <View className="px-2">
                  {rows.map((row) => (
                    <View key={row[0]!.date} className="flex-row">
                      {weekNumbers && (
                        <View className="w-7 items-center justify-center border border-neutral-100 dark:border-neutral-800">
                          <Text className="text-xs text-neutral-500">{weekOf(row)}</Text>
                        </View>
                      )}
                      {row.map((cell) => (
                        <DayCellView
                          key={cell.date}
                          cell={cell}
                          tasks={byDay.get(cell.date) ?? []}
                          now={now}
                          isToday={cell.date === today}
                          compact={compact}
                          timeZone={timezone}
                          moving={movingId !== null}
                          movingId={movingId}
                          onDayPress={() => onDayPress(cell.date)}
                          onChipPress={(task) =>
                            movingId ? onDayPress(cell.date) : onOpenTask?.(task)
                          }
                          onChipLongPress={(task) => setMovingId(task.id)}
                          onDropOnDay={(taskId) => {
                            const existing = tasks.find((t) => t.id === taskId);
                            let nextDue: number;
                            if (
                              existing?.due_at != null &&
                              !isAllDayTask(existing.due_at, timezone)
                            ) {
                              const ep = zonedParts(existing.due_at, timezone);
                              const dp = zonedParts(cell.date, timezone);
                              nextDue = makeInstant(
                                dp.year,
                                dp.month,
                                dp.day,
                                ep.hour,
                                ep.minute,
                                0,
                                timezone,
                              );
                            } else {
                              nextDue = endOfDay(cell.date, timezone);
                            }
                            move(taskId, { due_at: nextDue });
                          }}
                        />
                      ))}
                    </View>
                  ))}
                </View>

                <View className="mt-6 px-4">
                  <Text className="mb-2 text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                    {t("calendar.agenda")}
                  </Text>
                  {agenda.length === 0 ? (
                    <Text className="text-sm text-neutral-500">
                      {t("calendar.nothingScheduled")}
                    </Text>
                  ) : (
                    agenda.map((task) => (
                      <Pressable
                        key={task.id}
                        accessibilityRole="button"
                        accessibilityLabel={displayTitle(task, t)}
                        onPress={() => onOpenTask?.(task)}
                        className="flex-row items-center gap-2 py-1"
                      >
                        <Text
                          className={
                            "w-16 shrink-0 text-xs " +
                            (isOverdue(task, now, timezone) ? "text-red-500" : "text-neutral-500")
                          }
                        >
                          {fmt.dueChip(task.due_at!)}
                        </Text>
                        <Text
                          className="flex-1 text-sm text-neutral-800 dark:text-neutral-100"
                          numberOfLines={1}
                        >
                          {displayTitle(task, t)}
                        </Text>
                      </Pressable>
                    ))
                  )}
                </View>
              </ScrollView>
            ) : (
              <WeekTimelineView
                days={rows[0]!}
                labels={labels}
                byDay={byDay}
                now={now}
                today={today}
                timeZone={timezone}
                movingId={movingId}
                fmt={fmt}
                onDayPress={onDayPress}
                onAllDayPress={onAllDayPress}
                onSlotPress={onSlotPress}
                onChipPress={(task, dayMs) => (movingId ? onDayPress(dayMs) : onOpenTask?.(task))}
                onChipLongPress={(task) => setMovingId(task.id)}
                agenda={agenda}
                onOpenTask={onOpenTask}
              />
            )}
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const HOUR_HEIGHT = 48;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function WeekTimelineView({
  days,
  labels,
  byDay,
  now,
  today,
  timeZone,
  movingId,
  fmt,
  onDayPress,
  onAllDayPress,
  onSlotPress,
  onChipPress,
  onChipLongPress,
  agenda,
  onOpenTask,
}: {
  days: DayCell[];
  labels: string[];
  byDay: Map<number, Task[]>;
  now: number;
  today: number;
  timeZone: string;
  movingId: string | null;
  fmt: ReturnType<typeof useFormat>;
  onDayPress: (dayMs: number) => void;
  onAllDayPress: (dayMs: number) => void;
  onSlotPress: (dayMs: number, hour: number) => void;
  onChipPress: (task: Task, dayMs: number) => void;
  onChipLongPress: (task: Task) => void;
  agenda: Task[];
  onOpenTask?: (task: Task) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const nowParts = zonedParts(now, timeZone);
  const hourLabels = useMemo(
    () =>
      HOURS.map((h) =>
        fmt.time(makeInstant(nowParts.year, nowParts.month, nowParts.day, h, 0, 0, timeZone)),
      ),
    [fmt, nowParts.year, nowParts.month, nowParts.day, timeZone],
  );

  const dayPartitions = useMemo(
    () => days.map((d) => partitionDayTasks(byDay.get(d.date) ?? [], timeZone)),
    [days, byDay, timeZone],
  );

  const hasAnyAllDay = dayPartitions.some((p) => p.allDay.length > 0);

  useEffect(() => {
    const isThisWeek = days.some((d) => d.date === today);
    const targetHour = isThisWeek ? Math.max(0, nowParts.hour - 1) : 8;
    const timer = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: targetHour * HOUR_HEIGHT, animated: false });
    }, 50);
    return () => clearTimeout(timer);
  }, [days, today, nowParts.hour]);

  return (
    <View className="flex-1">
      {/* Pinned Day Header row */}
      <View className="flex-row border-b border-neutral-200 bg-white px-1 pb-1 dark:border-neutral-800 dark:bg-zinc-950">
        <View className="w-12 items-center justify-center" />
        {days.map((cell, idx) => {
          const isToday = cell.date === today;
          return (
            <Pressable
              key={cell.date}
              accessibilityRole={Platform.OS === "web" ? undefined : "button"}
              accessibilityLabel={String(cell.day)}
              onPress={() => onDayPress(cell.date)}
              className="flex-1 items-center py-1"
            >
              <Text className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {labels[idx]}
              </Text>
              <View
                className={
                  "mt-0.5 h-6 w-6 items-center justify-center rounded-full " +
                  (isToday ? "bg-accent-600" : "")
                }
              >
                <Text
                  className={
                    "text-xs font-semibold " +
                    (isToday ? "text-white" : "text-neutral-800 dark:text-neutral-200")
                  }
                >
                  {cell.day}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* All-Day section if there are all-day tasks or during move */}
      {(hasAnyAllDay || movingId) && (
        <View className="flex-row border-b border-neutral-200 bg-neutral-50/70 px-1 py-1 dark:border-neutral-800 dark:bg-zinc-900/50">
          <View className="w-12 items-center justify-center">
            <Text className="text-[9px] font-medium text-neutral-500 dark:text-neutral-400">
              {t("calendar.endOfDay")}
            </Text>
          </View>
          {days.map((cell, idx) => {
            const allDayTasks = dayPartitions[idx]?.allDay ?? [];
            return (
              <Pressable
                key={cell.date}
                accessibilityRole={Platform.OS === "web" ? undefined : "button"}
                accessibilityLabel={t("calendar.allDayOn", { day: cell.day })}
                onPress={() => onAllDayPress(cell.date)}
                disabled={!movingId}
                className="flex-1 gap-1 px-0.5"
              >
                {allDayTasks.map((task) => (
                  <DayChip
                    key={task.id}
                    task={task}
                    picked={task.id === movingId}
                    overdue={isOverdue(task, now, timeZone)}
                    onPress={() => onChipPress(task, cell.date)}
                    onLongPress={() => onChipLongPress(task)}
                  />
                ))}
              </Pressable>
            );
          })}
        </View>
      )}

      {/* 24-hour Scrollable Timeline Grid */}
      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        <View className="flex-row">
          {/* Y-axis: Hour time labels */}
          <View className="w-12">
            {HOURS.map((h) => (
              <View
                key={h}
                className="items-end justify-start pr-1"
                style={{ height: HOUR_HEIGHT }}
              >
                <Text className="-mt-2 text-[10px] font-medium text-neutral-500 dark:text-neutral-400">
                  {hourLabels[h]}
                </Text>
              </View>
            ))}
          </View>

          {/* 7 Days Columns */}
          <View className="flex-1 flex-row border-l border-neutral-200 dark:border-neutral-800">
            {days.map((cell, idx) => {
              const timedList = dayPartitions[idx]?.timed ?? [];
              const isToday = cell.date === today;
              const currentTop = isToday
                ? (nowParts.hour + nowParts.minute / 60) * HOUR_HEIGHT
                : null;

              return (
                <View
                  key={cell.date}
                  className="relative flex-1 border-r border-neutral-100 dark:border-neutral-800"
                >
                  {/* Hour horizontal slot lines */}
                  {HOURS.map((h) => (
                    <Pressable
                      key={h}
                      accessibilityRole={Platform.OS === "web" ? undefined : "button"}
                      accessibilityLabel={`${cell.day} ${hourLabels[h]}`}
                      onPress={() => onSlotPress(cell.date, h)}
                      disabled={!movingId}
                      className="border-t border-neutral-100 dark:border-neutral-800"
                      style={{ height: HOUR_HEIGHT }}
                    />
                  ))}

                  {/* Timed task chips */}
                  {timedList.map(({ task, startHour, startMinute, durationMin }) => {
                    const top = (startHour + startMinute / 60) * HOUR_HEIGHT;
                    const height = Math.max(22, (durationMin / 60) * HOUR_HEIGHT);
                    const overdue = isOverdue(task, now, timeZone);
                    const picked = task.id === movingId;

                    return (
                      <Pressable
                        key={task.id}
                        accessibilityRole="button"
                        accessibilityLabel={displayTitle(task, t)}
                        onPress={() => onChipPress(task, cell.date)}
                        onLongPress={() => onChipLongPress(task)}
                        className={
                          "absolute left-0.5 right-0.5 overflow-hidden rounded border px-1 py-0.5 shadow-xs " +
                          (picked
                            ? "bg-accent-600 border-accent-700 "
                            : overdue
                              ? "bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-900 "
                              : "bg-accent-50 border-accent-200 dark:bg-accent-950 dark:border-accent-900 ")
                        }
                        style={{ top, height, zIndex: 10 }}
                      >
                        <Text
                          numberOfLines={1}
                          className={
                            "text-[10px] font-medium " +
                            (picked
                              ? "text-white"
                              : overdue
                                ? "text-red-700 dark:text-red-300"
                                : "text-accent-700 dark:text-accent-300")
                          }
                        >
                          {displayTitle(task, t)}
                        </Text>
                      </Pressable>
                    );
                  })}

                  {/* Current time red line indicator */}
                  {currentTop !== null && (
                    <View
                      className="absolute left-0 right-0 z-20 h-0.5 bg-red-500"
                      style={{ top: currentTop, pointerEvents: "none" }}
                    >
                      <View className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-red-500" />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>

        {/* Week Agenda below timeline */}
        <View className="mt-6 px-4">
          <Text className="mb-2 text-sm font-semibold text-neutral-600 dark:text-neutral-300">
            {t("calendar.agenda")}
          </Text>
          {agenda.length === 0 ? (
            <Text className="text-sm text-neutral-500 dark:text-neutral-400">
              {t("calendar.nothingScheduled")}
            </Text>
          ) : (
            agenda.map((task) => (
              <Pressable
                key={task.id}
                accessibilityRole="button"
                accessibilityLabel={displayTitle(task, t)}
                onPress={() => onOpenTask?.(task)}
                className="flex-row items-center gap-2 py-1"
              >
                <Text
                  className={
                    "w-16 shrink-0 text-xs " +
                    (isOverdue(task, now, timeZone)
                      ? "text-red-500 dark:text-red-400"
                      : "text-neutral-500 dark:text-neutral-400")
                  }
                >
                  {fmt.dueChip(task.due_at!)}
                </Text>
                <Text
                  className="flex-1 text-sm text-neutral-800 dark:text-neutral-100"
                  numberOfLines={1}
                >
                  {displayTitle(task, t)}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function DayCellView({
  cell,
  tasks,
  now,
  isToday,
  compact,
  timeZone,
  moving,
  movingId,
  onDayPress,
  onChipPress,
  onChipLongPress,
  onDropOnDay,
}: {
  cell: DayCell;
  tasks: Task[];
  now: number;
  isToday: boolean;
  /** A dot per task instead of titled chips (phone widths); the agenda below names them. */
  compact: boolean;
  timeZone: string;
  moving: boolean;
  movingId: string | null;
  onDayPress: () => void;
  onChipPress: (task: Task) => void;
  onChipLongPress: (task: Task) => void;
  /** Web-only: a task chip dragged onto this day. */
  onDropOnDay: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const shown = tasks.slice(0, compact ? MAX_DOTS : MAX_CHIPS);
  const overflow = tasks.length - shown.length;
  // A web drop target: a chip dropped here reschedules to this day.
  const dayRef = useRef<ViewInstance>(null);
  useDropTarget(dayRef, onDropOnDay);
  return (
    <Pressable
      ref={dayRef}
      // react-native-web renders the button role as `<button>`, and the day's chips are buttons too;
      // nesting is invalid HTML, so the cell is a plain `<div>` on web and keeps the role on native.
      accessibilityRole={Platform.OS === "web" ? undefined : "button"}
      accessibilityLabel={
        compact && tasks.length > 0
          ? t("calendar.dayTasks", { day: cell.day, count: tasks.length })
          : String(cell.day)
      }
      onPress={onDayPress}
      disabled={!moving}
      className={
        (compact ? "min-h-[56px] " : "min-h-[76px] ") +
        "flex-1 gap-0.5 border border-neutral-100 p-1 dark:border-neutral-800 " +
        (cell.inMonth ? "" : "bg-neutral-50 dark:bg-neutral-900 ") +
        (moving ? "opacity-100" : "")
      }
    >
      <View
        className={
          "mb-0.5 h-6 w-6 items-center justify-center rounded-full " +
          (compact ? "self-center " : "self-end ") +
          (isToday ? "bg-accent-600" : "")
        }
      >
        <Text
          className={
            "text-xs " +
            (isToday
              ? "text-white"
              : cell.inMonth
                ? "text-neutral-600 dark:text-neutral-300"
                : "text-neutral-500 dark:text-neutral-600")
          }
        >
          {cell.day}
        </Text>
      </View>
      {compact ? (
        // Not buttons: too small to aim at. The cell's label carries the count.
        <View className="flex-row flex-wrap items-center justify-center gap-1">
          {shown.map((task) => (
            <View
              key={task.id}
              className={
                "h-1.5 w-1.5 rounded-full " +
                (task.id === movingId
                  ? "bg-accent-700 dark:bg-accent-300"
                  : isOverdue(task, now, timeZone)
                    ? "bg-red-500 dark:bg-red-400"
                    : "bg-accent-500 dark:bg-accent-400")
              }
            />
          ))}
          {overflow > 0 && (
            <Text className="text-[10px] text-neutral-500 dark:text-neutral-400">+{overflow}</Text>
          )}
        </View>
      ) : (
        <>
          {shown.map((task) => (
            <DayChip
              key={task.id}
              task={task}
              picked={task.id === movingId}
              overdue={isOverdue(task, now, timeZone)}
              onPress={() => onChipPress(task)}
              onLongPress={() => onChipLongPress(task)}
            />
          ))}
          {overflow > 0 && (
            <Text className="px-1 text-xs text-neutral-500 dark:text-neutral-400">+{overflow}</Text>
          )}
        </>
      )}
    </Pressable>
  );
}

/** A task chip on a day cell; on web an HTML5 drag source carrying the task id (`useDragSource` is a no-op on native, where long-press picks it up). */
function DayChip({
  task,
  picked,
  overdue,
  onPress,
  onLongPress,
}: {
  task: Task;
  picked: boolean;
  overdue: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<ViewInstance>(null);
  useDragSource(ref, () => task.id);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={displayTitle(task, t)}
      onPress={onPress}
      onLongPress={() => {
        haptics.impact("medium");
        onLongPress();
      }}
      className={
        "rounded px-1.5 py-0.5 " +
        (picked
          ? "bg-accent-600 "
          : overdue
            ? "bg-red-50 dark:bg-red-950 "
            : "bg-accent-50 dark:bg-accent-950 ")
      }
    >
      <Text
        numberOfLines={1}
        className={
          "text-xs " +
          (picked
            ? "text-white"
            : overdue
              ? "text-red-700 dark:text-red-300"
              : "text-accent-700 dark:text-accent-300")
        }
      >
        {displayTitle(task, t)}
      </Text>
    </Pressable>
  );
}
