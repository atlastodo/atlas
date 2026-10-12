import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "./BottomSheet";
import { GROUP_BYS, SORT_BYS, type GroupBy, type SortBy } from "@atlas/shared";
import type { ListPref } from "../hooks/usePreferences";
import {
  ArrowDownAZ,
  ArrowUpDown,
  CalendarClock,
  CalendarDays,
  Check,
  Clock,
  Flag,
  GripVertical,
  Hash,
  History,
  ListFilter,
  ListTodo,
  Tag,
  X,
  type LucideIcon,
} from "./icons";

// An icon per grouping the menu offers (GROUP_BYS). "completed" is Completed-view-only and never listed, hence Partial.
const GROUP_ICON: Partial<Record<GroupBy, LucideIcon>> = {
  none: ListTodo,
  date: CalendarDays,
  priority: Flag,
  label: Tag,
  project: Hash,
};

const SORT_ICON: Record<SortBy, LucideIcon> = {
  manual: GripVertical,
  due: CalendarClock,
  priority: Flag,
  alpha: ArrowDownAZ,
  created: Clock,
  modified: History,
};

/**
 * The group + sort control for a task list. The choice is a synced preference (`list_prefs`, keyed
 * by view) using `groupTasks`/`sortTasks`. A sheet, since both choices answer "how is this list
 * arranged?".
 */

export interface ListPrefMenuProps {
  value: ListPref;
  onChange: (patch: Partial<ListPref>) => void;
}

export function ListPrefMenu({ value, onChange }: ListPrefMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("workspace.listOptions")}
        onPress={() => setOpen(true)}
        className="flex-row items-center gap-1 rounded-md px-2 py-1.5"
      >
        <ListFilter size={16} className="text-neutral-500" />
      </Pressable>

      <ListPrefSheet
        visible={open}
        onClose={() => setOpen(false)}
        value={value}
        onChange={onChange}
      />
    </>
  );
}

/** The group + sort sheet without the trigger button, for a caller that opens it elsewhere (the project header's phone overflow menu). */
export function ListPrefSheet({
  visible,
  onClose,
  value,
  onChange,
}: ListPrefMenuProps & { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View className="gap-4">
        <View className="flex-row items-center">
          <Text className="flex-1 text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t("workspace.listOptions")}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={onClose}
          >
            <X size={20} className="text-neutral-500" />
          </Pressable>
        </View>

        <Group
          title={t("workspace.group")}
          icon={ListFilter}
          options={GROUP_BYS.map((g) => ({
            value: g,
            label: t(`group.${g}`),
            icon: GROUP_ICON[g] ?? ListTodo,
          }))}
          value={value.group}
          onSelect={(group) => onChange({ group })}
        />
        <Group
          title={t("workspace.sort")}
          icon={ArrowUpDown}
          options={SORT_BYS.map((s) => ({ value: s, label: t(`sort.${s}`), icon: SORT_ICON[s] }))}
          value={value.sort}
          onSelect={(sort) => onChange({ sort })}
        />
      </View>
    </BottomSheet>
  );
}

function Group<T extends GroupBy | SortBy>({
  title,
  icon: Icon,
  options,
  value,
  onSelect,
}: {
  title: string;
  icon: LucideIcon;
  options: { value: T; label: string; icon: LucideIcon }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <View className="gap-1">
      <View className="mb-1 flex-row items-center gap-2">
        <Icon size={14} className="text-neutral-500" />
        <Text className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {title}
        </Text>
      </View>
      <View accessibilityRole="radiogroup" accessibilityLabel={title}>
        {options.map((opt) => {
          const active = opt.value === value;
          const OptIcon = opt.icon;
          return (
            <Pressable
              key={opt.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              // Qualified by its group: "Priority" is both a grouping and a sort, so the bare label appears twice.
              accessibilityLabel={`${title}: ${opt.label}`}
              onPress={() => onSelect(opt.value)}
              className="flex-row items-center gap-2 py-2.5"
            >
              <OptIcon size={16} className={active ? "text-accent-600" : "text-neutral-500"} />
              <Text className="flex-1 text-sm text-neutral-900 dark:text-neutral-100">
                {opt.label}
              </Text>
              {active && <Check size={16} className="text-accent-600" />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
