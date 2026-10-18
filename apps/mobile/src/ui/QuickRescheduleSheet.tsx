import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { quickScheduleOptions, type QuickScheduleOption } from "@atlastodo/shared";
import { BottomSheet } from "./BottomSheet";
import { haptics } from "../lib/haptics";

/** A bottom sheet of quick reschedule choices (today / tomorrow / this weekend / next week, plus clear), opened by swiping left on a task row. Uses the pure `quickScheduleOptions`. */

export interface QuickRescheduleSheetProps {
  title: string | null;
  now: number;
  timeZone?: string;
  onPick: (dueAt: number | null) => void;
  onClose: () => void;
}

const DUE_LABEL: Record<QuickScheduleOption["key"], string> = {
  today: "task.scheduleToday",
  tomorrow: "task.scheduleTomorrow",
  weekend: "task.scheduleWeekend",
  nextWeek: "task.scheduleNextWeek",
};

export function QuickRescheduleSheet({
  title,
  now,
  timeZone,
  onPick,
  onClose,
}: QuickRescheduleSheetProps) {
  const { t } = useTranslation();
  const options = quickScheduleOptions(now, timeZone);

  return (
    <BottomSheet
      visible={title !== null}
      onClose={onClose}
      title={t("task.reschedule") + (title != null && title !== "" ? `: ${title}` : "")}
    >
      <View className="gap-1">
        {options.map((opt) => (
          <Pressable
            key={opt.key}
            accessibilityRole="button"
            accessibilityLabel={t(DUE_LABEL[opt.key])}
            onPress={() => {
              haptics.selection();
              onPick(opt.dueAt);
            }}
            className="rounded-md px-2 py-3 active:bg-neutral-100 dark:active:bg-neutral-800"
          >
            <Text className="text-sm text-neutral-900 dark:text-neutral-100">
              {t(DUE_LABEL[opt.key])}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("task.scheduleNoDate")}
          onPress={() => {
            haptics.selection();
            onPick(null);
          }}
          className="rounded-md px-2 py-3 active:bg-neutral-100 dark:active:bg-neutral-800"
        >
          <Text className="text-sm text-neutral-500">{t("task.scheduleNoDate")}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}
