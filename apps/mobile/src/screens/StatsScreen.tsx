import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  addDays,
  completedStreak,
  completionsByDay,
  completionsByProject,
  completionsByWeek,
  dateKeyFromMs,
  formatDuration,
  makeFormatters,
  resolveLocale,
  shiftDateKey,
  totalCompleted,
  type Habit,
} from "@atlas/shared";
import type { LucideIcon } from "../ui/icons";
import { CircleCheckBig, Flame, Timer } from "../ui/icons";
import { BarChart } from "../ui/BarChart";
import { BreakdownRow } from "../ui/BreakdownRow";
import { ScreenFade } from "../ui/ScreenFade";
import { SectionHeading } from "../ui/SectionHeading";
import { useLocalTasks } from "../hooks/useLocalTasks";
import { useProjects } from "../hooks/useProjects";
import { useHabits } from "../hooks/useHabits";
import { useHabitCheckins } from "../hooks/useHabitCheckins";
import { useFocusSessions } from "../hooks/useFocusSessions";
import { usePreferences } from "../hooks/usePreferences";
import { useFeature } from "../hooks/useFeature";

/**
 * Productivity stats: headline metrics, a completions chart over a selectable range, a per-project
 * breakdown, and habit check-ins. Gated behind the `stats` feature toggle at the route. `now` is
 * injectable. Charts come from `ui/BarChart`.
 */

const RANGES = [
  { days: 7, labelKey: "stats.range7" },
  { days: 30, labelKey: "stats.range30" },
  { days: 90, labelKey: "stats.range90" },
];

/** Content width at/above which the three stat cards share one row; below it they stack full width. */
const CARDS_ROW_MIN_WIDTH = 560;

/** A day key ("2026-06-17") as a short "17 Jun", read in UTC so no time zone can move it a day. */
function dayLabel(fmt: ReturnType<typeof makeFormatters>, key: string): string {
  return fmt.dueChip(
    Date.UTC(
      Number(key.slice(0, 4)),
      Number(key.slice(5, 7)) - 1,
      Number(key.slice(8, 10)),
      23,
      59,
    ),
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  accent,
  inRow,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  /** Set smaller after the value on the same line ("19 days"), so a long unit never wraps the figure. */
  unit?: string;
  accent: string;
  /** Share a row with the other cards (`flex-1`); otherwise the card takes its content height in a stack. */
  inRow: boolean;
}) {
  return (
    // Grouped, so a screen reader announces "12, completed in 30 days" as one. `items-start` and the
    // icon's nudge keep every card's figure on the same baseline, however its label wraps.
    <View
      accessible
      accessibilityLabel={unit === undefined ? `${value} ${label}` : `${value} ${unit} ${label}`}
      className={`${inRow ? "flex-1 " : ""}flex-row items-start gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800`}
    >
      <Icon size={24} className={`mt-1 ${accent}`} />
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50"
        >
          {value}
          {unit !== undefined && (
            <Text className="text-sm font-normal text-neutral-500 dark:text-neutral-400">
              {` ${unit}`}
            </Text>
          )}
        </Text>
        <Text className="text-xs text-neutral-500 dark:text-neutral-400">{label}</Text>
      </View>
    </View>
  );
}

export function StatsScreen({ now }: { now?: number }) {
  const { t } = useTranslation();
  const nowMs = now ?? Date.now();
  const [rangeDays, setRangeDays] = useState(30);
  // The content width, measured, so the cards and the chart follow the space the screen gets
  // (the sidebar takes a varying share of the window).
  const [contentWidth, setContentWidth] = useState(0);
  const { tasks } = useLocalTasks();
  const { projects } = useProjects();
  const { habits, habitGroups } = useHabits();
  const { statesFor } = useHabitCheckins();
  const { sessions } = useFocusSessions();
  const { weekStartsOn, focusEnabled, timezone, language, region } = usePreferences();
  const dayFmt = useMemo(
    () => makeFormatters({ locale: resolveLocale(region, language), timeZone: "UTC" }),
    [region, language],
  );
  const timeZone = timezone || undefined;
  const habitsEnabled = useFeature("habits");

  const { fromMs, toMs } = useMemo(
    () => ({
      fromMs: addDays(nowMs, -(rangeDays - 1), timeZone),
      toMs: addDays(nowMs, 1, timeZone) - 1,
    }),
    [nowMs, rangeDays, timeZone],
  );

  const projectName = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string | null) =>
      id === null ? t("stats.inbox") : (byId.get(id) ?? t("stats.unknownProject"));
  }, [projects, t]);

  const total = useMemo(() => totalCompleted(tasks, fromMs, toMs), [tasks, fromMs, toMs]);
  const streak = useMemo(() => completedStreak(tasks, nowMs, timeZone), [tasks, nowMs, timeZone]);
  const focusedMs = useMemo(
    () =>
      sessions
        .filter((s) => s.started_at >= fromMs && s.started_at <= toMs)
        .reduce((sum, s) => sum + s.duration_ms, 0),
    [sessions, fromMs, toMs],
  );

  const weekly = rangeDays > 45;
  // Every bucket of the range, zeros included, with the day key that starts each.
  const chart = useMemo(() => {
    if (weekly) {
      return completionsByWeek(tasks, fromMs, toMs, weekStartsOn, timeZone).map((w) => ({
        key: w.weekStart,
        count: w.count,
      }));
    }
    return completionsByDay(tasks, fromMs, toMs, timeZone).map((d) => ({
      key: d.date,
      count: d.count,
    }));
  }, [tasks, fromMs, toMs, weekly, weekStartsOn, timeZone]);
  const chartPeak = Math.max(0, ...chart.map((c) => c.count));
  // Taller on a wide panel, so 30 bars across 1000px are not a flat strip.
  const chartHeight = Math.round(Math.min(240, Math.max(128, contentWidth * 0.28)));
  const cardsInRow = contentWidth >= CARDS_ROW_MIN_WIDTH;

  const byProject = useMemo(() => completionsByProject(tasks, fromMs, toMs), [tasks, fromMs, toMs]);
  const maxProject = Math.max(1, ...byProject.map((p) => p.count));

  // Day keys, not instants: that is how a check-in is identified, and `fromMs`/`toMs` would drift at the range's edges.
  const habitCheckins = useMemo(() => {
    const toKey = dateKeyFromMs(nowMs);
    const fromKey = shiftDateKey(toKey, -(rangeDays - 1));
    return habits
      .map((habit) => {
        let count = 0;
        for (const [date, state] of statesFor(habit.id)) {
          if (state === "done" && date >= fromKey && date <= toKey) count++;
        }
        return { habit, count };
      })
      .sort((a, b) => b.count - a.count);
  }, [habits, statesFor, nowMs, rangeDays]);
  const maxHabit = Math.max(1, ...habitCheckins.map((h) => h.count));

  /**
   * The same rows grouped under each habit's routine (`useHabits().habits` excludes groups).
   * Blocks and members are ordered by count; a routine with no check-ins in the range is dropped.
   */
  const habitBlocks = useMemo(() => {
    const byId = new Map(habitCheckins.map((h) => [h.habit.id, h]));
    const blocks: {
      group: Habit | null;
      count: number;
      rows: { habit: Habit; count: number }[];
    }[] = [];
    for (const group of habitGroups) {
      const rows = habitCheckins.filter((h) => h.habit.parent_id === group.id);
      if (rows.length === 0) continue;
      blocks.push({ group, count: rows.reduce((sum, r) => sum + r.count, 0), rows });
    }
    for (const row of habitCheckins) {
      const parent = row.habit.parent_id;
      // Orphans (a member whose group was purged elsewhere) rank at the top level, like `flattenHabitGroups`.
      if (parent !== null && habitGroups.some((g) => g.id === parent)) continue;
      blocks.push({ group: null, count: row.count, rows: [byId.get(row.habit.id) ?? row] });
    }
    return blocks.sort((a, b) => b.count - a.count);
  }, [habitCheckins, habitGroups]);

  return (
    <ScreenFade>
      <ScrollView
        className="flex-1 bg-white dark:bg-zinc-950"
        contentContainerClassName="gap-6 p-4"
      >
        <View className="flex-row items-center gap-2">
          {RANGES.map((r) => {
            const active = rangeDays === r.days;
            return (
              <Pressable
                key={r.days}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t(r.labelKey)}
                onPress={() => setRangeDays(r.days)}
                className={
                  "rounded-md px-3 py-1 " +
                  (active ? "bg-accent-600" : "border border-neutral-200 dark:border-neutral-800")
                }
              >
                <Text
                  className={
                    "text-sm " + (active ? "text-white" : "text-neutral-600 dark:text-neutral-300")
                  }
                >
                  {t(r.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* One row when there is room for all three, else a full-width stack: a 2 + 1 grid left
            the third card orphaned. */}
        <View
          onLayout={(e) => setContentWidth(e.nativeEvent.layout.width)}
          className={cardsInRow ? "flex-row gap-3" : "gap-3"}
        >
          <StatCard
            icon={CircleCheckBig}
            label={t("stats.completedInDays", { days: rangeDays })}
            value={String(total)}
            accent="text-emerald-500"
            inRow={cardsInRow}
          />
          <StatCard
            icon={Flame}
            label={t("stats.currentStreak")}
            value={String(streak)}
            unit={t("stats.streakUnit", { count: streak })}
            accent="text-orange-500"
            inRow={cardsInRow}
          />
          {/* Focused time comes from Pomodoro; hide it entirely when focus is disabled. */}
          {focusEnabled && (
            <StatCard
              icon={Timer}
              label={t("stats.focusedTime")}
              value={formatDuration(focusedMs)}
              accent="text-accent-500"
              inRow={cardsInRow}
            />
          )}
        </View>

        <View>
          <SectionHeading>{weekly ? t("stats.perWeek") : t("stats.perDay")}</SectionHeading>
          <BarChart
            values={chart.map((c) => c.count)}
            ariaLabel={t("stats.overTime")}
            height={chartHeight}
            baseline
            peakLabel={chartPeak > 0 ? t("stats.peak", { value: chartPeak }) : undefined}
            startLabel={chart.length > 0 ? dayLabel(dayFmt, chart[0]!.key) : undefined}
            endLabel={
              weekly && chart.length > 0
                ? dayLabel(dayFmt, chart[chart.length - 1]!.key)
                : t("stats.today")
            }
          />
        </View>

        <View>
          <SectionHeading>{t("stats.byProject")}</SectionHeading>
          {byProject.length === 0 ? (
            <Text className="text-sm text-neutral-500">{t("stats.noCompletions")}</Text>
          ) : (
            <View className="gap-1.5">
              {byProject.map((p) => (
                <BreakdownRow
                  key={p.projectId ?? "inbox"}
                  label={projectName(p.projectId)}
                  count={p.count}
                  max={maxProject}
                />
              ))}
            </View>
          )}
        </View>

        {habitsEnabled && habitCheckins.length > 0 && (
          <View>
            <SectionHeading>{t("stats.habits")}</SectionHeading>
            <View className="gap-1.5">
              {habitBlocks.map((block) => (
                <View key={block.group?.id ?? block.rows[0]!.habit.id} className="gap-1.5">
                  {block.group !== null && (
                    <BreakdownRow
                      label={block.group.name}
                      count={block.count}
                      max={maxHabit}
                      tint={block.group.color}
                    />
                  )}
                  {block.rows.map(({ habit, count }) => (
                    <BreakdownRow
                      key={habit.id}
                      label={habit.name}
                      count={count}
                      max={maxHabit}
                      tint={habit.color}
                      indent={block.group !== null}
                    />
                  ))}
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </ScreenFade>
  );
}
