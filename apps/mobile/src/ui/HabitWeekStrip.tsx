import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  dateKeyFromMs,
  isScheduledOn,
  shiftDateKey,
  weekdayLabels,
  weekdayOfKey,
  type CheckinState,
  type Habit,
} from "@atlastodo/shared";

/**
 * The seven days ending on the shown one, as labelled circles (weekday and date), the smallest
 * thing you can aim at to correct a day. Older days are edited on the detail screen's month
 * calendar. Tapping a circle cycles that day through `onToggleDay`.
 */
export function HabitWeekStrip({
  habit,
  states,
  isBackfilled,
  dayKey,
  weekStartsOn,
  fullWidth = false,
  onToggleDay,
}: {
  habit: Habit;
  states: ReadonlyMap<string, CheckinState>;
  isBackfilled: (date: string) => boolean;
  dayKey: string;
  /** Not for layout (the strip rolls); resolves which schedule governed each day. */
  weekStartsOn: number;
  fullWidth?: boolean;
  onToggleDay?: (date: string) => void;
}) {
  const { t } = useTranslation();
  // Oldest first, ending on the shown day, so the rightmost circle is the one most likely tapped.
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => shiftDateKey(dayKey, i - 6)),
    [dayKey],
  );
  // Sunday-based, indexed by the day's own weekday; a fixed week start is meaningless for a rolling strip.
  const names = weekdayLabels(0);
  const createdKey = habit.created_at > 0 ? dateKeyFromMs(habit.created_at) : "";

  return (
    // Sharing a row with the name, a fixed gap keeps the circles one strip; on a row of their own
    // they distribute. `justify-between` also keeps seven 36px circles inside a 320px phone.
    <View
      className={
        fullWidth ? "flex-1 flex-row justify-between" : "shrink-0 flex-row justify-end gap-2"
      }
    >
      {days.map((day) => {
        const state = states.get(day);
        const scheduled = isScheduledOn(habit, day, weekStartsOn);
        const backfilled = state === "done" && isBackfilled(day);
        const current = day === dayKey;
        // Every day before the shown one is settled: due and not recorded means missed. The shown
        // day is still open, so it stays empty and only carries the ring; so do days before the
        // habit existed, which nobody could have missed.
        const missed = state === undefined && scheduled && !current && day >= createdKey;
        const label = t("habits.dayState", {
          date: day,
          state: t(
            state === "done"
              ? "habits.stateDone"
              : state === "skip"
                ? "habits.stateSkipped"
                : missed
                  ? "habits.stateMissed"
                  : scheduled
                    ? "habits.stateNone"
                    : "habits.stateNotDue",
          ),
        });

        const circle = (
          <View
            className={
              "h-9 w-9 items-center justify-center rounded-full " +
              (state === "done"
                ? backfilled
                  ? "border-2"
                  : ""
                : state === "skip"
                  ? "border border-dashed border-neutral-400 dark:border-neutral-500"
                  : missed
                    ? "bg-neutral-300 dark:bg-neutral-700"
                    : scheduled
                      ? "border border-neutral-300 dark:border-neutral-600"
                      : "")
            }
            style={
              state === "done"
                ? backfilled
                  ? { borderColor: habit.color }
                  : { backgroundColor: habit.color }
                : undefined
            }
          >
            <Text
              className={
                "text-xs " +
                (state === "done" && !backfilled
                  ? "font-medium text-white"
                  : scheduled
                    ? "text-neutral-700 dark:text-neutral-100"
                    : "text-neutral-500 dark:text-neutral-600")
              }
            >
              {Number(day.slice(8, 10))}
            </Text>
            {/* The shown day's accent ring, drawn outside the circle so it neither resizes the strip
                nor hides a done day's fill. */}
            {current && (
              <View
                pointerEvents="none"
                className="absolute -inset-[3px] rounded-full border-2 border-accent-500 dark:border-accent-400"
              />
            )}
          </View>
        );

        return (
          <View key={day} className="items-center gap-1">
            <Text
              className={
                "text-xs " +
                (current
                  ? "font-semibold text-accent-600 dark:text-accent-400"
                  : "text-neutral-500")
              }
            >
              {names[weekdayOfKey(day)]}
            </Text>
            {onToggleDay ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={label}
                onPress={() => onToggleDay(day)}
              >
                {circle}
              </Pressable>
            ) : (
              <View accessible accessibilityLabel={label}>
                {circle}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/** What each circle style means, once under the list rather than on every card. */
export function HabitDayLegend() {
  const { t } = useTranslation();
  const items: { key: string; label: string; swatch: string }[] = [
    { key: "done", label: t("habits.legendDone"), swatch: "bg-accent-500" },
    {
      key: "missed",
      label: t("habits.legendMissed"),
      swatch: "bg-neutral-300 dark:bg-neutral-700",
    },
    {
      key: "skipped",
      label: t("habits.legendSkipped"),
      swatch: "border border-dashed border-neutral-400 dark:border-neutral-500",
    },
    {
      key: "upcoming",
      label: t("habits.legendUpcoming"),
      swatch: "border border-neutral-300 dark:border-neutral-600",
    },
    {
      key: "today",
      label: t("habits.legendToday"),
      swatch: "border-2 border-accent-500 dark:border-accent-400",
    },
  ];
  return (
    <View
      accessibilityLabel={t("habits.legend")}
      className="flex-row flex-wrap items-center gap-x-4 gap-y-1.5 px-4 pb-2 pt-1"
    >
      {items.map((item) => (
        <View key={item.key} className="flex-row items-center gap-1.5">
          <View className={`h-3 w-3 rounded-full ${item.swatch}`} />
          <Text className="text-xs text-neutral-500 dark:text-neutral-400">{item.label}</Text>
        </View>
      ))}
    </View>
  );
}
