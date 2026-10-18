import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import {
  dayOffset,
  endOfDay,
  planDayPostponeOptions,
  planDayWrites,
  type PlanDayDecision,
  type PlanDayItem,
  type PlanDayWrite,
} from "@atlastodo/shared";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { EmptyState } from "./EmptyState";
import { CalendarClock, Plus, X } from "./icons";
import { haptics } from "../lib/haptics";
import { displayTitle } from "../lib/taskTitle";

/**
 * The plan-my-day guided review: each of today's overdue and dated-today tasks gets Keep, Postpone
 * (pick a day; tomorrow is the default) or Later. "Add from upcoming" pulls in a task due within
 * 7 days; keeping it moves it to today.
 *
 * Decisions are staged in local state and become writes only on Apply, handed to the caller as
 * `{ id, dueAt }` changes for the normal store path (undo toast, offline-first sync). The sheet
 * has no store access.
 *
 * The postpone picker is an inline day strip, not the stacked `QuickRescheduleSheet`: two nested
 * modals both listen for web Escape, which would close the whole review. On web Enter applies
 * (capture-phase) and Escape closes via the Modal.
 */

export interface PlanDaySheetProps {
  open: boolean;
  items: PlanDayItem[];
  upcoming: Task[];
  now: number;
  timeZone?: string;
  formatDue?: (ms: number) => string;
  onApply: (writes: PlanDayWrite[]) => void;
  onClose: () => void;
}

export function PlanDaySheet({
  open,
  items,
  upcoming,
  now,
  timeZone,
  formatDue,
  onApply,
  onClose,
}: PlanDaySheetProps) {
  const { t, i18n } = useTranslation();
  const [decisions, setDecisions] = useState<Record<string, PlanDayDecision>>({});
  const [brought, setBrought] = useState<PlanDayItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [postponingId, setPostponingId] = useState<string | null>(null);
  // Set when apply failed: stay open over the unchanged list.
  const [applyError, setApplyError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDecisions({});
    setBrought([]);
    setPickerOpen(false);
    setPostponingId(null);
    setApplyError(false);
  }, [open]);

  const review = useMemo(() => [...items, ...brought], [items, brought]);
  const todayEnd = useMemo(() => endOfDay(now, timeZone), [now, timeZone]);
  const postponeOptions = useMemo(() => planDayPostponeOptions(now, timeZone), [now, timeZone]);
  const broughtIds = useMemo(() => new Set(brought.map((i) => i.task.id)), [brought]);
  const pool = useMemo(
    () => upcoming.filter((task) => !broughtIds.has(task.id)),
    [upcoming, broughtIds],
  );
  const writes = useMemo(
    () => planDayWrites(review, decisions, todayEnd),
    [review, decisions, todayEnd],
  );

  const decide = useCallback((task: Task, decision: PlanDayDecision) => {
    haptics.selection();
    setApplyError(false);
    setPostponingId(null);
    setDecisions((prev) => ({ ...prev, [task.id]: decision }));
  }, []);

  const togglePostpone = useCallback(
    (task: Task) => {
      haptics.selection();
      setApplyError(false);
      if (postponingId === task.id) {
        setPostponingId(null);
        return;
      }
      setDecisions((prev) =>
        prev[task.id]?.kind === "postpone"
          ? prev
          : { ...prev, [task.id]: { kind: "postpone", dueAt: postponeOptions[0]!.dueAt } },
      );
      setPostponingId(task.id);
    },
    [postponingId, postponeOptions],
  );

  const addFromUpcoming = useCallback((task: Task) => {
    haptics.selection();
    setApplyError(false);
    setBrought((prev) =>
      prev.some((i) => i.task.id === task.id)
        ? prev
        : [...prev, { task, bucket: "upcoming" as const }],
    );
    // Keeping a task pulled in from upcoming moves it to today.
    setDecisions((prev) => ({ ...prev, [task.id]: { kind: "keep" } }));
  }, []);

  const apply = useCallback(() => {
    try {
      onApply(writes);
    } catch {
      // Partial failure must not wedge the pass; untouched tasks come back on the next run.
      setApplyError(true);
      return;
    }
    onClose();
  }, [onApply, writes, onClose]);

  /** "Tomorrow", then a compact weekday; unique within a 7-day window. */
  const dayLabel = useCallback(
    (offset: number, dueAt: number): string => {
      if (offset === 1) return t("group.tomorrow");
      return new Intl.DateTimeFormat(i18n.language || undefined, {
        weekday: "short",
        timeZone,
      }).format(dueAt);
    },
    [t, i18n.language, timeZone],
  );

  // Web: Enter applies. Capture-phase so it wins over the global hotkeys; ignored while the picker is open or nothing is staged.
  useEffect(() => {
    if (!open || Platform.OS !== "web") return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.isComposing || pickerOpen) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (writes.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      apply();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, pickerOpen, writes, apply]);

  const chipFor = (item: PlanDayItem): { text: string; className: string } => {
    const decision = decisions[item.task.id];
    if (decision?.kind === "postpone") {
      return {
        text: t("planDay.movesTo", { date: formatDue ? formatDue(decision.dueAt) : "" }),
        className: "text-accent-600 dark:text-accent-400",
      };
    }
    if (decision?.kind === "keep" && item.bucket === "upcoming") {
      return {
        text: t("planDay.movesTo", { date: t("group.today") }),
        className: "text-accent-600 dark:text-accent-400",
      };
    }
    if (item.bucket === "overdue") {
      const date = formatDue && item.task.due_at !== null ? `, ${formatDue(item.task.due_at)}` : "";
      return {
        text: `${t("workspace.overdue")}${date}`,
        className: "text-red-600 dark:text-red-400",
      };
    }
    if (item.bucket === "upcoming") {
      return {
        text: formatDue && item.task.due_at !== null ? formatDue(item.task.due_at) : "",
        className: "text-neutral-500 dark:text-neutral-400",
      };
    }
    return { text: t("group.today"), className: "text-neutral-500 dark:text-neutral-400" };
  };

  return (
    <BottomSheet
      visible={open}
      onClose={onClose}
      size="list"
      title={t("planDay.title")}
      subtitle={review.length > 0 ? t("planDay.subtitle", { count: review.length }) : undefined}
      icon={<CalendarClock size={18} className="text-neutral-500" />}
    >
      {/* The review list and the picker scroll as one, shrinking to what the sheet's max height
          leaves; Apply stays pinned below them so it is reachable however long they get. */}
      <View style={{ flexShrink: 1 }}>
        <SheetScrollView
          style={{ flexGrow: 0, flexShrink: 1 }}
          testID="plan-day-scroll"
          keyboardShouldPersistTaps="handled"
        >
          {review.length === 0 ? (
            <View className="min-h-[240px] flex-1 justify-center">
              <EmptyState
                icon={CalendarClock}
                title={t("planDay.emptyTitle")}
                description={t("planDay.emptyBody")}
                actions={[
                  {
                    label: t("planDay.addFromUpcoming"),
                    onPress: () => setPickerOpen(true),
                    primary: true,
                  },
                ]}
              />
            </View>
          ) : (
            <View className="gap-2">
              {review.map((item) => {
                const decision = decisions[item.task.id];
                const chip = chipFor(item);
                return (
                  <View
                    key={item.task.id}
                    className="gap-2 rounded-lg border border-neutral-100 p-3 dark:border-neutral-800"
                  >
                    <View className="flex-row items-center gap-2">
                      <View className="flex-1 gap-0.5">
                        <Text
                          numberOfLines={2}
                          className="text-sm font-medium text-neutral-900 dark:text-neutral-100"
                        >
                          {displayTitle(item.task, t)}
                        </Text>
                        {item.bucket === "upcoming" && (
                          <Text className="text-[11px] text-neutral-500">
                            {t("planDay.addedFromUpcoming")}
                          </Text>
                        )}
                      </View>
                      {chip.text !== "" && (
                        <Text className={"shrink text-xs " + chip.className}>{chip.text}</Text>
                      )}
                    </View>

                    <View className="flex-row gap-1.5">
                      <RowAction
                        label={t("planDay.keep")}
                        accessibilityLabel={`${t("planDay.keep")}: ${displayTitle(item.task, t)}`}
                        active={decision?.kind === "keep"}
                        onPress={() => decide(item.task, { kind: "keep" })}
                      />
                      <RowAction
                        label={t("planDay.postpone")}
                        accessibilityLabel={`${t("planDay.postpone")}: ${displayTitle(item.task, t)}`}
                        active={decision?.kind === "postpone"}
                        onPress={() => togglePostpone(item.task)}
                      />
                      <RowAction
                        label={t("planDay.later")}
                        accessibilityLabel={`${t("planDay.later")}: ${displayTitle(item.task, t)}`}
                        active={decision?.kind === "later"}
                        onPress={() => decide(item.task, { kind: "later" })}
                      />
                    </View>

                    {postponingId === item.task.id && (
                      <View className="flex-row flex-wrap gap-1.5">
                        {postponeOptions.map((opt) => {
                          const day = dayLabel(opt.offset, opt.dueAt);
                          return (
                            <Pressable
                              key={opt.offset}
                              accessibilityRole="button"
                              // Day names only; the row's task disambiguates them for screen readers.
                              accessibilityLabel={`${day}: ${displayTitle(item.task, t)}`}
                              onPress={() =>
                                decide(item.task, { kind: "postpone", dueAt: opt.dueAt })
                              }
                              className="rounded-full border border-neutral-200 px-2.5 py-1 dark:border-neutral-700 web:cursor-pointer"
                            >
                              <Text
                                className={
                                  "text-xs " +
                                  (opt.offset === 1
                                    ? "font-semibold text-accent-700 dark:text-accent-300"
                                    : "text-neutral-600 dark:text-neutral-300")
                                }
                              >
                                {day}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}

          {(pickerOpen || review.length > 0) && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("planDay.addFromUpcoming")}
              onPress={() => setPickerOpen((curr) => !curr)}
              className="mt-3 flex-row items-center justify-center gap-1.5 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-700 web:cursor-pointer"
            >
              <Plus size={14} className="text-neutral-500" />
              <Text className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {t("planDay.addFromUpcoming")}
              </Text>
            </Pressable>
          )}

          {pickerOpen && (
            <View className="mt-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
              <View className="mb-1 flex-row items-center justify-between">
                <Text className="text-xs font-semibold uppercase text-neutral-500">
                  {t("planDay.upcomingTitle")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close")}
                  onPress={() => setPickerOpen(false)}
                >
                  <X size={14} className="text-neutral-500" />
                </Pressable>
              </View>
              {pool.length === 0 ? (
                <Text className="py-4 text-center text-sm text-neutral-500">
                  {t("planDay.upcomingEmpty")}
                </Text>
              ) : (
                <View className="gap-0.5">
                  {pool.map((task) => {
                    const offset = task.due_at !== null ? dayOffset(task.due_at, now, timeZone) : 0;
                    return (
                      <Pressable
                        key={task.id}
                        accessibilityRole="button"
                        accessibilityLabel={`${t("planDay.addFromUpcoming")}: ${displayTitle(task, t)}`}
                        onPress={() => addFromUpcoming(task)}
                        className="flex-row items-center justify-between gap-2 rounded-md px-2 py-2.5 active:bg-neutral-100 dark:active:bg-neutral-800 web:cursor-pointer"
                      >
                        <Text
                          numberOfLines={1}
                          className="flex-1 text-sm text-neutral-900 dark:text-neutral-100"
                        >
                          {displayTitle(task, t)}
                        </Text>
                        <Text className="shrink text-xs text-neutral-500">
                          {dayLabel(offset, task.due_at ?? now)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </SheetScrollView>

        {review.length > 0 && (
          <View className="mt-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("planDay.apply")}
              disabled={writes.length === 0}
              onPress={apply}
              className={
                "items-center rounded-md py-3 " +
                (writes.length === 0
                  ? "bg-neutral-200 dark:bg-neutral-800"
                  : "bg-accent-600 web:cursor-pointer")
              }
            >
              <Text
                className={
                  "text-sm font-semibold " +
                  (writes.length === 0 ? "text-neutral-500" : "text-white")
                }
              >
                {writes.length > 0
                  ? `${t("planDay.apply")} (${writes.length})`
                  : t("planDay.apply")}
              </Text>
            </Pressable>
            {applyError && (
              <Text className="mt-2 text-center text-xs text-red-600 dark:text-red-400">
                {t("planDay.error")}
              </Text>
            )}
          </View>
        )}
      </View>
    </BottomSheet>
  );
}

function RowAction({
  label,
  accessibilityLabel,
  active,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className={
        "flex-1 items-center rounded-md border px-2 py-1.5 web:cursor-pointer " +
        (active
          ? "border-accent-600 bg-accent-50 dark:border-accent-400 dark:bg-accent-900"
          : "border-neutral-200 dark:border-neutral-700")
      }
    >
      <Text
        className={
          "text-xs font-medium " +
          (active
            ? "text-accent-700 dark:text-accent-300"
            : "text-neutral-600 dark:text-neutral-300")
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}
