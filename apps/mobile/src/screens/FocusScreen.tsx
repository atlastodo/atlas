import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useColorScheme } from "nativewind";
import { useTranslation } from "react-i18next";
import { useKeepAwake } from "expo-keep-awake";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ACCENTS, formatClock, formatDuration, phaseDurationMs, startOfDay } from "@atlas/shared";
import { useFocus } from "../data/FocusProvider";
import { useFocusSessions } from "../hooks/useFocusSessions";
import { useLocalTasks } from "../hooks/useLocalTasks";
import { useNow } from "../hooks/useNow";
import { usePreferences } from "../hooks/usePreferences";
import { ThemeScope } from "../theme/ThemeProvider";
import { FocusRing } from "../ui/FocusRing";
import { ScreenFade } from "../ui/ScreenFade";
import { ListPicker, type PickerOption } from "../ui/ListPicker";
import { PHASE_ICON, PHASE_KEY, PHASE_START_KEY, phaseHex } from "../ui/focusPhase";
import { Expand, Pause, Play, SkipForward, Square, X } from "../ui/icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * The full-size pomodoro timer, gated on the `focus` feature flag at the route. The clock lives in
 * `FocusProvider` (above the navigator, surviving navigation); this screen is a face for it, adding
 * a large countdown, the long-break cadence, and a way to start a run without a task.
 *
 * Zen mode is the same face inside a full-screen `Modal` with the display held awake; both come
 * from one `face()` call so they cannot drift.
 */

const TRACK_LIGHT = "#e5e5e5";
const TRACK_DARK = "#262626";

const MAX_DOTS = 12;

/** Holds the display on. A component so it mounts conditionally: keeping the screen lit just because the timer screen is open would waste battery. */
function KeepScreenAwake() {
  useKeepAwake("atlas-focus");
  return null;
}

export function FocusScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const { width, height } = useWindowDimensions();
  const { accent, timezone } = usePreferences();
  const { tasks } = useLocalTasks();
  const { sessions } = useFocusSessions();
  const now = useNow(60_000);
  const {
    active,
    taskId,
    phase,
    remainingMs,
    running,
    awaitingStart,
    completedWork,
    config,
    start,
    pause,
    resume,
    skip,
    stop,
  } = useFocus();

  const [zen, setZen] = useState(false);
  /** The task a not-yet-started run will be attached to. `""` is the explicit "no task" choice. */
  const [picked, setPicked] = useState("");

  const accentHex = ACCENTS[accent][600];
  const color = active ? phaseHex(phase, accentHex) : accentHex;
  const trackColor = colorScheme === "dark" ? TRACK_DARK : TRACK_LIGHT;

  // Idle shows the work phase at full length, around an empty track: a full ring read as "done".
  const phaseMs = phaseDurationMs(active ? phase : "work", config);
  const shownMs = active ? remainingMs : phaseMs;
  const progress = active && phaseMs > 0 ? shownMs / phaseMs : 0;

  const task = taskId === null ? null : tasks.find((x) => x.id === taskId);
  const PhaseIcon = PHASE_ICON[active ? phase : "work"];

  // `completedWork` only ticks over at the end of a work phase, so a fresh cycle's first phase is read back to zero explicitly.
  const every = Math.max(1, Math.floor(config.longBreakEvery));
  const cycleDone =
    completedWork === 0 || (phase === "work" && completedWork % every === 0)
      ? 0
      : ((completedWork - 1) % every) + 1;

  const today = useMemo(() => {
    const from = startOfDay(now, timezone || undefined);
    const mine = sessions.filter((s) => s.started_at >= from);
    return { count: mine.length, ms: mine.reduce((sum, s) => sum + s.duration_ms, 0) };
  }, [sessions, now, timezone]);

  const taskOptions = useMemo<PickerOption<string>[]>(
    () => [
      { value: "", label: t("focus.noTask"), hint: t("focus.noTaskHint") },
      ...tasks
        .filter((x) => !x.is_completed)
        .map((x) => ({ value: x.id, label: displayTitle(x, t) })),
    ],
    [tasks, t],
  );

  const phaseLabel = active ? t(PHASE_KEY[phase]) : t("focus.idle");
  // Announced sparsely: it changes only on a whole-minute boundary. It carries the task because the
  // ring's contents are hidden from assistive tech and zen mode shows nothing else.
  const minutesLeft = Math.ceil(shownMs / 60_000);
  const timerAria = task
    ? t("focus.remainingAriaTask", { count: minutesLeft, task: displayTitle(task, t) })
    : t("focus.remainingAria", { count: minutesLeft });

  const primary = !active
    ? { label: t("focus.start"), icon: Play, onPress: () => start(picked === "" ? null : picked) }
    : running
      ? { label: t("focus.pause"), icon: Pause, onPress: pause }
      : awaitingStart
        ? { label: t(PHASE_START_KEY[phase]), icon: Play, onPress: resume }
        : { label: t("focus.resume"), icon: Play, onPress: resume };
  const PrimaryIcon = primary.icon;

  /** The timer face and its controls. A plain function, not a component, so the screen and the zen modal share it without remounting. */
  const face = (size: number) => (
    // `w-full` so the action button sizes against a real width; in zen the face sits in a content-sized column.
    <View className="w-full items-center gap-6">
      <View className="flex-row items-center gap-2">
        <PhaseIcon size={16} color={color} />
        <Text className="text-xs font-semibold uppercase tracking-widest" style={{ color }}>
          {phaseLabel}
        </Text>
      </View>

      <View
        accessibilityRole="text"
        accessibilityLabel={timerAria}
        accessibilityLiveRegion="polite"
      >
        <FocusRing
          progress={progress}
          color={color}
          trackColor={trackColor}
          size={size}
          stroke={Math.max(4, Math.round(size / 40))}
        >
          <View
            className="items-center gap-1 px-4"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {/* Tabular figures: without them the digits change width as they count and the whole
                clock jitters inside the ring once a second. */}
            <Text
              style={{ fontSize: Math.round(size / 4.4), fontVariant: ["tabular-nums"] }}
              className="font-semibold text-neutral-900 dark:text-neutral-50"
            >
              {formatClock(shownMs)}
            </Text>
            {task != null && (
              <Text
                numberOfLines={2}
                className="text-center text-sm text-neutral-500 dark:text-neutral-400"
              >
                {displayTitle(task, t)}
              </Text>
            )}
          </View>
        </FocusRing>
      </View>

      {/* Dots are decorative; the sentence is what a screen reader gets. */}
      <View className="items-center gap-2">
        {every <= MAX_DOTS && (
          <View
            className="flex-row items-center gap-2"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {Array.from({ length: every }, (_, i) => (
              <View
                key={i}
                style={i < cycleDone ? { backgroundColor: color } : undefined}
                className={
                  "h-2.5 w-2.5 rounded-full " +
                  (i < cycleDone ? "" : "bg-neutral-200 dark:bg-neutral-700")
                }
              />
            ))}
          </View>
        )}
        <Text className="text-xs text-neutral-500">
          {t("focus.cycle", { done: cycleDone, total: every })}
        </Text>
      </View>

      <View className="w-full max-w-xs items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={primary.label}
          onPress={primary.onPress}
          style={{ backgroundColor: color }}
          className="w-full flex-row items-center justify-center gap-2 rounded-full px-6 py-3.5 web:cursor-pointer"
        >
          <PrimaryIcon size={20} className="text-white" />
          <Text className="text-base font-semibold text-white">{primary.label}</Text>
        </Pressable>

        {active && (
          <View className="flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("focus.skip")}
              onPress={skip}
              className="flex-row items-center gap-1.5 rounded-full border border-neutral-200 px-4 py-2 web:cursor-pointer dark:border-neutral-700"
            >
              <SkipForward size={16} className="text-neutral-600 dark:text-neutral-300" />
              <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                {t("focus.skip")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("focus.stop")}
              onPress={stop}
              className="flex-row items-center gap-1.5 rounded-full border border-neutral-200 px-4 py-2 web:cursor-pointer dark:border-neutral-700"
            >
              <Square size={16} className="text-neutral-600 dark:text-neutral-300" />
              <Text className="text-sm text-neutral-600 dark:text-neutral-300">
                {t("focus.stop")}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <>
      <ScreenFade>
        <ScrollView
          className="flex-1 bg-white dark:bg-zinc-950"
          contentContainerClassName="gap-6 px-4 pb-16 pt-2"
        >
          <View className="flex-row justify-end">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("focus.zen")}
              onPress={() => setZen(true)}
              hitSlop={8}
              className="rounded-lg p-2 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
            >
              <Expand size={20} className="text-neutral-500" />
            </Pressable>
          </View>

          {face(Math.min(300, width - 96, height * 0.4))}

          {/* A pomodoro belongs to one task for its whole length: the picker is offered before a run, the choice reported during one. */}
          {active ? (
            <View className="items-center gap-1">
              <Text className="text-xs uppercase tracking-wide text-neutral-500">
                {t("focus.focusingOn")}
              </Text>
              <Text className="text-sm text-neutral-700 dark:text-neutral-200">
                {task ? displayTitle(task, t) : t("focus.noTask")}
              </Text>
            </View>
          ) : (
            <ListPicker
              variant="chip"
              label={t("focus.task")}
              value={picked}
              options={taskOptions}
              onChange={setPicked}
            />
          )}

          <View className="items-center gap-1 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            <Text className="text-xs uppercase tracking-wide text-neutral-500">
              {t("focus.today")}
            </Text>
            <Text className="text-sm text-neutral-700 dark:text-neutral-200">
              {t("focus.todaySessions", { count: today.count })}
              {today.ms > 0 ? ` · ${formatDuration(today.ms)}` : ""}
            </Text>
          </View>
        </ScrollView>
      </ScreenFade>

      {/* Zen: `ThemeScope` is required because react-native-web portals a Modal out of the tree that carries the `--accent-*` variables. */}
      <Modal
        visible={zen}
        animationType="fade"
        transparent={false}
        onRequestClose={() => setZen(false)}
        statusBarTranslucent
      >
        <ThemeScope
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
          className="flex-1 bg-white dark:bg-zinc-950"
        >
          <View className="flex-row justify-end px-4 pt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("focus.exitZen")}
              onPress={() => setZen(false)}
              hitSlop={12}
              className="rounded-full bg-neutral-100 p-2 web:cursor-pointer dark:bg-neutral-800"
            >
              <X size={22} className="text-neutral-600 dark:text-neutral-300" />
            </Pressable>
          </View>
          <View className="flex-1 items-center justify-center px-6">
            {face(Math.min(360, width - 64, height * 0.46))}
          </View>
        </ThemeScope>
      </Modal>

      {zen && running && <KeepScreenAwake />}
    </>
  );
}
