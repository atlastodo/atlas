import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { BottomSheet } from "./BottomSheet";
import { LabelPicker } from "./LabelPicker";
import { Tag, Trash2, X } from "./icons";

/**
 * The sheet behind the toolbar's "Label" action. The picker is seeded with the labels the selected
 * tasks share: removing a shared chip removes it from every selected task, picking an available
 * one assigns it to all (idempotent). Labels beyond the shared set are never touched; "Clear
 * labels" strips all. A dumb sheet like `MoveToPicker`: the caller writes one `label_ids` op per
 * task and owns the undo toast.
 */

export interface BulkLabelChange {
  add: string[];
  remove: string[];
}

export interface BulkLabelSheetProps {
  title: string | null;
  tasks: Task[];
  onApply: (change: BulkLabelChange) => void;
  onClear: () => void;
  onClose: () => void;
}

export function BulkLabelSheet({ title, tasks, onApply, onClear, onClose }: BulkLabelSheetProps) {
  const { t } = useTranslation();
  const open = title !== null;

  // Labels every selected task has, first-seen order; a label only some have shows as an available suggestion.
  const shared = tasks.reduce<string[]>(
    (acc, task, i) =>
      i === 0 ? [...task.label_ids] : acc.filter((id) => task.label_ids.includes(id)),
    [],
  );
  const clearable = tasks.some((task) => task.label_ids.length > 0);

  return (
    <BottomSheet visible={open} onClose={onClose}>
      <View className="gap-2">
        <View className="mb-1 flex-row items-center gap-2">
          <Tag size={18} className="text-neutral-500" />
          <Text
            numberOfLines={1}
            className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100"
          >
            {t("label.heading")}
            {title ? `: ${title}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={onClose}
          >
            <X size={20} className="text-neutral-500" />
          </Pressable>
        </View>

        <LabelPicker
          labelIds={shared}
          onChange={(ids) => {
            const add = ids.filter((id) => !shared.includes(id));
            const remove = shared.filter((id) => !ids.includes(id));
            onApply({ add, remove });
          }}
        />

        {clearable && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("selection.clearLabels")}
            onPress={onClear}
            className="flex-row items-center justify-center gap-2 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-700 web:cursor-pointer"
          >
            <Trash2 size={14} className="text-neutral-500" />
            <Text className="text-xs text-neutral-600 dark:text-neutral-300">
              {t("selection.clearLabels")}
            </Text>
          </Pressable>
        )}
      </View>
    </BottomSheet>
  );
}
