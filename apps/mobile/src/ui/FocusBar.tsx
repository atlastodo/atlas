import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { formatClock } from "@atlastodo/shared";
import { BOTTOM_CHROME_GAP, useBottomChrome } from "../data/BottomChromeContext";
import { useFocus } from "../data/FocusProvider";
import { useIsWide } from "../hooks/useIsWide";
import { useLocalTasks } from "../hooks/useLocalTasks";
import { usePreferences } from "../hooks/usePreferences";
import { haptics } from "../lib/haptics";
import { PHASE_ICON, PHASE_KEY, PHASE_START_KEY } from "./focusPhase";
import { ChevronDown, ChevronLeft, ChevronUp, Pause, Play, SkipForward, Square } from "./icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * The persistent focus-timer bar: a floating overlay at the bottom-right, above the bottom nav and
 * below the list's FloatingAddButton, that stays put across navigation while a run is active.
 * Controls: pause/resume (also "start" for a phase waiting on its tap), skip, stop, collapse.
 * Collapsed it is a mini-pill; swiping right or tapping the dock button docks it to the screen edge.
 */

const MARGIN = Platform.OS === "web" ? 16 : 8;

const FALLBACK_H = 48;

export function FocusBar({ onOpen }: { onOpen?: () => void } = {}) {
  const { t } = useTranslation();
  const { active, taskId, phase, remainingMs, running, awaitingStart, pause, resume, skip, stop } =
    useFocus();
  const { focusEnabled } = usePreferences();
  const { navHeight, setFocusBarBottom } = useBottomChrome();
  const { tasks } = useLocalTasks();
  const { width: winW } = useWindowDimensions();
  const isWide = useIsWide();
  const insets = useSafeAreaInsets();

  const [collapsed, setCollapsed] = useState(false);
  const [tucked, setTucked] = useState(false);

  const [height, setHeight] = useState(0);

  const dockToEdge = useCallback(() => {
    haptics.selection();
    setTucked(true);
  }, []);

  const undockFromEdge = useCallback(() => {
    haptics.selection();
    setTucked(false);
  }, []);

  const pan = usePanGesture({
    activeOffsetX: [-25, 25],
    onDeactivate: (e) => {
      if (e.translationX > 35 || e.velocityX > 350) {
        runOnJS(dockToEdge)();
      } else if (e.translationX < -25 || e.velocityX < -250) {
        runOnJS(undockFromEdge)();
      }
    },
  });

  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setHeight((prev) => (prev === h ? prev : h));
  };

  const shown = active && focusEnabled;

  const occupiesBottom = shown ? height || FALLBACK_H : 0;
  useEffect(() => {
    setFocusBarBottom(occupiesBottom);
  }, [occupiesBottom, setFocusBarBottom]);

  useEffect(() => () => setFocusBarBottom(0), [setFocusBarBottom]);

  const anchor = useMemo(
    () => ({
      position: "absolute" as const,
      bottom:
        Math.max(navHeight, insets.bottom, Platform.OS === "web" ? 16 : 0) + BOTTOM_CHROME_GAP,
      right: tucked ? 0 : MARGIN,
    }),
    [insets.bottom, navHeight, tucked],
  );

  if (!shown) return null;

  const task = tasks.find((v) => v.id === taskId);
  const isWork = phase === "work";
  const PhaseIcon = PHASE_ICON[phase];
  const phaseLabel = awaitingStart
    ? t("focus.ready", { phase: t(PHASE_KEY[phase]) })
    : t(PHASE_KEY[phase]);

  const bodyLabel = [
    phaseLabel,
    formatClock(remainingMs),
    task ? displayTitle(task, t) : t("focus.session"),
  ].join(", ");

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[anchor, { maxWidth: winW - (tucked ? 0 : MARGIN * 2) }]}>
        {tucked ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${bodyLabel}, ${t("focus.undock", "Undock from edge")}`}
            onPress={undockFromEdge}
            onLayout={onLayout}
            hitSlop={8}
            className={
              "flex-row items-center gap-1.5 rounded-l-full border-y border-l pl-3.5 pr-2.5 py-2.5 shadow-lg web:cursor-pointer " +
              (isWork
                ? "border-accent-200 bg-accent-50 dark:border-accent-900 dark:bg-accent-950"
                : "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950")
            }
          >
            <ChevronLeft size={16} className={isWork ? "text-accent-500" : "text-emerald-500"} />
            <PhaseIcon size={20} className={isWork ? "text-accent-500" : "text-emerald-500"} />
          </Pressable>
        ) : collapsed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${bodyLabel}, ${t("focus.expand", "Expand timer")}`}
            accessibilityActions={[{ name: "dock", label: t("focus.dock", "Dock to edge") }]}
            onAccessibilityAction={(e) => {
              if (e.nativeEvent.actionName === "dock") dockToEdge();
            }}
            onPress={() => setCollapsed(false)}
            onLayout={onLayout}
            className={
              "flex-row items-center gap-2 rounded-full border px-3.5 py-2 shadow-lg web:cursor-pointer " +
              (isWork
                ? "border-accent-200 bg-accent-50 dark:border-accent-900 dark:bg-accent-950"
                : "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950")
            }
          >
            <PhaseIcon size={18} className={isWork ? "text-accent-500" : "text-emerald-500"} />
            <Text
              style={{ fontVariant: ["tabular-nums"] }}
              className="text-sm font-semibold text-neutral-900 dark:text-neutral-50"
            >
              {formatClock(remainingMs)}
            </Text>
            <ChevronUp size={16} className="text-neutral-500 dark:text-neutral-400" />
          </Pressable>
        ) : (
          <View
            onLayout={onLayout}
            className={
              "flex-row items-center gap-3 rounded-xl border px-4 py-2.5 shadow-lg " +
              (isWork
                ? "border-accent-200 bg-accent-50 dark:border-accent-900 dark:bg-accent-950"
                : "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950")
            }
          >
            <Pressable
              accessibilityRole={onOpen ? "button" : "none"}
              accessibilityLabel={bodyLabel}
              onPress={onOpen}
              disabled={!onOpen}
              className="min-w-0 shrink flex-row items-center gap-3 web:cursor-pointer"
            >
              <PhaseIcon size={22} className={isWork ? "text-accent-500" : "text-emerald-500"} />
              {isWide && (
                <View className="min-w-0 max-w-[180px] shrink">
                  <Text className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                    {phaseLabel}
                  </Text>
                  <Text
                    numberOfLines={1}
                    className="text-sm text-neutral-800 dark:text-neutral-100"
                  >
                    {task ? displayTitle(task, t) : t("focus.session")}
                  </Text>
                </View>
              )}
              <Text
                style={{ fontVariant: ["tabular-nums"] }}
                className="text-xl font-semibold text-neutral-900 dark:text-neutral-50"
              >
                {formatClock(remainingMs)}
              </Text>
            </Pressable>

            <View className="flex-row items-center gap-1">
              {running ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("focus.pause")}
                  onPress={pause}
                  hitSlop={6}
                  className="rounded p-1.5 web:cursor-pointer"
                >
                  <Pause size={20} className="text-neutral-600 dark:text-neutral-300" />
                </Pressable>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={awaitingStart ? t(PHASE_START_KEY[phase]) : t("focus.resume")}
                  onPress={resume}
                  hitSlop={6}
                  className="rounded p-1.5 web:cursor-pointer"
                >
                  <Play size={20} className="text-neutral-600 dark:text-neutral-300" />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("focus.skip")}
                onPress={skip}
                hitSlop={6}
                className="rounded p-1.5 web:cursor-pointer"
              >
                <SkipForward size={20} className="text-neutral-600 dark:text-neutral-300" />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("focus.stop")}
                onPress={stop}
                hitSlop={6}
                className="rounded p-1.5 web:cursor-pointer"
              >
                <Square size={20} className="text-neutral-600 dark:text-neutral-300" />
              </Pressable>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("focus.collapse", "Collapse timer")}
                onPress={() => setCollapsed(true)}
                hitSlop={6}
                className="rounded p-1.5 ml-0.5 web:cursor-pointer web:hover:bg-neutral-200/50 dark:web:hover:bg-neutral-800/50"
              >
                <ChevronDown size={18} className="text-neutral-500 dark:text-neutral-400" />
              </Pressable>
            </View>
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}
