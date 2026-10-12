import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlas/client-core";
import { formatDuration } from "@atlas/shared";
import { useFocus } from "../data/FocusProvider";
import { useFocusSessions } from "../hooks/useFocusSessions";
import { usePreferences } from "../hooks/usePreferences";
import { Play, Timer } from "./icons";

/**
 * Focus & time-tracking for a task: an optional time estimate, a "Start focus" button that
 * launches a pomodoro run on this task, and estimated-vs-tracked totals. Hidden when the `focus`
 * feature toggle is off.
 */
export function FocusSection({
  task,
  onUpdate,
}: {
  task: Task;
  onUpdate: (task: Task, patch: Partial<Task>) => void;
}) {
  const { t } = useTranslation();
  const { focusEnabled } = usePreferences();
  const { start, active, taskId, running } = useFocus();
  const { trackedMs } = useFocusSessions();
  const [estimateFocused, setEstimateFocused] = useState(false);

  if (!focusEnabled) return null;

  const tracked = trackedMs(task.id);
  const estimateMs = task.estimate_min != null ? task.estimate_min * 60_000 : null;
  const focusingThis = active && taskId === task.id;
  const pct =
    estimateMs && estimateMs > 0 ? Math.min(100, Math.round((tracked / estimateMs) * 100)) : null;

  return (
    <View className="gap-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
      <View className="flex-row items-center gap-2">
        <Timer size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("focus.heading")}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("focus.start")}
        accessibilityState={{ disabled: focusingThis }}
        disabled={focusingThis}
        onPress={() => start(task.id)}
        className={
          "flex-row items-center justify-center gap-1.5 rounded-md px-3 py-2 " +
          (focusingThis ? "bg-neutral-100 dark:bg-neutral-800" : "bg-accent-600")
        }
      >
        <Play size={16} className={focusingThis ? "text-neutral-500" : "text-white"} />
        <Text
          className={"text-sm font-medium " + (focusingThis ? "text-neutral-500" : "text-white")}
        >
          {focusingThis ? (running ? t("focus.focusing") : t("focus.paused")) : t("focus.start")}
        </Text>
      </Pressable>

      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-xs text-neutral-500">{t("focus.estimate")}</Text>
        {/* Bordered like the label input, with the unit as a suffix so the box reads as minutes. The
            wrapper carries the focus ring, since the bare input sits inside it. */}
        <View
          className={
            "w-28 flex-row items-center gap-1 rounded border px-2 " +
            (estimateFocused
              ? "border-accent-400 dark:border-accent-500"
              : "border-neutral-200 dark:border-neutral-700")
          }
        >
          <TextInput
            accessibilityLabel={t("focus.estimateAria")}
            keyboardType="number-pad"
            placeholder={t("focus.estimatePlaceholder")}
            placeholderTextColor="#737373"
            value={task.estimate_min != null ? String(task.estimate_min) : ""}
            onFocus={() => setEstimateFocused(true)}
            onBlur={() => setEstimateFocused(false)}
            onChangeText={(text) => {
              const digits = text.replace(/[^0-9]/g, "");
              onUpdate(task, { estimate_min: digits === "" ? null : Math.round(Number(digits)) });
            }}
            className="min-w-0 flex-1 bg-transparent py-1 text-right text-sm text-neutral-900 web:outline-none dark:text-neutral-100"
          />
          <Text className="text-sm text-neutral-500 dark:text-neutral-400">
            {t("focus.minutesSuffix")}
          </Text>
        </View>
      </View>

      <Text className="text-xs text-neutral-500">
        {t("focus.tracked")}{" "}
        <Text className="font-medium text-neutral-700 dark:text-neutral-200">
          {formatDuration(tracked)}
        </Text>
        {estimateMs != null
          ? ` ${t("focus.ofEstimated", { duration: formatDuration(estimateMs) })}`
          : ""}
      </Text>

      {pct != null && (
        <View className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
          <View className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
        </View>
      )}
    </View>
  );
}
