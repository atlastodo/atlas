import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { quickScheduleOptions, type QuickScheduleOption } from "@atlas/shared";
import DateTimePicker, { type DateTimePickerEvent } from "../DateTimePicker";
import { Calendar, ChevronRight, Check, X } from "../icons";
import { Panel, PanelButton, SheetOption } from "./parts";

/** Quick-schedule key to its i18n key; a literal map so `task.schedule*` stays greppable. */
const DUE_LABEL: Record<QuickScheduleOption["key"], string> = {
  today: "task.scheduleToday",
  tomorrow: "task.scheduleTomorrow",
  weekend: "task.scheduleWeekend",
  nextWeek: "task.scheduleNextWeek",
};

interface DuePickerProps {
  now: number;
  timeZone?: string;
  picking: boolean;
  setPicking: (next: boolean | ((on: boolean) => boolean)) => void;
  onPickDate: (event: DateTimePickerEvent, date?: Date) => void;
}

export function DueWebPanel({
  now,
  timeZone,
  dueAt,
  picking,
  setPicking,
  onPickDate,
  pick,
  onBack,
}: DuePickerProps & {
  dueAt: number | null | undefined;
  pick: (patch: { due_at: number | null }) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Panel title={t("taskDetail.dueDate")} onBack={onBack}>
      <View className="flex-row flex-wrap gap-2">
        {quickScheduleOptions(now, timeZone).map((opt) => (
          <PanelButton
            key={opt.key}
            label={t(DUE_LABEL[opt.key])}
            onPress={() => pick({ due_at: opt.dueAt })}
          />
        ))}
        <PanelButton label={t("task.scheduleMore")} onPress={() => setPicking((on) => !on)} />
        <PanelButton
          label={t("task.scheduleNoDate")}
          onPress={() => pick({ due_at: null })}
          muted
        />
      </View>
      {picking && (
        <DateTimePicker value={new Date(dueAt ?? now)} mode="date" onChange={onPickDate} />
      )}
    </Panel>
  );
}

export function DueSheetBody({
  now,
  timeZone,
  draftDue,
  setDraftDue,
  picking,
  setPicking,
  onPickDate,
  dueText,
}: DuePickerProps & {
  draftDue: number | null | undefined;
  setDraftDue: (ms: number | null) => void;
  dueText: (ms: number) => string;
}) {
  const { t } = useTranslation();
  const options = quickScheduleOptions(now, timeZone);
  const custom = draftDue != null && !options.some((o) => o.dueAt === draftDue) ? draftDue : null;
  return (
    <View className="gap-3 pb-4">
      {options.map((opt) => (
        <SheetOption
          key={opt.key}
          label={t(DUE_LABEL[opt.key])}
          icon={Calendar}
          selected={draftDue === opt.dueAt}
          onPress={() => setDraftDue(opt.dueAt)}
        />
      ))}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.scheduleMore")}
        onPress={() => setPicking(true)}
        className={
          "flex-row items-center justify-between rounded-2xl border p-4 " +
          (custom != null
            ? "border-accent-600 bg-accent-100 dark:bg-accent-950 active:bg-accent-200 dark:active:bg-neutral-800"
            : "border-neutral-200 bg-neutral-50/50 active:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/40 dark:active:bg-neutral-800")
        }
      >
        <View className="flex-row items-center gap-3">
          <Calendar size={22} className="text-neutral-500 dark:text-neutral-400" />
          <Text className="text-base font-semibold text-neutral-800 dark:text-neutral-200">
            {custom != null ? dueText(custom) : t("task.scheduleMore")}
          </Text>
        </View>
        <ChevronRight size={20} className="text-neutral-500" />
      </Pressable>

      {picking && (
        <DateTimePicker value={new Date(draftDue ?? now)} mode="date" onChange={onPickDate} />
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("task.scheduleNoDate")}
        onPress={() => setDraftDue(null)}
        className={
          "flex-row items-center justify-between rounded-2xl border p-4 " +
          (draftDue === null
            ? "border-neutral-400 bg-neutral-100 active:bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-800 dark:active:bg-neutral-700"
            : "border-neutral-200 bg-neutral-50/50 active:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/40 dark:active:bg-neutral-800")
        }
      >
        <View className="flex-row items-center gap-3">
          <X size={22} className="text-neutral-500" />
          <Text className="text-base font-medium text-neutral-600 dark:text-neutral-400">
            {t("task.scheduleNoDate")}
          </Text>
        </View>
        {draftDue === null && (
          <Check size={20} className="text-neutral-600 dark:text-neutral-400" />
        )}
      </Pressable>
    </View>
  );
}
