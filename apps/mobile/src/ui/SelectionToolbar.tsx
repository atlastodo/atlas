import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { PRIORITY_COLOR, quickScheduleOptions, type QuickScheduleOption } from "@atlastodo/shared";
import type { Priority } from "@atlastodo/client-core";
import {
  Copy,
  CalendarDays,
  CircleCheckBig,
  CopyPlus,
  Flag,
  FolderInput,
  ListTodo,
  RotateCcw,
  Tag,
  Trash2,
  X,
} from "./icons";

/**
 * The bar shown while tasks are selected, applied across the whole selection. Complete leads,
 * since ticking off several rows is the reason to select on a phone. Copy goes through
 * `useTaskClipboard`. Label opens `BulkLabelSheet` (seeded with the shared labels). Reschedule
 * offers `quickScheduleOptions`, the same targets as the swipe and quick-add.
 */

const PRIORITIES: Priority[] = [1, 2, 3, 4];

/** Quick-schedule key to its i18n key; a literal map so `task.schedule*` stays greppable. */
const DUE_LABEL: Record<QuickScheduleOption["key"], string> = {
  today: "task.scheduleToday",
  tomorrow: "task.scheduleTomorrow",
  weekend: "task.scheduleWeekend",
  nextWeek: "task.scheduleNextWeek",
};

export interface SelectionToolbarProps {
  count: number;
  /** Every selected task is completed: Complete becomes Reopen. */
  allCompleted?: boolean;
  now: number;
  timeZone?: string;
  onSelectAll: () => void;
  onComplete: () => void;
  onSetPriority: (p: Priority) => void;
  onSetDue: (dueAt: number | null) => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onLabel: () => void;
  onDelete: () => void;
  onClear: () => void;
}

type Panel = "priority" | "due" | null;

export function SelectionToolbar({
  count,
  allCompleted = false,
  now,
  timeZone,
  onSelectAll,
  onComplete,
  onSetPriority,
  onSetDue,
  onCopy,
  onDuplicate,
  onMove,
  onLabel,
  onDelete,
  onClear,
}: SelectionToolbarProps) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<Panel>(null);
  const dueOptions: QuickScheduleOption[] = quickScheduleOptions(now, timeZone);

  const close = () => setPanel(null);

  return (
    <View
      accessibilityLabel={t("selection.label")}
      // Presses on the bar never count as outside the tasks (`useOutsidePressExit`).
      dataSet={{ selectionKeep: "" }}
      onStartShouldSetResponder={() => true}
      className="border-t border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-zinc-900"
    >
      {panel === "priority" && (
        <View accessibilityRole="radiogroup" className="flex-row gap-1 px-3 pt-3">
          {PRIORITIES.map((level) => (
            <Pressable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected: false }}
              accessibilityLabel={level === 4 ? t("taskDetail.priorityNone") : `P${level}`}
              onPress={() => {
                onSetPriority(level);
                close();
              }}
              className="flex-1 flex-row items-center justify-center gap-1 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-700"
            >
              {level < 4 && <Flag size={16} className={PRIORITY_COLOR[level] ?? ""} />}
              <Text className="text-xs text-neutral-600 dark:text-neutral-300">
                {level === 4 ? t("taskDetail.priorityNone") : `P${level}`}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {panel === "due" && (
        // Wraps: five equal columns crush labels on a phone, so `basis-1/4` lets three sit on the first row.
        <View className="flex-row flex-wrap gap-1 px-3 pt-3">
          {dueOptions.map((opt) => (
            <Pressable
              key={opt.key}
              accessibilityRole="button"
              accessibilityLabel={t(DUE_LABEL[opt.key])}
              onPress={() => {
                onSetDue(opt.dueAt);
                close();
              }}
              className="grow basis-1/4 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-700"
            >
              <Text className="text-center text-xs text-neutral-600 dark:text-neutral-300">
                {t(DUE_LABEL[opt.key])}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("task.scheduleNoDate")}
            onPress={() => {
              onSetDue(null);
              close();
            }}
            className="grow basis-1/4 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-700"
          >
            <Text className="text-center text-xs text-neutral-500">{t("task.scheduleNoDate")}</Text>
          </Pressable>
        </View>
      )}

      <View className="flex-row items-center gap-1 px-3 py-2.5">
        {/* Visible even at zero selected, so you can always leave the mode. */}
        <Action label={t("selection.exit")} icon={X} onPress={onClear} />
        <Text className="ml-1 mr-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
          {t("selection.count", { count })}
        </Text>

        <View className="flex-1" />

        <Action label={t("selection.selectAll")} icon={ListTodo} onPress={onSelectAll} />
        <Action
          label={allCompleted ? t("task.reopen") : t("task.complete")}
          icon={allCompleted ? RotateCcw : CircleCheckBig}
          onPress={onComplete}
        />
        <Action
          label={t("context.priority")}
          icon={Flag}
          onPress={() => setPanel((p) => (p === "priority" ? null : "priority"))}
        />
        <Action
          label={t("context.due")}
          icon={CalendarDays}
          onPress={() => setPanel((p) => (p === "due" ? null : "due"))}
        />
        <Action label={t("selection.copy")} icon={Copy} onPress={onCopy} />
        <Action label={t("selection.duplicate")} icon={CopyPlus} onPress={onDuplicate} />
        <Action label={t("selection.moveTo")} icon={FolderInput} onPress={onMove} />
        <Action label={t("selection.labels")} icon={Tag} onPress={onLabel} />
        <Action label={t("common.delete")} icon={Trash2} onPress={onDelete} danger />
      </View>
    </View>
  );
}

function Action({
  label,
  icon: Icon,
  onPress,
  danger = false,
}: {
  label: string;
  icon: typeof Flag;
  onPress: () => void;
  danger?: boolean;
}) {
  // A hover tooltip for the icon-only actions on desktop web (RN-web does not forward the DOM `title`); hover never fires on touch.
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      className="relative rounded-md p-2.5 web:cursor-pointer web:hover:bg-neutral-200 dark:web:hover:bg-neutral-800"
    >
      <Icon
        size={20}
        className={danger ? "text-red-500" : "text-neutral-600 dark:text-neutral-300"}
      />
      {hovered && (
        <View
          style={{ pointerEvents: "none" }}
          className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded bg-neutral-900 px-2 py-1 dark:bg-neutral-700"
        >
          <Text numberOfLines={1} className="text-xs text-white">
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
