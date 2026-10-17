import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  bestStreak,
  completionRate,
  currentPeriod,
  currentStreak,
  currentStrength,
  dateKeyFromMs,
  dateKeyToMs,
  isBackfilled,
  resolveProjectColor,
  scheduleSegments,
  shiftDateKey,
  strengthSeries,
  totalCheckins,
  type Habit,
} from "@atlastodo/shared";
import DateTimePicker, { type DateTimePickerEvent } from "../ui/DateTimePicker";
import { useHabits } from "../hooks/useHabits";
import { useHabitCheckins } from "../hooks/useHabitCheckins";
import { usePreferences } from "../hooks/usePreferences";
import { useFormat } from "../hooks/useFormat";
import { useToast } from "../data/ToastProvider";
import { useNow } from "../hooks/useNow";
import { BarChart } from "../ui/BarChart";
import { EmptyState } from "../ui/EmptyState";
import { HabitGoalEditor } from "../ui/HabitGoalEditor";
import { HabitMonthCalendar } from "../ui/HabitMonthCalendar";
import { HabitStepsEditor } from "../ui/HabitStepsEditor";
import { ScreenFade } from "../ui/ScreenFade";
import { SectionHeading } from "../ui/SectionHeading";
import { Stat } from "../ui/Stat";
import { StyleAction, StyleEditButton, StyleEditor } from "../ui/StyleEditor";
import { HabitGroupPicker } from "../ui/HabitGroupPicker";
import { projectIconFor } from "../ui/projectIcons";
import { Archive, Bell, ChevronRight, Flame, FolderPlus, Trash2, X } from "../ui/icons";
import { haptics } from "../lib/haptics";

/**
 * One habit in full: its schedule, notes, month calendar and stats. `now` is injectable. Navigation
 * arrives as callbacks (only route files import `router`).
 */

const STRENGTH_DAYS = 90;

function timeToDate(value: string | null): Date {
  const now = new Date();
  if (!value) {
    now.setHours(9, 0, 0, 0);
    return now;
  }
  now.setHours(Number(value.slice(0, 2)), Number(value.slice(3, 5)), 0, 0);
  return now;
}

export function HabitDetailScreen({
  habitId,
  now,
  onOpenGroup,
  onLeave,
}: {
  habitId: string;
  now?: number;
  onOpenGroup?: (groupId: string) => void;
  onLeave: () => void;
}) {
  const { t } = useTranslation();
  const liveNow = useNow();
  const todayMs = now ?? liveNow;
  const todayKey = dateKeyFromMs(todayMs);
  const { weekStartsOn, remindersEnabled } = usePreferences();
  const fmt = useFormat();
  const { habits, habitGroups, archivedHabits, updateHabit, moveHabit, setArchived, removeHabit } =
    useHabits();
  const { statesFor, checkinFor, cycle } = useHabitCheckins();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [choosingGroup, setChoosingGroup] = useState(false);

  const habit: Habit | undefined =
    habits.find((h) => h.id === habitId) ?? archivedHabits.find((h) => h.id === habitId);

  // Notes are buffered so an incoming sync cannot clobber an edit; keyed by id so switching habits
  // starts fresh. The name is the nav-header title, owned by `StyleEditor`.
  const [notes, setNotes] = useState(habit?.notes ?? "");
  const editingId = useRef(habitId);
  if (editingId.current !== habitId) {
    editingId.current = habitId;
    setNotes(habit?.notes ?? "");
  }

  const commitNotes = () => {
    if (!habit || notes === habit.notes) return;
    updateHabit(habit.id, { notes });
  };

  const flush = useRef<() => void>(() => {});
  flush.current = commitNotes;
  useEffect(() => () => flush.current(), []);

  if (!habit) {
    return (
      <EmptyState
        icon={Flame}
        title={t("habits.missingTitle")}
        description={t("habits.missingBody")}
        actions={[{ label: t("habits.backToHabits"), onPress: onLeave, primary: true }]}
      />
    );
  }

  // When the newest schedule version took effect: a weekly change made mid-week applies the following week, and the screen says why.
  const segments = scheduleSegments(habit, weekStartsOn);
  const changedOn = segments.length > 1 ? segments[segments.length - 1]!.from : null;

  // `habits` excludes groups and an archived group still names where the habit lives, so both lists are searched.
  const group =
    habit.parent_id === null
      ? undefined
      : (habitGroups.find((g) => g.id === habit.parent_id) ??
        archivedHabits.find((g) => g.id === habit.parent_id && g.kind === "group"));

  const states = statesFor(habit.id);
  const streak = currentStreak(habit, states, todayMs, weekStartsOn);
  const best = bestStreak(habit, states, todayMs, weekStartsOn);
  const total = totalCheckins(states);
  const period = currentPeriod(habit, states, todayMs, weekStartsOn);
  const rate = completionRate(
    habit,
    states,
    dateKeyToMs(shiftDateKey(todayKey, -89)),
    todayMs,
    weekStartsOn,
  );
  const strength = strengthSeries(
    habit,
    states,
    dateKeyToMs(shiftDateKey(todayKey, -(STRENGTH_DAYS - 1))),
    todayMs,
    weekStartsOn,
  );

  const toggleDay = (date: string) => {
    const { next, undo } = cycle(habit.id, date);
    if (next === "done") haptics.success();
    else haptics.selection();
    toast.show(
      t(
        next === "done"
          ? "toast.habitChecked"
          : next === "skip"
            ? "toast.habitSkipped"
            : "toast.habitCleared",
        { name: habit.name },
      ),
      { label: t("common.undo"), run: undo },
    );
  };

  const onPickTime = (event: DateTimePickerEvent, date?: Date) => {
    setPicking(false);
    // Android encodes dismissal in `event.type`; without this check, backing out would save the declined time.
    if (event.type !== "set" || !date) return;
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    updateHabit(habit.id, { reminder_time: `${hh}:${mm}` });
  };

  return (
    <ScreenFade>
      <ScrollView
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerClassName="gap-6 p-4"
        keyboardShouldPersistTaps="handled"
      >
        {/* The icon and name are the nav-header title, so this row is just the actions. */}
        <View className="flex-row items-center gap-2">
          {/* Where this habit lives, in words, and the way back to the routine. */}
          {group !== undefined ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("habits.partOfGroup", { name: group.name })}
              onPress={() => onOpenGroup?.(group.id)}
              className="min-w-0 flex-1 flex-row items-center gap-1.5"
            >
              {(() => {
                const GroupIcon = projectIconFor(group.icon);
                return <GroupIcon size={14} color={resolveProjectColor(group)} />;
              })()}
              <Text numberOfLines={1} className="shrink text-xs text-neutral-500">
                {group.name}
              </Text>
              <ChevronRight size={12} className="shrink-0 text-neutral-500" />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("habits.addToAGroup")}
              onPress={() => setChoosingGroup(true)}
              className="min-w-0 flex-1 flex-row items-center gap-1.5"
            >
              <FolderPlus size={14} className="shrink-0 text-neutral-500" />
              <Text numberOfLines={1} className="shrink text-xs text-neutral-500">
                {t("habits.addToAGroup")}
              </Text>
            </Pressable>
          )}
          <StyleEditButton label={t("habits.editHabit")} onPress={() => setEditing(true)} />
        </View>

        <TextInput
          accessibilityLabel={t("habits.notes")}
          value={notes}
          onChangeText={setNotes}
          onBlur={commitNotes}
          placeholder={t("habits.notesPlaceholder")}
          placeholderTextColor="#737373"
          multiline
          className="min-h-16 text-sm text-neutral-700 dark:text-neutral-200"
        />

        <View>
          <SectionHeading>{t("habits.goal")}</SectionHeading>
          <HabitGoalEditor
            goal={{ goal_kind: habit.goal_kind, days: habit.days, target: habit.target }}
            weekStartsOn={weekStartsOn}
            onChange={(patch) => updateHabit(habit.id, patch)}
          />
          {changedOn !== null && (
            <Text className="mt-2 text-xs text-neutral-500">
              {t(changedOn <= todayKey ? "habits.scheduleChanged" : "habits.scheduleStarts", {
                date: fmt.date(dateKeyToMs(changedOn)),
              })}
            </Text>
          )}
        </View>

        <View>
          <SectionHeading>{t("habits.steps")}</SectionHeading>
          <HabitStepsEditor
            steps={habit.steps}
            onChange={(steps) => updateHabit(habit.id, { steps })}
          />
        </View>

        <View>
          <SectionHeading>{t("habits.progress")}</SectionHeading>
          <View className="flex-row gap-2">
            <Stat
              label={t("habits.currentStreak")}
              value={t(habit.goal_kind === "daily" ? "habits.streakDays" : "habits.streakPeriods", {
                count: streak,
              })}
            />
            <Stat
              label={t("habits.bestStreak")}
              value={t(habit.goal_kind === "daily" ? "habits.streakDays" : "habits.streakPeriods", {
                count: best,
              })}
            />
          </View>
          <View className="mt-2 flex-row gap-2">
            <Stat label={t("habits.lifetime")} value={String(total)} />
            <Stat label={t("habits.rate90")} value={`${Math.round(rate.rate * 100)}%`} />
          </View>
          {period !== null && period.target > 0 && (
            <Text className="mt-2 text-xs text-neutral-500">
              {t("habits.thisPeriod", { done: period.done, target: period.target })}
            </Text>
          )}
        </View>

        <View>
          <SectionHeading>{t("habits.strength")}</SectionHeading>
          {total === 0 ? (
            <Text className="text-sm text-neutral-500">{t("habits.strengthEmpty")}</Text>
          ) : (
            <>
              {/* The track matters: the scale is fixed at 1, so a young habit's bars are a few pixels tall. */}
              <BarChart
                values={strength.map((point) => point.score)}
                ariaLabel={t("habits.strengthChart", { name: habit.name })}
                max={1}
                className="h-20"
                dense
                track
                startLabel={t("habits.strengthStart", { count: strength.length - 1 })}
                endLabel={t("habits.strengthEnd")}
              />
              <Text className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
                {t("habits.strengthValue", {
                  pct: Math.round(currentStrength(habit, states, todayMs, weekStartsOn) * 100),
                })}
              </Text>
              <Text className="text-xs text-neutral-500 dark:text-neutral-400">
                {t("habits.strengthHint")}
              </Text>
            </>
          )}
        </View>

        <View>
          <SectionHeading>{t("habits.history")}</SectionHeading>
          <HabitMonthCalendar
            habit={habit}
            states={states}
            isBackfilled={(date) => {
              const checkin = checkinFor(habit.id, date);
              return checkin !== undefined && isBackfilled(checkin);
            }}
            todayMs={todayMs}
            weekStartsOn={weekStartsOn}
            onToggleDay={toggleDay}
          />
        </View>

        {remindersEnabled && (
          <View>
            <SectionHeading>{t("habits.reminder")}</SectionHeading>
            <View className="flex-row items-center gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("habits.reminderTime")}
                onPress={() => setPicking(true)}
                className="flex-row items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-700"
              >
                <Bell size={14} className="text-neutral-500" />
                <Text className="text-sm text-neutral-700 dark:text-neutral-200">
                  {habit.reminder_time ?? t("habits.noReminder")}
                </Text>
              </Pressable>
              {habit.reminder_time !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("habits.clearReminder")}
                  onPress={() => updateHabit(habit.id, { reminder_time: null })}
                  hitSlop={8}
                  className="p-1"
                >
                  <X size={16} className="text-neutral-500" />
                </Pressable>
              )}
            </View>
            {picking && (
              <DateTimePicker
                value={timeToDate(habit.reminder_time)}
                mode="time"
                onChange={onPickTime}
              />
            )}
          </View>
        )}
      </ScrollView>

      {/* Rename, icon, colour and the destructive actions, in one sheet like a project's. */}
      <StyleEditor
        open={editing}
        name={habit.name}
        nameLabel={t("habits.name")}
        iconLabel={t("habits.icon")}
        colorLabel={t("habits.color")}
        selectedIcon={habit.icon}
        defaultIcon="hash"
        selectedColor={habit.color}
        onRename={(next) => updateHabit(habit.id, { name: next })}
        onSetIcon={(icon) => updateHabit(habit.id, { icon })}
        onSetColor={(color) => updateHabit(habit.id, { color })}
        onClose={() => setEditing(false)}
        footer={(close) => (
          <>
            <StyleAction
              icon={FolderPlus}
              label={group === undefined ? t("habits.addToAGroup") : t("habits.changeGroup")}
              onPress={() => {
                close();
                setChoosingGroup(true);
              }}
            />
            {group !== undefined && (
              <StyleAction
                icon={X}
                label={t("habits.removeFromGroup")}
                onPress={() => {
                  moveHabit(habit.id, null);
                  close();
                }}
              />
            )}
            <StyleAction
              icon={Archive}
              label={habit.archived_at === null ? t("habits.archive") : t("habits.restore")}
              onPress={() => {
                const archiving = habit.archived_at === null;
                const undo = setArchived(habit.id, archiving);
                close();
                if (archiving) onLeave();
                toast.show(t(archiving ? "toast.habitArchived" : "toast.habitRestored"), {
                  label: t("common.undo"),
                  run: undo,
                });
              }}
            />
            <StyleAction
              icon={Trash2}
              label={t("common.delete")}
              accessibilityLabel={t("habits.delete", { name: habit.name })}
              danger
              onPress={() => {
                const undo = removeHabit(habit.id);
                close();
                onLeave();
                toast.show(t("toast.habitDeleted"), { label: t("common.undo"), run: undo });
              }}
            />
          </>
        )}
      />

      {choosingGroup && (
        <HabitGroupPicker
          habit={habit}
          groups={habitGroups}
          onPick={(groupId) => {
            moveHabit(habit.id, groupId);
            setChoosingGroup(false);
          }}
          onClose={() => setChoosingGroup(false)}
        />
      )}
    </ScreenFade>
  );
}
