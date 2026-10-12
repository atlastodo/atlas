import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import ReorderableList, { type ReorderableListReorderEvent } from "react-native-reorderable-list";
import Animated from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  dateKeyFromMs,
  dateKeyToMs,
  habitSiblings,
  isBackfilled,
  resolveProjectColor,
  shiftDateKey,
  type Habit,
  type HabitKind,
  type HabitListRow,
} from "@atlas/shared";
import { useHabits } from "../hooks/useHabits";
import { useHabitGroups, type HabitGroupSummary, type HabitSummary } from "../hooks/useHabitGroups";
import { useHabitCheckins } from "../hooks/useHabitCheckins";
import { usePreferences } from "../hooks/usePreferences";
import { useToast } from "../data/ToastProvider";
import { useNow } from "../hooks/useNow";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { useDragPan } from "../hooks/useDragPan";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { AnimatedRow } from "../ui/AnimatedRow";
import { DragToReorder } from "../ui/DragToReorder";
import { EmptyState } from "../ui/EmptyState";
import { Segmented } from "../ui/Segmented";
import { HabitDayLegend, HabitWeekStrip } from "../ui/HabitWeekStrip";
import { AddHabitSheet } from "../ui/AddHabitSheet";
import { HabitGroupPicker } from "../ui/HabitGroupPicker";
import { ScreenFade } from "../ui/ScreenFade";
import { projectIconFor } from "../ui/projectIcons";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  Flame,
  FolderPlus,
  Plus,
  Trash2,
} from "../ui/icons";
import { haptics } from "../lib/haptics";
import { useMotion } from "../lib/motion";
import { dragReleaseAction } from "../lib/dragRelease";
import { resolveHabitDrop } from "../lib/habitReorder";

/**
 * Habits & streaks. Each habit is one row: today's check, the name, the streak, the current
 * period, and the last seven days as circles. Schedule and streak maths is `@atlas/shared`'s
 * `habits.ts`.
 *
 * Every recorded day is reversible (a tap cycles the day and raises an undo toast). The strip
 * backfills the past week; older days are edited on the detail screen's month calendar. The
 * Today/Yesterday toggle moves the whole screen back a day, including the list filter by what was
 * due that day. Gated behind the `habits` feature flag. `now` is injectable.
 */

/** Which day the screen records and reports on. */
type HabitsDay = "today" | "yesterday";

/** Where a card's action menu should open, plus which habit it belongs to. */
interface HabitMenu {
  habit: Habit;
  pos: MenuPos;
}

/**
 * A group's header row: the routine's name, its combined streak, and today across its members.
 * It is also the top of the routine's box. The list is one flat virtualised `ReorderableList`, so
 * the enclosure is drawn a row at a time: the header draws the top and sides, each member the
 * sides, the last member closes it. A header with no member row after it (collapsed, or filtered
 * out by the Today scope) closes itself.
 */
function HabitGroupHeader({
  group,
  summary,
  yesterday,
  expanded,
  open,
  startDrag,
  onToggle,
  onOpen,
  onOpenActions,
}: {
  group: Habit;
  summary: HabitGroupSummary;
  yesterday: boolean;
  expanded: boolean;
  open: boolean;
  startDrag: (() => void) | undefined;
  onToggle: (group: Habit) => void;
  onOpen?: (habit: Habit) => void;
  onOpenActions: (habit: Habit, pos: MenuPos) => void;
}) {
  const { t } = useTranslation();
  const Icon = projectIconFor(group.icon);
  const contextRef = useContextMenu((pos) => onOpenActions(group, pos));
  const day = summary.today;

  return (
    <View
      ref={contextRef}
      className={
        "mx-4 mt-1 flex-row items-center gap-2 rounded-t-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800 " +
        (open ? "border-b-0 bg-neutral-50 dark:bg-neutral-900/40" : "mb-2 rounded-b-lg")
      }
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("habits.open", { name: group.name })}
        onPress={() => onOpen?.(group)}
        // A hold that goes nowhere opens the menu instead, like a habit card.
        onLongPress={startDrag}
        delayLongPress={220}
        className="min-w-0 flex-1"
      >
        <View className="flex-row items-center gap-2">
          <Icon size={16} color={group.color} />
          <Text
            className="flex-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50"
            numberOfLines={1}
          >
            {group.name}
          </Text>
        </View>
        <View className="mt-0.5 flex-row items-center gap-3">
          <View className="shrink-0 flex-row items-center gap-1">
            <Flame size={14} className="text-orange-500" />
            <Text className="text-xs text-neutral-500">
              {t("habits.streakDays", { count: summary.streak })}
            </Text>
          </View>
          {/* "Nothing scheduled today" is long enough to push the streak off a phone, so it is the
              one that truncates. */}
          <Text className="shrink text-xs text-neutral-500" numberOfLines={1}>
            {day === null || day.due === 0
              ? t(yesterday ? "habits.groupNothingYesterday" : "habits.groupNothingToday")
              : t(yesterday ? "habits.groupYesterday" : "habits.groupToday", {
                  done: day.done,
                  due: day.due,
                })}
          </Text>
        </View>
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(expanded ? "habits.collapseGroup" : "habits.expandGroup", {
          name: group.name,
        })}
        accessibilityState={{ expanded }}
        onPress={() => onToggle(group)}
        hitSlop={8}
        className="p-1"
      >
        {expanded ? (
          <ChevronUp size={16} className="text-neutral-500" />
        ) : (
          <ChevronDown size={16} className="text-neutral-500" />
        )}
      </Pressable>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("habits.actions", { name: group.name })}
        onPress={(event) =>
          onOpenActions(group, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })
        }
        hitSlop={8}
        className="p-1"
      >
        <EllipsisVertical size={16} className="text-neutral-500" />
      </Pressable>
    </View>
  );
}

function HabitCard({
  habit,
  summary,
  dayKey,
  yesterday,
  weekStartsOn,
  enclosure,
  startDrag,
  expanded,
  onToggleExpand,
  onOpen,
  onOpenActions,
  inlineStrip,
}: {
  habit: Habit;
  summary: HabitSummary;
  dayKey: string;
  yesterday: boolean;
  weekStartsOn: number;
  /** Set when this habit belongs to a routine: the card draws its share of the group's box and a colour rail instead of its own border. */
  enclosure?: { color: string; first: boolean; last: boolean };
  startDrag: (() => void) | undefined;
  expanded: boolean;
  onToggleExpand: (habit: Habit) => void;
  onOpen?: (habit: Habit) => void;
  onOpenActions: (habit: Habit, pos: MenuPos) => void;
  /** Whether the list is wide enough for the week strip beside the name (see `STRIP_INLINE_MIN_WIDTH`). */
  inlineStrip: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const motion = useMotion();
  const { statesFor, checkinFor, cycle } = useHabitCheckins();

  const states = statesFor(habit.id);
  const dayState = states.get(dayKey);
  const { streak, period } = summary;
  const Icon = projectIconFor(habit.icon);

  const contextRef = useContextMenu((pos) => onOpenActions(habit, pos));

  const toggleDay = (date: string) => {
    const { next, undo } = cycle(habit.id, date);
    if (next === "done") haptics.success();
    else haptics.selection();
    toast.show(
      t(
        next === "done"
          ? "toast.habitChecked"
          : next === "skip"
            ? "toast.habitSkipped"
            : "toast.habitCleared",
        { name: habit.name },
      ),
      { label: t("common.undo"), run: undo },
    );
  };

  const strip = (fullWidth: boolean) => (
    <HabitWeekStrip
      habit={habit}
      states={states}
      isBackfilled={(date) => {
        const checkin = checkinFor(habit.id, date);
        return checkin !== undefined && isBackfilled(checkin);
      }}
      dayKey={dayKey}
      weekStartsOn={weekStartsOn}
      fullWidth={fullWidth}
      onToggleDay={toggleDay}
    />
  );

  return (
    <View
      ref={contextRef}
      // Inside a routine the card is a slice of the group's box: sides only, no vertical margin,
      // so its borders meet its neighbours'.
      className={
        enclosure
          ? "mx-4 border-x border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/40" +
            (enclosure.last ? " mb-2 rounded-b-lg border-b" : "")
          : "mx-4 mb-2 rounded-lg border border-neutral-200 dark:border-neutral-800"
      }
    >
      <View
        className={
          "flex-row gap-2.5 px-3 py-2.5" +
          (enclosure && !enclosure.first
            ? " border-t border-neutral-100 dark:border-neutral-800"
            : "")
        }
      >
        {/* The routine's colour, run down the card's inside edge. It is the signal that survives
            scrolling the header out of view, which the old 16px inset did not. */}
        {enclosure && (
          <View
            className="w-0.5 shrink-0 rounded-full"
            style={{ backgroundColor: enclosure.color }}
          />
        )}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              // The label names the day so a screen reader does not say "done today" for yesterday.
              accessibilityLabel={t(
                dayState === "done"
                  ? yesterday
                    ? "habits.markNotDoneYesterday"
                    : "habits.markNotDone"
                  : yesterday
                    ? "habits.markDoneYesterday"
                    : "habits.markDone",
                { name: habit.name },
              )}
              accessibilityState={{ checked: dayState === "done" }}
              onPress={() => toggleDay(dayKey)}
              className={
                "h-8 w-8 items-center justify-center rounded-full border-2 " +
                (dayState === "done"
                  ? "border-transparent"
                  : dayState === "skip"
                    ? "border-dashed border-neutral-400 dark:border-neutral-500"
                    : "border-neutral-300 dark:border-neutral-600")
              }
              style={dayState === "done" ? { backgroundColor: habit.color } : undefined}
            >
              {dayState === "done" && <Check size={16} className="text-white" />}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("habits.open", { name: habit.name })}
              onPress={() => onOpen?.(habit)}
              onLongPress={startDrag}
              delayLongPress={220}
              className="min-w-0 flex-1"
            >
              <View className="flex-row items-center gap-2">
                <Icon size={14} color={habit.color} />
                <Text
                  className="flex-1 text-sm font-medium text-neutral-800 dark:text-neutral-100"
                  numberOfLines={1}
                >
                  {habit.name}
                </Text>
              </View>
              <View className="mt-0.5 flex-row items-center gap-3">
                <View className="flex-row items-center gap-1">
                  <Flame size={14} className="text-orange-500" />
                  <Text className="text-xs text-neutral-500">
                    {t(habit.goal_kind === "daily" ? "habits.streakDays" : "habits.streakPeriods", {
                      count: streak,
                    })}
                  </Text>
                </View>
                {period !== null && period.target > 0 && (
                  <Text numberOfLines={1} className="shrink text-xs text-neutral-500">
                    {t("habits.periodProgress", { done: period.done, target: period.target })}
                  </Text>
                )}
              </View>
            </Pressable>

            {/* Inline only when the row can actually hold it. Seven 36px circles plus their gaps are
            ~300px, and the check, the steps chevron and the overflow button take ~130px more -- so
            on a narrow list (a phone, or a tablet beside the sidebar) the strip goes below (see the
            second row) and the name gets the space instead of being squeezed to "Read 20 …". */}
            {inlineStrip && strip(false)}

            {/* A chevron on a habit with no steps would do nothing. */}
            {habit.steps.length > 0 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(expanded ? "habits.hideSteps" : "habits.showSteps", {
                  name: habit.name,
                })}
                accessibilityState={{ expanded }}
                onPress={() => onToggleExpand(habit)}
                hitSlop={8}
                className="p-1"
              >
                {expanded ? (
                  <ChevronUp size={16} className="text-neutral-500" />
                ) : (
                  <ChevronDown size={16} className="text-neutral-500" />
                )}
              </Pressable>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("habits.actions", { name: habit.name })}
              onPress={(event) =>
                onOpenActions(habit, { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })
              }
              hitSlop={8}
              className="p-1"
            >
              <EllipsisVertical size={16} className="text-neutral-500" />
            </Pressable>
          </View>

          {/* The strip's own row on a phone: a row that cannot fit its contents truncates the name to nothing. */}
          {!inlineStrip && <View className="mt-2 flex-row">{strip(true)}</View>}

          {/* Reference only: not pressable, because nothing here should suggest a step can be ticked.
          `entering` and nothing else -- a `layout` animation anywhere inside a reorderable row
          fights the library's own drag transform and makes the drag stutter. */}
          {expanded && habit.steps.length > 0 && (
            <Animated.View entering={motion.rowEntering}>
              {/* Styled on a plain View: NativeWind ignores `className` on Reanimated views. */}
              <View className="mt-2 gap-0.5 pl-10">
                {habit.steps.map((step, index) => (
                  <Text key={index} numberOfLines={2} className="text-xs text-neutral-500">
                    {index + 1}. {step}
                  </Text>
                ))}
              </View>
            </Animated.View>
          )}
        </View>
      </View>
    </View>
  );
}

/** List width at/above which a card's week strip sits beside the name; it leaves the name ~300px. */
const STRIP_INLINE_MIN_WIDTH = 760;

export function HabitsScreen({
  now,
  onOpenHabit,
}: {
  now?: number;
  onOpenHabit?: (habit: Habit) => void;
}) {
  const { t } = useTranslation();
  const liveNow = useNow();
  const nowMs = now ?? liveNow;
  // Local and momentary: a backfill is a visit to yesterday, not a preference.
  const [day, setDay] = useState<HabitsDay>("today");
  const yesterday = day === "yesterday";
  // The list's own width, not the window's: beside a sidebar a tablet has far less room than its
  // window suggests.
  const [listWidth, setListWidth] = useState(0);
  const inlineStrip = listWidth >= STRIP_INLINE_MIN_WIDTH;
  // One instant for the whole screen so circles, strip, streaks and the Due filter agree. Local
  // noon on the shifted date key, not `now - 24h`, which differs across a DST boundary.
  const dayMs = yesterday ? dateKeyToMs(shiftDateKey(dateKeyFromMs(nowMs), -1)) : nowMs;
  const dayKey = dateKeyFromMs(dayMs);
  const { weekStartsOn, habitsScope, setHabitsScope } = usePreferences();
  const { createHabit, applyHabitDrop, moveHabit, reorderSibling, removeHabit, setArchived } =
    useHabits();
  const { rows, habits, hiddenByScope, groupSummary, habitSummary, toggleGroup } = useHabitGroups(
    dayMs,
    habitsScope,
  );
  // Manual order and a filtered list are mutually exclusive: ranking a drop against only some of
  // the neighbours would land the row in an order it cannot see.
  const canReorder = habitsScope === "all";
  const toast = useToast();
  const [adding, setAdding] = useState<{ kind: HabitKind; parentId: string | null } | null>(null);
  const [picking, setPicking] = useState<Habit | null>(null);
  const [menu, setMenu] = useState<HabitMenu | null>(null);
  // Which cards have their steps revealed. Local; kept here because `ReorderableList` virtualizes
  // and an off-screen card would lose its own state.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const dragPan = useDragPan();

  const openActions = useCallback((habit: Habit, pos: MenuPos) => setMenu({ habit, pos }), []);

  const groupById = useMemo(
    () => new Map(habits.filter((h) => h.kind === "group").map((g) => [g.id, g])),
    [habits],
  );

  // Read off the rendered rows, not the tree: what closes the box must be what is drawn.
  const opensBox = useCallback(
    (index: number) => {
      const next = rows[index + 1];
      return next !== undefined && next.kind === "habit" && next.depth === 1;
    },
    [rows],
  );

  const enclosureFor = useCallback(
    (row: HabitListRow, index: number) => {
      if (row.kind !== "habit" || row.depth !== 1) return undefined;
      const group = row.habit.parent_id !== null ? groupById.get(row.habit.parent_id) : undefined;
      if (group === undefined) return undefined;
      const next = rows[index + 1];
      return {
        color: resolveProjectColor(group),
        first: rows[index - 1]?.kind === "group",
        last: next === undefined || next.kind === "group" || next.depth !== 1,
      };
    },
    [rows, groupById],
  );

  const toggleExpand = useCallback((habit: Habit) => {
    haptics.selection();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(habit.id)) next.add(habit.id);
      return next;
    });
  }, []);

  /** A release that moved is the reorder (already persisted); one that did not opens the menu on the phone and does nothing in the browser. */
  const onDragRelease = useCallback(
    (from: number, to: number) => {
      if (from !== to) haptics.impact("light");
      const action = dragReleaseAction({
        from,
        to,
        selectMode: false,
        isWeb: Platform.OS === "web",
      });
      const row = rows[from];
      if (action !== "menu" || !row) return;
      openActions(row.kind === "group" ? row.group : row.habit, { x: 0, y: 0 });
    },
    [rows, openActions],
  );

  const onReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      const drop = resolveHabitDrop(rows, from, to);
      if (drop) applyHabitDrop(drop);
    },
    [rows, applyHabitDrop],
  );

  const header = useMemo(
    () => (
      /* Both halves flex so neither can push the other off a narrow screen. */
      <View className="flex-row gap-2 p-4 pb-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("habits.addHabit")}
          onPress={() => setAdding({ kind: "habit", parentId: null })}
          className="min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 px-2 py-3 dark:border-neutral-700"
        >
          <Plus size={16} className="shrink-0 text-accent-600" />
          <Text
            numberOfLines={1}
            className="shrink text-sm font-medium text-accent-700 dark:text-accent-300"
          >
            {t("habits.addHabit")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("habits.newGroup")}
          onPress={() => setAdding({ kind: "group", parentId: null })}
          className="min-w-0 flex-1 flex-row items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 px-2 py-3 dark:border-neutral-700"
        >
          <FolderPlus size={16} className="shrink-0 text-accent-600" />
          <Text
            numberOfLines={1}
            className="shrink text-sm font-medium text-accent-700 dark:text-accent-300"
          >
            {t("habits.newGroup")}
          </Text>
        </Pressable>
      </View>
    ),
    [t],
  );

  const menuItems: ContextMenuItem[] = useMemo(() => {
    const habit = menu?.habit;
    if (!habit) return [];
    const isGroup = habit.kind === "group";
    // A member's neighbours are its routine's other habits, so Move up swaps within the routine.
    const siblings = habitSiblings(habits, habit);
    const index = siblings.findIndex((h) => h.id === habit.id);

    return [
      ...(isGroup
        ? [
            {
              key: "add",
              label: t("habits.addToGroup"),
              icon: Plus,
              onPress: () => setAdding({ kind: "habit" as HabitKind, parentId: habit.id }),
            },
          ]
        : [
            {
              key: "move",
              label: habit.parent_id === null ? t("habits.moveToGroup") : t("habits.changeGroup"),
              icon: FolderPlus,
              onPress: () => setPicking(habit),
            },
          ]),
      // The keyboard and screen-reader path to the order a drag expresses; also works when the pointer drag is degraded.
      ...(index > 0
        ? [
            {
              key: "up",
              label: t("common.moveUp"),
              icon: ChevronUp,
              onPress: () => reorderSibling(habit.id, "up"),
            },
          ]
        : []),
      ...(index >= 0 && index < siblings.length - 1
        ? [
            {
              key: "down",
              label: t("common.moveDown"),
              icon: ChevronDown,
              onPress: () => reorderSibling(habit.id, "down"),
            },
          ]
        : []),
      {
        key: "archive",
        label: isGroup ? t("habits.archiveGroup") : t("habits.archive"),
        icon: Archive,
        separatorBefore: true,
        onPress: () => {
          const undo = setArchived(habit.id, true);
          toast.show(t(isGroup ? "toast.habitGroupArchived" : "toast.habitArchived"), {
            label: t("common.undo"),
            run: undo,
          });
        },
      },
      {
        key: "delete",
        label: t("common.delete"),
        icon: Trash2,
        danger: true,
        separatorBefore: true,
        onPress: () => {
          // Soft-delete: lands in Trash for 30 days. Members are not cascaded, so restoring brings the routine back.
          const undo = removeHabit(habit.id);
          toast.show(t(isGroup ? "toast.habitGroupDeleted" : "toast.habitDeleted"), {
            label: t("common.undo"),
            run: undo,
          });
        },
      },
    ];
  }, [menu, habits, t, toast, setArchived, removeHabit, reorderSibling]);

  return (
    <ScreenFade>
      <View
        className="flex-1 bg-white dark:bg-zinc-950"
        onLayout={(e) => setListWidth(e.nativeEvent.layout.width)}
      >
        {/* Outside the list rather than in its header, so both controls survive a scope that
            empties the list -- otherwise the only way back to All, or back to today, would be
            hidden behind the filter itself. */}
        {habits.length > 0 && (
          <View className="gap-2 px-4 pb-1 pt-3">
            {/* Above the filter, because it is the wider statement: it decides which day everything
                below it is about, and the filter then decides how much of that day to show. */}
            <Segmented
              label={t("habits.day")}
              value={day}
              onChange={(next) => {
                haptics.selection();
                setDay(next);
              }}
              options={[
                { value: "today", label: t("habits.dayToday") },
                { value: "yesterday", label: t("habits.dayYesterday") },
              ]}
            />
            {/* "Due" rather than "Today": the filter follows the day above it, so naming a day here
                would contradict it the moment you step back. */}
            <Segmented
              label={t("habits.scope")}
              value={habitsScope}
              onChange={(scope) => {
                haptics.selection();
                setHabitsScope(scope);
              }}
              options={[
                { value: "today", label: t("habits.scopeDue") },
                { value: "all", label: t("habits.scopeAll") },
              ]}
            />
          </View>
        )}

        {habits.length === 0 ? (
          <EmptyState
            icon={Flame}
            title={t("habits.emptyTitle")}
            description={t("habits.empty")}
            actions={[
              {
                label: t("habits.addHabit"),
                onPress: () => setAdding({ kind: "habit", parentId: null }),
                primary: true,
              },
              {
                label: t("habits.newGroup"),
                onPress: () => setAdding({ kind: "group", parentId: null }),
              },
            ]}
          />
        ) : rows.length === 0 ? (
          // Habits exist, but none are due today: say so and offer the way out.
          <EmptyState
            icon={Flame}
            title={t(yesterday ? "habits.nothingYesterdayTitle" : "habits.nothingTodayTitle")}
            description={t(yesterday ? "habits.nothingYesterdayBody" : "habits.nothingTodayBody")}
            // The Add/New group buttons live in the list header, which does not render when the list is empty.
            actions={[
              {
                label: t("habits.scopeShowAll"),
                onPress: () => setHabitsScope("all"),
                primary: true,
              },
              {
                label: t("habits.addHabit"),
                onPress: () => setAdding({ kind: "habit", parentId: null }),
              },
              {
                label: t("habits.newGroup"),
                onPress: () => setAdding({ kind: "group", parentId: null }),
              },
            ]}
          />
        ) : (
          <ReorderableList
            data={rows}
            keyExtractor={(row, i) => row?.key ?? String(i)}
            onReorder={onReorder}
            ListHeaderComponent={header}
            ListFooterComponent={
              <View className="pb-6">
                <HabitDayLegend />
                {hiddenByScope > 0 && (
                  <Text className="px-4 pt-1 text-xs text-neutral-500">
                    {t(yesterday ? "habits.hiddenYesterday" : "habits.hiddenToday", {
                      count: hiddenByScope,
                    })}
                  </Text>
                )}
              </View>
            }
            panGesture={dragPan}
            // A worklet: the library calls this on the UI thread, and a plain arrow throws there.
            onDragEnd={({ from, to }) => {
              "worklet";
              scheduleOnRN(onDragRelease, from, to);
            }}
            renderItem={({ item, index }) => (
              // Entering-only: a layout animation would fight the library's drag transform.
              <AnimatedRow layout={false} exit={false}>
                {/* Groups drag too: the header arrives alone, and `resolveHabitDrop` re-ranks it
                    against the top level, which carries its members with it (lib/habitReorder). */}
                <DragToReorder enabled={canReorder}>
                  {(startDrag) =>
                    item.kind === "group" ? (
                      <HabitGroupHeader
                        group={item.group}
                        summary={groupSummary(item.group.id)}
                        yesterday={yesterday}
                        expanded={item.expanded}
                        open={opensBox(index)}
                        startDrag={startDrag}
                        onToggle={(group) => {
                          haptics.selection();
                          toggleGroup(group.id);
                        }}
                        onOpen={onOpenHabit}
                        onOpenActions={openActions}
                      />
                    ) : (
                      <HabitCard
                        habit={item.habit}
                        summary={habitSummary(item.habit.id)}
                        dayKey={dayKey}
                        yesterday={yesterday}
                        weekStartsOn={weekStartsOn}
                        enclosure={enclosureFor(item, index)}
                        startDrag={startDrag}
                        expanded={expanded.has(item.habit.id)}
                        onToggleExpand={toggleExpand}
                        onOpen={onOpenHabit}
                        onOpenActions={openActions}
                        inlineStrip={inlineStrip}
                      />
                    )
                  }
                </DragToReorder>
              </AnimatedRow>
            )}
            style={{ flex: 1 }}
          />
        )}

        {menu !== null && (
          <ContextMenu items={menuItems} pos={menu.pos} onClose={() => setMenu(null)} />
        )}

        {picking !== null && (
          <HabitGroupPicker
            habit={picking}
            groups={habits.filter((h) => h.kind === "group")}
            onPick={(groupId: string | null) => {
              moveHabit(picking.id, groupId);
              setPicking(null);
            }}
            onClose={() => setPicking(null)}
          />
        )}

        <AddHabitSheet
          visible={adding !== null}
          kind={adding?.kind ?? "habit"}
          groupName={adding?.parentId != null ? groupById.get(adding.parentId)?.name : undefined}
          weekStartsOn={weekStartsOn}
          onClose={() => setAdding(null)}
          onAdd={(spec) =>
            createHabit({ ...spec, kind: adding?.kind, parent_id: adding?.parentId ?? null })
          }
        />
      </View>
    </ScreenFade>
  );
}
