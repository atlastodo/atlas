import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { formatRule, parseRule, ruleToString, type Freq, type Rule } from "@atlas/shared";
import { Check, Repeat } from "./icons";

/**
 * Edit a task's recurrence rule. Controlled: reads the rule string from `value` and emits the new
 * string (or null for off) via `onChange`. The rule engine is `@atlas/shared`'s (`parseRule`,
 * `ruleToString`, `formatRule`); completing a recurring task rolls it in `taskOps.toggleTask`. The
 * summary is in the UI language; weekday codes stay English.
 */

export interface RecurrenceEditorProps {
  value: string | null;
  onChange: (rule: string | null) => void;
}

const FREQS: { value: Freq; labelKey: string }[] = [
  { value: "daily", labelKey: "recurrence.daily" },
  { value: "weekly", labelKey: "recurrence.weekly" },
  { value: "monthly", labelKey: "recurrence.monthly" },
  { value: "yearly", labelKey: "recurrence.yearly" },
];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function RecurrenceEditor({ value, onChange }: RecurrenceEditorProps) {
  const { t } = useTranslation();
  const rule = value ? parseRule(value) : null;

  const emit = (next: Rule | null) => onChange(next ? ruleToString(next) : null);

  const setFreq = (freq: Freq | "") => {
    if (freq === "") return emit(null);
    emit({
      freq,
      interval: rule?.interval ?? 1,
      byday: freq === "weekly" ? (rule?.byday ?? []) : [],
      // Saving takes a monthly rule's day of month from the task's due date (`updateTask`).
      bymonthday: freq === "monthly" ? (rule?.bymonthday ?? null) : null,
      mode: rule?.mode ?? "on_schedule",
    });
  };

  const toggleDay = (day: number) => {
    if (!rule) return;
    const has = rule.byday.includes(day);
    const byday = has
      ? rule.byday.filter((d) => d !== day)
      : [...rule.byday, day].sort((a, b) => a - b);
    emit({ ...rule, byday });
  };

  const bumpInterval = (delta: number) => {
    if (!rule) return;
    emit({ ...rule, interval: Math.max(1, rule.interval + delta) });
  };

  const summary = value ? formatRule(value, (key, params) => t(key, params)) : null;

  const freqChoices: { value: Freq | ""; labelKey: string }[] = [
    { value: "", labelKey: "recurrence.doesNotRepeat" },
    ...FREQS,
  ];

  return (
    <View className="gap-3">
      <View className="flex-row items-center gap-2">
        <Repeat size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("recurrence.repeat")}</Text>
      </View>

      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1.5">
        {freqChoices.map((f) => {
          const active = (rule?.freq ?? "") === f.value;
          return (
            <Pressable
              key={f.value || "__none__"}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t(f.labelKey)}
              onPress={() => setFreq(f.value)}
              className={
                "rounded-md border px-2.5 py-1.5 " +
                (active
                  ? "border-accent-600 bg-accent-50 dark:bg-accent-900"
                  : "border-neutral-200 dark:border-neutral-800")
              }
            >
              <Text
                className={
                  "text-xs " +
                  (active
                    ? "text-accent-700 dark:text-accent-300"
                    : "text-neutral-600 dark:text-neutral-300")
                }
              >
                {t(f.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {rule && (
        <View className="flex-row items-center gap-2">
          <Text className="text-sm text-neutral-500">{t("recurrence.every")}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="-"
            onPress={() => bumpInterval(-1)}
            className="h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800"
          >
            <Text className="text-base text-neutral-600 dark:text-neutral-300">-</Text>
          </Pressable>
          <Text
            accessibilityLabel={t("recurrence.interval")}
            className="min-w-6 text-center text-sm text-neutral-900 dark:text-neutral-100"
          >
            {rule.interval}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="+"
            onPress={() => bumpInterval(1)}
            className="h-8 w-8 items-center justify-center rounded-md border border-neutral-200 dark:border-neutral-800"
          >
            <Text className="text-base text-neutral-600 dark:text-neutral-300">+</Text>
          </Pressable>
        </View>
      )}

      {rule?.freq === "weekly" && (
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1">
          {WEEKDAYS.map((label, day) => {
            const on = rule.byday.includes(day);
            return (
              <Pressable
                key={label}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={label}
                onPress={() => toggleDay(day)}
                className={
                  "rounded px-2 py-1 " +
                  (on ? "bg-accent-500" : "bg-neutral-100 dark:bg-neutral-800")
                }
              >
                <Text
                  className={
                    "text-xs " + (on ? "text-white" : "text-neutral-600 dark:text-neutral-300")
                  }
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {rule && (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: rule.mode === "after_completion" }}
          accessibilityLabel={t("recurrence.fromCompletion")}
          onPress={() =>
            emit({
              ...rule,
              mode: rule.mode === "after_completion" ? "on_schedule" : "after_completion",
            })
          }
          className="flex-row items-center gap-2"
        >
          <View
            className={
              "h-4 w-4 items-center justify-center rounded border " +
              (rule.mode === "after_completion"
                ? "border-accent-600 bg-accent-600"
                : "border-neutral-400")
            }
          >
            {rule.mode === "after_completion" && <Check size={12} className="text-white" />}
          </View>
          <Text className="text-xs text-neutral-500">{t("recurrence.fromCompletion")}</Text>
        </Pressable>
      )}

      {summary != null && <Text className="text-xs text-neutral-500">{summary}</Text>}
    </View>
  );
}
