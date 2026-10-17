import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Habit } from "@atlastodo/shared";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { Check } from "./icons";
import { projectIconFor } from "./projectIcons";
import { haptics } from "../lib/haptics";

/**
 * Which routine a habit belongs to.
 *
 * Dragging a card into a group's block works too, but this is the path that survives a long list,
 * a narrow browser window where the drag is degraded, and a screen reader.
 */
export function HabitGroupPicker({
  habit,
  groups,
  onPick,
  onClose,
}: {
  habit: Habit;
  groups: Habit[];
  onPick: (groupId: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  const choose = (groupId: string | null) => {
    haptics.selection();
    onPick(groupId);
  };

  return (
    <BottomSheet visible onClose={onClose}>
      <View className="gap-2">
        <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
          {t("habits.moveToGroup")}
        </Text>
        <SheetScrollView className="max-h-80">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("habits.noGroup")}
            onPress={() => choose(null)}
            className="flex-row items-center gap-3 rounded-md px-2 py-3"
          >
            <View className="w-5">
              {habit.parent_id === null && <Check size={16} className="text-accent-600" />}
            </View>
            <Text className="text-sm text-neutral-900 dark:text-neutral-100">
              {t("habits.noGroup")}
            </Text>
          </Pressable>

          {groups.map((group) => {
            const Icon = projectIconFor(group.icon);
            return (
              <Pressable
                key={group.id}
                accessibilityRole="button"
                accessibilityLabel={group.name}
                onPress={() => choose(group.id)}
                className="flex-row items-center gap-3 rounded-md px-2 py-3"
              >
                <View className="w-5">
                  {habit.parent_id === group.id && <Check size={16} className="text-accent-600" />}
                </View>
                <Icon size={16} color={group.color} />
                <Text className="text-sm text-neutral-900 dark:text-neutral-100">{group.name}</Text>
              </Pressable>
            );
          })}

          {groups.length === 0 && (
            <Text className="px-2 py-3 text-sm text-neutral-500">{t("habits.noGroupsYet")}</Text>
          )}
        </SheetScrollView>
      </View>
    </BottomSheet>
  );
}
