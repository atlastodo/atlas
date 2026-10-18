import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { weekdayLabels, type HabitGoalKind } from "@atlastodo/shared";
import { Segmented } from "./Segmented";
import { Minus, Plus } from "./icons";
import { haptics } from "../lib/haptics";

/**
 * The goal editor, shared by the add sheet and the detail screen. Three shapes: daily picks
 * weekdays, weekly wants a count per week, interval wants a gap in days. The weekday row belongs to
 * `daily` alone, since a flexible goal is satisfied on any day.
 */
export interface HabitGoal {
  goal_kind: HabitGoalKind;
  days: number[];
  target: number;
}

const MAX_WEEKLY = 7;
const MAX_INTERVAL = 365;

function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const step = (delta: number) => {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next === value) return;
    haptics.selection();
    onChange(next);
  };
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-sm text-neutral-700 dark:text-neutral-200">{label}</Text>
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("habits.decrease")}
          disabled={value <= min}
          onPress={() => step(-1)}
          hitSlop={8}
          className={
            "h-8 w-8 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 " +
            (value <= min ? "opacity-40" : "")
          }
        >
          <Minus size={16} className="text-neutral-600 dark:text-neutral-300" />
        </Pressable>
        <Text
          accessibilityLabel={t("habits.goalValue", { value })}
          className="min-w-6 text-center text-base font-semibold text-neutral-900 dark:text-neutral-50"
        >
          {value}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("habits.increase")}
          disabled={value >= max}
          onPress={() => step(1)}
          hitSlop={8}
          className={
            "h-8 w-8 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 " +
            (value >= max ? "opacity-40" : "")
          }
        >
          <Plus size={16} className="text-neutral-600 dark:text-neutral-300" />
        </Pressable>
      </View>
    </View>
  );
}

export function HabitGoalEditor({
  goal,
  weekStartsOn,
  onChange,
}: {
  goal: HabitGoal;
  weekStartsOn: number;
  onChange: (patch: Partial<HabitGoal>) => void;
}) {
  const { t } = useTranslation();
  const order = Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7);
  const labels = weekdayLabels(weekStartsOn);

  const toggleDay = (day: number) => {
    haptics.selection();
    const next = goal.days.includes(day)
      ? goal.days.filter((d) => d !== day)
      : [...goal.days, day].sort((a, b) => a - b);
    onChange({ days: next });
  };

  return (
    <View className="gap-3">
      <Segmented
        label={t("habits.goal")}
        value={goal.goal_kind}
        onChange={(goal_kind) => {
          haptics.selection();
          // Each kind reads `target` differently; reset it to that kind's default.
          onChange({
            goal_kind,
            target: goal_kind === "weekly" ? 3 : goal_kind === "interval" ? 2 : 1,
          });
        }}
        options={[
          { value: "daily", label: t("habits.goalDaily") },
          { value: "weekly", label: t("habits.goalWeekly") },
          { value: "interval", label: t("habits.goalInterval") },
        ]}
      />

      {goal.goal_kind === "daily" && (
        <View className="gap-1">
          <View className="flex-row gap-1">
            {order.map((day, i) => {
              const on = goal.days.length === 0 || goal.days.includes(day);
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={t("habits.toggleWeekday", { day: labels[i] })}
                  accessibilityState={{ selected: on }}
                  onPress={() => toggleDay(day)}
                  className={
                    "h-8 flex-1 items-center justify-center rounded-full " +
                    (on ? "bg-accent-100 dark:bg-accent-950" : "bg-neutral-100 dark:bg-neutral-800")
                  }
                >
                  <Text
                    className={
                      "text-xs " +
                      (on ? "font-medium text-accent-700 dark:text-accent-300" : "text-neutral-500")
                    }
                  >
                    {labels[i]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text className="text-xs text-neutral-500">
            {goal.days.length === 0
              ? t("habits.everyDay")
              : t("habits.daysPerWeek", { count: goal.days.length })}
          </Text>
        </View>
      )}

      {goal.goal_kind === "weekly" && (
        <Stepper
          label={t("habits.timesPerWeek")}
          value={goal.target}
          min={1}
          max={MAX_WEEKLY}
          onChange={(target) => onChange({ target })}
        />
      )}

      {goal.goal_kind === "interval" && (
        <Stepper
          label={t("habits.everyNDays")}
          value={goal.target}
          min={1}
          max={MAX_INTERVAL}
          onChange={(target) => onChange({ target })}
        />
      )}
    </View>
  );
}
