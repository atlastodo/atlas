import { useCallback, useMemo } from "react";
import {
  currentPeriod,
  currentStreak,
  dateKeyFromMs,
  flattenHabitGroups,
  habitGroupStreak,
  isActiveToday,
  habitGroupToday,
  type Habit,
  type HabitGroupDay,
  type HabitGroupMember,
  type HabitListRow,
  type PeriodResult,
} from "@atlastodo/shared";
import { useHabits } from "./useHabits";
import { useHabitCheckins } from "./useHabitCheckins";
import { usePreferences, type HabitsScope } from "./usePreferences";

/**
 * Everything the habits list draws, computed once per screen instead of once per row.
 *
 * The aggregate is memoised on the day key, not the instant: `HabitsScreen` reads `useNow()`, which
 * re-renders every minute, and a group's streak walks every member's history. Per-habit streaks
 * come out of the same pass.
 */

export interface HabitSummary {
  streak: number;
  period: PeriodResult | null;
}

export interface HabitGroupSummary {
  streak: number;
  today: HabitGroupDay | null;
  members: Habit[];
}

export interface UseHabitGroups {
  /** The list as drawn: groups, their members when expanded, and standalone habits. */
  rows: HabitListRow[];
  /** All habits and groups in display order, which a drop is resolved against. */
  habits: Habit[];
  /** How many rows the Today scope is holding back, so the screen can say where they went. */
  hiddenByScope: number;
  groupSummary: (groupId: string) => HabitGroupSummary;
  habitSummary: (habitId: string) => HabitSummary;
  toggleGroup: (groupId: string) => void;
}

const NO_GROUP: HabitGroupSummary = { streak: 0, today: null, members: [] };
const NO_HABIT: HabitSummary = { streak: 0, period: null };

export function useHabitGroups(todayMs: number, scope: HabitsScope = "all"): UseHabitGroups {
  const { habits, habitGroups } = useHabits();
  const { statesFor } = useHabitCheckins();
  const { weekStartsOn, habitGroupExpanded, setHabitGroupExpanded } = usePreferences();
  const todayKey = dateKeyFromMs(todayMs);

  const all = useMemo(
    () =>
      [...habits, ...habitGroups].sort(
        (a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at,
      ),
    [habits, habitGroups],
  );

  const { listed, hiddenByScope } = useMemo(() => {
    if (scope === "all") return { listed: all, hiddenByScope: 0 };
    const active = new Set(
      habits
        .filter((h) => isActiveToday(h, statesFor(h.id), todayMs, weekStartsOn))
        .map((h) => h.id),
    );
    const listed = all.filter((item) => {
      if (item.kind !== "group") return active.has(item.id);
      const members = habits.filter((h) => h.parent_id === item.id);
      // An empty group is kept: hiding it would strand a new routine with no way to add a habit.
      return members.length === 0 || members.some((h) => active.has(h.id));
    });
    return { listed, hiddenByScope: all.length - listed.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, habits, statesFor, scope, todayKey, weekStartsOn]);

  const rows = useMemo(
    () => flattenHabitGroups(listed, habitGroupExpanded),
    [listed, habitGroupExpanded],
  );

  const { groups, singles } = useMemo(() => {
    // `todayKey`, not `todayMs`, so a per-minute tick does not re-walk every member's history.
    const noon = new Date(
      Number(todayKey.slice(0, 4)),
      Number(todayKey.slice(5, 7)) - 1,
      Number(todayKey.slice(8, 10)),
      12,
    ).getTime();
    const groups = new Map<string, HabitGroupSummary>();
    for (const group of habitGroups) {
      const members: Habit[] = habits.filter((h) => h.parent_id === group.id);
      const scored: HabitGroupMember[] = members.map((habit) => ({
        habit,
        states: statesFor(habit.id),
      }));
      groups.set(group.id, {
        streak: habitGroupStreak(scored, noon, weekStartsOn),
        today: habitGroupToday(scored, noon, weekStartsOn),
        members,
      });
    }
    const singles = new Map<string, HabitSummary>();
    for (const habit of habits) {
      const states = statesFor(habit.id);
      singles.set(habit.id, {
        streak: currentStreak(habit, states, noon, weekStartsOn),
        period: currentPeriod(habit, states, noon, weekStartsOn),
      });
    }
    return { groups, singles };
  }, [habits, habitGroups, statesFor, todayKey, weekStartsOn]);

  const groupSummary = useCallback((id: string) => groups.get(id) ?? NO_GROUP, [groups]);
  const habitSummary = useCallback((id: string) => singles.get(id) ?? NO_HABIT, [singles]);
  const toggleGroup = useCallback(
    (id: string) => setHabitGroupExpanded(id, !habitGroupExpanded(id)),
    [habitGroupExpanded, setHabitGroupExpanded],
  );

  return { rows, habits: all, hiddenByScope, groupSummary, habitSummary, toggleGroup };
}
