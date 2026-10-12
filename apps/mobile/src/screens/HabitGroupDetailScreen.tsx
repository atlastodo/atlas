import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  completionRate,
  currentStreak,
  dateKeyToMs,
  habitGroupBestStreak,
  habitGroupBreak,
  habitGroupRate,
  habitGroupStreak,
  habitGroupToday,
  dateKeyFromMs,
  resolveProjectColor,
  shiftDateKey,
  type Habit,
  type HabitGroupMember,
} from "@atlas/shared";
import { useHabits } from "../hooks/useHabits";
import { useHabitCheckins } from "../hooks/useHabitCheckins";
import { usePreferences } from "../hooks/usePreferences";
import { useToast } from "../data/ToastProvider";
import { useNow } from "../hooks/useNow";
import { useFormat } from "../hooks/useFormat";
import { AddHabitSheet } from "../ui/AddHabitSheet";
import { BreakdownRow } from "../ui/BreakdownRow";
import { EmptyState } from "../ui/EmptyState";
import { ScreenFade } from "../ui/ScreenFade";
import { SectionHeading } from "../ui/SectionHeading";
import { Stat } from "../ui/Stat";
import { StyleAction, StyleEditButton, StyleEditor } from "../ui/StyleEditor";
import { projectIconFor } from "../ui/projectIcons";
import { Archive, Flame, Plus, Trash2, X } from "../ui/icons";

/**
 * A routine in full: how it has gone as one thing, and which habits make it up. No goal editor or
 * strength curve (a group has no schedule of its own, and the curve's decay is tuned to a single
 * habit's frequency) and no steps (the member list is the routine's procedure).
 */

export function HabitGroupDetailScreen({
  groupId,
  now,
  onOpenHabit,
  onLeave,
}: {
  groupId: string;
  now?: number;
  onOpenHabit?: (habit: Habit) => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const liveNow = useNow();
  const fmt = useFormat();
  const todayMs = now ?? liveNow;
  const todayKey = dateKeyFromMs(todayMs);
  const { weekStartsOn } = usePreferences();
  const {
    habits,
    habitGroups,
    archivedHabits,
    createHabit,
    updateHabit,
    setArchived,
    moveHabit,
    removeHabit,
  } = useHabits();
  const { statesFor } = useHabitCheckins();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);

  const group =
    habitGroups.find((g) => g.id === groupId) ?? archivedHabits.find((g) => g.id === groupId);

  if (!group || group.kind !== "group") {
    return (
      <EmptyState
        icon={Flame}
        title={t("habits.groupMissingTitle")}
        description={t("habits.missingBody")}
        actions={[{ label: t("habits.backToHabits"), onPress: onLeave, primary: true }]}
      />
    );
  }

  const members = habits.filter((h) => h.parent_id === group.id);
  const scored: HabitGroupMember[] = members.map((habit) => ({
    habit,
    states: statesFor(habit.id),
  }));
  // A 90-day window walked as calendar days (exact across DST), as a single habit's screen does, so rates are comparable.
  const windowFromMs = dateKeyToMs(shiftDateKey(todayKey, -89));
  const streak = habitGroupStreak(scored, todayMs, weekStartsOn);
  const best = habitGroupBestStreak(scored, todayMs, weekStartsOn);
  const today = habitGroupToday(scored, todayMs, weekStartsOn);
  const rate = habitGroupRate(scored, windowFromMs, todayMs, weekStartsOn);
  const broke = habitGroupBreak(scored, todayMs, weekStartsOn);
  const brokeNames =
    broke === null
      ? ""
      : broke.missing
          .map((id) => members.find((m) => m.id === id)?.name)
          .filter((name): name is string => name !== undefined)
          .join(", ");

  /** Each member against the same 90 days, worst first: a routine is met only when every member that owed a check-in got one, so this shows which habit bounds the rate. The member list below keeps the routine's own order. */
  const standing = scored
    .map(({ habit, states }) => ({
      habit,
      rate: completionRate(habit, states, windowFromMs, todayMs, weekStartsOn).rate,
      streak: currentStreak(habit, states, todayMs, weekStartsOn),
    }))
    .sort((a, b) => a.rate - b.rate || a.habit.name.localeCompare(b.habit.name));
  const streakOf = (id: string) => standing.find((m) => m.habit.id === id)?.streak ?? 0;

  return (
    <ScreenFade>
      <ScrollView
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerClassName="gap-6 p-4"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center gap-2">
          <View className="flex-1" />
          <StyleEditButton label={t("habits.editGroup")} onPress={() => setEditing(true)} />
        </View>

        <View>
          <SectionHeading>{t("habits.progress")}</SectionHeading>
          <View className="flex-row gap-2">
            <Stat
              label={t("habits.currentStreak")}
              value={t("habits.streakDays", { count: streak })}
            />
            <Stat label={t("habits.bestStreak")} value={t("habits.streakDays", { count: best })} />
          </View>
          <View className="mt-2 flex-row gap-2">
            <Stat label={t("habits.groupRate90")} value={`${Math.round(rate.rate * 100)}%`} />
          </View>
          <Text className="mt-2 text-xs text-neutral-500">
            {today === null || today.due === 0
              ? t("habits.groupNothingToday")
              : t("habits.groupToday", { done: today.done, due: today.due })}
          </Text>
          {/* A single miss zeroes the whole streak; this says which habit, and when. */}
          {members.length > 0 && (
            <Text className="mt-1 text-xs text-neutral-500">
              {broke === null || brokeNames === ""
                ? t("habits.groupNeverBroken")
                : t("habits.groupBrokeOn", {
                    date: fmt.date(dateKeyToMs(broke.date)),
                    names: brokeNames,
                  })}
            </Text>
          )}
        </View>

        {members.length > 0 && (
          <View>
            <SectionHeading>{t("habits.groupStanding")}</SectionHeading>
            <View className="gap-2">
              {standing.map(({ habit, rate: memberRate }) => (
                <Pressable
                  key={habit.id}
                  accessibilityRole="button"
                  accessibilityLabel={t("habits.groupMemberRate", {
                    name: habit.name,
                    pct: Math.round(memberRate * 100),
                  })}
                  onPress={() => onOpenHabit?.(habit)}
                >
                  <BreakdownRow
                    label={habit.name}
                    count={Math.round(memberRate * 100)}
                    max={100}
                    tint={resolveProjectColor(habit)}
                    valueLabel={`${Math.round(memberRate * 100)}%`}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <View>
          <SectionHeading>{t("habits.groupMembers")}</SectionHeading>
          {members.length === 0 && (
            <Text className="mb-2 text-sm text-neutral-500">{t("habits.groupEmpty")}</Text>
          )}
          {members.map((habit) => {
            const Icon = projectIconFor(habit.icon);
            return (
              // Sibling pressables, never nested: react-native-web renders both as <button>.
              <View key={habit.id} className="flex-row items-center gap-2 py-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("habits.open", { name: habit.name })}
                  onPress={() => onOpenHabit?.(habit)}
                  className="min-w-0 flex-1 flex-row items-center gap-2"
                >
                  <Icon size={16} color={habit.color} />
                  <Text
                    className="min-w-0 flex-1 text-sm text-neutral-900 dark:text-neutral-100"
                    numberOfLines={1}
                  >
                    {habit.name}
                  </Text>
                  {/* Keeps the routine's own order (the procedure); each row carries its own streak. */}
                  <View className="shrink-0 flex-row items-center gap-1">
                    <Flame size={12} className="text-orange-500" />
                    <Text className="text-xs text-neutral-500">
                      {t("habits.streakDays", { count: streakOf(habit.id) })}
                    </Text>
                  </View>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("habits.removeFromGroup")}
                  onPress={() => moveHabit(habit.id, null)}
                  hitSlop={8}
                  className="p-1"
                >
                  <X size={16} className="text-neutral-500" />
                </Pressable>
              </View>
            );
          })}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("habits.addToGroup")}
            onPress={() => setAdding(true)}
            className="mt-2 flex-row items-center gap-2 py-2"
          >
            <Plus size={16} className="text-accent-600" />
            <Text className="text-sm font-medium text-accent-700 dark:text-accent-300">
              {t("habits.addToGroup")}
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      <StyleEditor
        open={editing}
        name={group.name}
        nameLabel={t("habits.groupName")}
        iconLabel={t("habits.icon")}
        colorLabel={t("habits.color")}
        selectedIcon={group.icon}
        defaultIcon="folder"
        selectedColor={group.color}
        onRename={(next) => updateHabit(group.id, { name: next })}
        onSetIcon={(icon) => updateHabit(group.id, { icon })}
        onSetColor={(color) => updateHabit(group.id, { color })}
        onClose={() => setEditing(false)}
        footer={(close) => (
          <>
            <StyleAction
              icon={Archive}
              label={group.archived_at === null ? t("habits.archiveGroup") : t("habits.restore")}
              onPress={() => {
                const archiving = group.archived_at === null;
                const undo = setArchived(group.id, archiving);
                close();
                if (archiving) onLeave();
                toast.show(t(archiving ? "toast.habitGroupArchived" : "toast.habitRestored"), {
                  label: t("common.undo"),
                  run: undo,
                });
              }}
            />
            <StyleAction
              icon={Trash2}
              label={t("common.delete")}
              accessibilityLabel={t("habits.delete", { name: group.name })}
              danger
              onPress={() => {
                const undo = removeHabit(group.id);
                close();
                onLeave();
                toast.show(t("toast.habitGroupDeleted"), { label: t("common.undo"), run: undo });
              }}
            />
          </>
        )}
      />

      <AddHabitSheet
        visible={adding}
        groupName={group.name}
        weekStartsOn={weekStartsOn}
        onClose={() => setAdding(false)}
        onAdd={(spec) => createHabit({ ...spec, parent_id: group.id })}
      />
    </ScreenFade>
  );
}
