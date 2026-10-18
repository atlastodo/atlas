import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { parseRule, ruleToString, type Rule } from "@atlastodo/shared";
import { RecurrenceEditor } from "../RecurrenceEditor";
import { Calendar, CalendarDays, Check, Repeat, X } from "../icons";
import { Panel, PanelButton, SheetOption } from "./parts";

// Same English codes as RecurrenceEditor; no shared weekday-name i18n keys exist.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function RecurrenceWebPanel({
  recurrence,
  onChange,
  onClose,
}: {
  recurrence: string | null;
  onChange: (rule: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("recurrence.repeat")} onBack={onClose}>
      <RecurrenceEditor value={recurrence} onChange={onChange} />
      <PanelButton label={t("common.done")} onPress={onClose} />
    </Panel>
  );
}

const UNIT: Record<Rule["freq"], [string, string]> = {
  daily: ["day", "days"],
  weekly: ["week", "weeks"],
  monthly: ["month", "months"],
  yearly: ["year", "years"],
};

export function RecurrenceSheetBody({
  draftRecurrence,
  setDraftRecurrence,
  summarizeRule,
}: {
  draftRecurrence: string | null | undefined;
  setDraftRecurrence: (rule: string | null) => void;
  summarizeRule: (rule: string) => string | null;
}) {
  const { t } = useTranslation();
  const parsedRule = draftRecurrence ? parseRule(draftRecurrence) : null;
  const isWeekdays =
    parsedRule?.freq === "weekly" &&
    parsedRule?.interval === 1 &&
    parsedRule?.byday.length === 5 &&
    [0, 1, 2, 3, 4].every((d) => parsedRule.byday.includes(d));

  const updateRule = (patch: Partial<Rule>) => {
    const current: Rule = parsedRule ?? {
      freq: "weekly",
      interval: 1,
      byday: [],
      bymonthday: null,
      mode: "on_schedule",
    };
    setDraftRecurrence(ruleToString({ ...current, ...patch }));
  };

  const preset = (freq: Rule["freq"], byday: number[]) =>
    setDraftRecurrence(
      ruleToString({
        freq,
        interval: 1,
        byday,
        bymonthday: null,
        mode: parsedRule?.mode ?? "on_schedule",
      }),
    );

  const presets = [
    {
      label: t("recurrence.daily"),
      icon: Calendar,
      selected:
        parsedRule?.freq === "daily" &&
        parsedRule?.interval === 1 &&
        (parsedRule?.byday.length ?? 0) === 0,
      onPress: () => preset("daily", []),
    },
    {
      label: t("recurrence.weekdays") ?? "Weekdays (Mon–Fri)",
      icon: CalendarDays,
      selected: isWeekdays,
      onPress: () => preset("weekly", [0, 1, 2, 3, 4]),
    },
    {
      label: t("recurrence.weekly"),
      icon: Repeat,
      selected: parsedRule?.freq === "weekly" && !isWeekdays,
      onPress: () => preset("weekly", []),
    },
    {
      label: t("recurrence.monthly"),
      icon: CalendarDays,
      selected: parsedRule?.freq === "monthly" && parsedRule?.interval === 1,
      onPress: () => preset("monthly", []),
    },
    {
      label: t("recurrence.yearly"),
      icon: Repeat,
      selected: parsedRule?.freq === "yearly" && parsedRule?.interval === 1,
      onPress: () => preset("yearly", []),
    },
  ];

  const isNone = draftRecurrence === null;
  return (
    <View className="gap-3.5 pb-4">
      <SheetOption
        role="radio"
        accessibilityState={{ selected: isNone }}
        label={t("recurrence.doesNotRepeat")}
        icon={X}
        selected={isNone}
        onPress={() => setDraftRecurrence(null)}
      />
      {presets.map((p) => (
        <SheetOption
          key={p.label}
          role="radio"
          accessibilityState={{ selected: p.selected }}
          label={p.label}
          icon={p.icon}
          selected={p.selected}
          onPress={p.onPress}
        />
      ))}

      {parsedRule && (
        <View className="mt-2 gap-3.5 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <View className="flex-row items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50/50 p-4 dark:border-neutral-800 dark:bg-neutral-800/30">
            <Text className="text-base font-semibold text-neutral-800 dark:text-neutral-200">
              {t("recurrence.every") ?? "Every"}
            </Text>
            <View className="flex-row items-center gap-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="-"
                onPress={() =>
                  updateRule({ interval: Math.max(1, (parsedRule.interval ?? 1) - 1) })
                }
                className="h-10 w-10 items-center justify-center rounded-xl border border-neutral-300 bg-white active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:active:bg-neutral-700"
              >
                <Text className="text-lg font-bold text-neutral-700 dark:text-neutral-300">−</Text>
              </Pressable>
              <Text className="min-w-6 text-center text-lg font-bold text-neutral-900 dark:text-neutral-100">
                {parsedRule.interval ?? 1}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="+"
                onPress={() => updateRule({ interval: (parsedRule.interval ?? 1) + 1 })}
                className="h-10 w-10 items-center justify-center rounded-xl border border-neutral-300 bg-white active:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800 dark:active:bg-neutral-700"
              >
                <Text className="text-lg font-bold text-neutral-700 dark:text-neutral-300">+</Text>
              </Pressable>
              <Text className="text-base font-medium capitalize text-neutral-600 dark:text-neutral-400">
                {UNIT[parsedRule.freq][(parsedRule.interval ?? 1) === 1 ? 0 : 1]}
              </Text>
            </View>
          </View>

          {parsedRule.freq === "weekly" && (
            <View className="gap-2 pt-1">
              <Text className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                {t("recurrence.repeatOn") ?? "Repeat on"}
              </Text>
              <View
                accessibilityRole="radiogroup"
                className="flex-row items-center justify-between gap-1"
              >
                {WEEKDAYS.map((label, day) => {
                  const on = parsedRule.byday.includes(day);
                  return (
                    <Pressable
                      key={label}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={label}
                      onPress={() =>
                        updateRule({
                          byday: on
                            ? parsedRule.byday.filter((d) => d !== day)
                            : [...parsedRule.byday, day].sort((a, b) => a - b),
                        })
                      }
                      className={
                        "h-11 w-11 items-center justify-center rounded-full border " +
                        (on
                          ? "border-accent-600 bg-accent-600 dark:border-accent-500 dark:bg-accent-500"
                          : "border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800")
                      }
                    >
                      <Text
                        className={
                          "text-sm font-bold " +
                          (on ? "text-white" : "text-neutral-700 dark:text-neutral-300")
                        }
                      >
                        {label.slice(0, 1)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: parsedRule.mode === "after_completion" }}
            accessibilityLabel={t("recurrence.fromCompletion")}
            onPress={() =>
              updateRule({
                mode: parsedRule.mode === "after_completion" ? "on_schedule" : "after_completion",
              })
            }
            className="flex-row items-center justify-between rounded-2xl border border-neutral-200 bg-neutral-50/50 p-4 dark:border-neutral-800 dark:bg-neutral-800/30"
          >
            <Text className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t("recurrence.fromCompletion")}
            </Text>
            <View
              className={
                "h-6 w-6 items-center justify-center rounded-lg border " +
                (parsedRule.mode === "after_completion"
                  ? "border-accent-600 bg-accent-600 dark:border-accent-500 dark:bg-accent-500"
                  : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-800")
              }
            >
              {parsedRule.mode === "after_completion" && <Check size={16} className="text-white" />}
            </View>
          </Pressable>

          {draftRecurrence != null && (
            <View className="flex-row items-center gap-2.5 rounded-2xl bg-accent-50 p-3.5 dark:bg-accent-950">
              <Repeat size={18} className="text-accent-600 dark:text-accent-400" />
              <Text className="text-sm font-semibold text-accent-700 dark:text-accent-300">
                {summarizeRule(draftRecurrence)}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}
