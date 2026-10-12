import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import DateTimePicker, { type DateTimePickerEvent } from "./DateTimePicker";
import { reminderFireAt } from "@atlas/shared";
import type { Task } from "@atlas/client-core";
import { useReminders, type NewReminder } from "../hooks/useReminders";
import { explainNotifications } from "../lib/permissionExplainer";
import { NotifyPermissionHint } from "./NotifyPermissionHint";
import { useFormat } from "../hooks/useFormat";
import { usePreferences } from "../hooks/usePreferences";
import { useToast } from "../data/ToastProvider";
import { Bell, CalendarDays, Plus, X } from "./icons";

/**
 * Reminders for a task: the task's reminders and controls to add one, relative to the due date or
 * at an absolute time. Self-contained (reads `useReminders`, takes only `task`). The reminders
 * switch lives in Settings (`reminders_enabled`), not here; adding a reminder is what asks for
 * notification permission. Reminders fire through the OS, so they work with the app closed.
 */

const OFFSETS: { labelKey: string; minutes: number }[] = [
  { labelKey: "reminder.offset1w", minutes: 7 * 24 * 60 },
  { labelKey: "reminder.offset1d", minutes: 24 * 60 },
  { labelKey: "reminder.offset10m", minutes: 10 },
];

export function ReminderSection({ task }: { task: Task }) {
  const { t } = useTranslation();
  const { forTask, setReminder, removeReminder } = useReminders();
  const { remindersEnabled, timezone } = usePreferences();
  const fmt = useFormat();
  const toast = useToast();
  const [picking, setPicking] = useState(false);

  const reminders = forTask(task.id);
  const reminder = reminders[0];

  const saveReminder = (spec: NewReminder) => {
    setReminder(task.id, spec);
    if (remindersEnabled) void explainNotifications();
  };

  const onPick = (event: DateTimePickerEvent, date?: Date) => {
    setPicking(false);
    if (event.type === "set" && date) saveReminder({ at: date.getTime() });
  };

  const permissionHint = remindersEnabled && reminder !== undefined;

  const formatFireAt = (ms: number | null): string =>
    ms === null ? t("reminder.whenDueSet") : fmt.dateTime(ms);

  const initialPickerDate = (): Date => {
    const now = new Date();
    if (reminder?.at != null && reminder.at > now.getTime()) {
      return new Date(reminder.at);
    }
    if (task.due_at != null) {
      const d = new Date(task.due_at);
      if (d.getHours() === 23 && d.getMinutes() >= 50) {
        d.setHours(9, 0, 0, 0);
        return d;
      }
      if (task.due_at > now.getTime()) {
        return d;
      }
    }
    const d = new Date(now);
    if (d.getHours() < 9) {
      d.setHours(9, 0, 0, 0);
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }
    return d;
  };

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Bell size={16} className="text-neutral-500" />
        <Text className="text-xs font-medium text-neutral-500">{t("reminder.heading")}</Text>
      </View>

      {reminder ? (
        <View className="flex-row items-center justify-between gap-2 rounded border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 dark:border-neutral-700 dark:bg-neutral-900">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("reminder.time")}
            onPress={() => setPicking(true)}
            className="flex-1 flex-row items-center gap-2"
          >
            <CalendarDays size={14} className="text-accent-600 dark:text-accent-400" />
            <Text className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
              {formatFireAt(reminderFireAt(reminder, task, timezone || undefined))}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("reminder.remove")}
            onPress={() => {
              const undo = removeReminder(reminder.id);
              toast.show(t("toast.reminderDeleted"), { label: t("common.undo"), run: undo });
            }}
            hitSlop={8}
          >
            <X size={14} className="text-neutral-500" />
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("reminder.add")}
          onPress={() => setPicking(true)}
          className="flex-row items-center gap-1.5 self-start rounded border border-neutral-200 px-2.5 py-1.5 dark:border-neutral-700"
        >
          <CalendarDays size={14} className="text-neutral-500" />
          <Plus size={12} className="text-neutral-500" />
          <Text className="text-xs text-neutral-600 dark:text-neutral-300">
            {t("reminder.add")}
          </Text>
        </Pressable>
      )}

      {task.due_at !== null && (
        <View className="flex-row flex-wrap gap-1">
          {OFFSETS.map((o) => {
            const isSelected = reminder?.offset_min_before_due === o.minutes;
            return (
              <Pressable
                key={o.minutes}
                accessibilityRole="button"
                accessibilityLabel={t(o.labelKey)}
                onPress={() => saveReminder({ offset_min_before_due: o.minutes })}
                className={`rounded px-2.5 py-1.5 ${
                  isSelected
                    ? "border border-accent-300 bg-accent-100 dark:border-accent-700 dark:bg-accent-950"
                    : "bg-neutral-100 dark:bg-neutral-800"
                }`}
              >
                <Text
                  className={`text-xs ${
                    isSelected
                      ? "font-medium text-accent-700 dark:text-accent-300"
                      : "text-neutral-600 dark:text-neutral-300"
                  }`}
                >
                  {t(o.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {permissionHint && <NotifyPermissionHint />}

      {picking && <DateTimePicker value={initialPickerDate()} mode="datetime" onChange={onPick} />}
    </View>
  );
}
