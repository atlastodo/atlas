import { useRef, type ReactNode } from "react";
import { Platform, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { clampOffset, classifySwipe, DEFAULT_SWIPE } from "@atlastodo/shared";
import { Calendar, Check } from "./icons";
import { haptics } from "../lib/haptics";

/**
 * A row that reveals quick actions on a horizontal swipe. The caller decides what each direction
 * does (`onSwipeRight` / `onSwipeLeft`, from the user's swipe settings); a direction without a
 * handler does not move.
 */

const MAX_REVEAL = 96;

/** Leaves the leftmost strip to the drawer's edge-swipe gesture. */
const DRAWER_EDGE_GUARD = 28;
const isWeb = Platform.OS === "web";

export function SwipeableRow({
  children,
  onSwipeRight,
  onSwipeLeft,
  swipeRightIcon,
  swipeLeftIcon,
  onComplete,
  onSchedule,
  enabled = true,
}: {
  children: ReactNode;
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  swipeRightIcon?: ReactNode;
  swipeLeftIcon?: ReactNode;
  onComplete?: () => void;
  onSchedule?: () => void;
  enabled?: boolean;
}) {
  const handleRight = onSwipeRight ?? onComplete;
  const handleLeft = onSwipeLeft ?? onSchedule;

  const offset = useSharedValue(0);
  // Whether the drag is past the action threshold, so the preview tick fires once per crossing.
  const crossed = useSharedValue(false);
  const isSwipingRef = useRef(false);

  const handlers = useRef({ handleRight, handleLeft });
  handlers.current = { handleRight, handleLeft };

  const canSwipeRight = Boolean(handleRight);
  const canSwipeLeft = Boolean(handleLeft);

  const pan = usePanGesture({
    // Callbacks run on the JS thread to avoid native UI worklet crashes.
    runOnJS: true,
    enabled: enabled && (canSwipeRight || canSwipeLeft),
    activeOffsetX: [-12, 12],
    failOffsetY: [-12, 12],
    hitSlop: { left: -DRAWER_EDGE_GUARD },
    onUpdate: (e) => {
      let dx = e.translationX;
      if (!canSwipeRight && dx > 0) dx = 0;
      if (!canSwipeLeft && dx < 0) dx = 0;
      offset.value = clampOffset(dx, MAX_REVEAL);

      if (Math.abs(dx) > 6) {
        isSwipingRef.current = true;
      }

      const past = Math.abs(dx) >= DEFAULT_SWIPE.threshold;
      if (past !== crossed.value) {
        crossed.value = past;
        if (past) haptics.selection();
      }
    },
    onDeactivate: (e) => {
      let dx = e.translationX;
      if (!canSwipeRight && dx > 0) dx = 0;
      if (!canSwipeLeft && dx < 0) dx = 0;

      // "none" covers a too-short or mostly vertical drag, which must not commit an action.
      const action = classifySwipe({ x: 0, y: 0 }, { x: dx, y: e.translationY });

      if (action === "right" && canSwipeRight) {
        haptics.selection();
        handlers.current.handleRight?.();
      } else if (action === "left" && canSwipeLeft) {
        haptics.impact("medium");
        handlers.current.handleLeft?.();
      }
      offset.value = withSpring(0, { damping: 20, stiffness: 220 });
    },
    onFinalize: () => {
      crossed.value = false;
      if (offset.value !== 0) offset.value = withTiming(0, { duration: 120 });
      setTimeout(() => {
        isSwipingRef.current = false;
      }, 150);
    },
  });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const completeStyle = useAnimatedStyle(() => ({
    opacity: canSwipeRight ? Math.min(1, Math.max(0, offset.value / DEFAULT_SWIPE.threshold)) : 0,
  }));
  const scheduleStyle = useAnimatedStyle(() => ({
    opacity: canSwipeLeft ? Math.min(1, Math.max(0, -offset.value / DEFAULT_SWIPE.threshold)) : 0,
  }));

  return (
    <View
      className="relative overflow-hidden"
      {...(isWeb
        ? {
            onClickCapture: (e: { stopPropagation(): void; preventDefault(): void }) => {
              if (isSwipingRef.current) {
                e?.stopPropagation?.();
                e?.preventDefault?.();
              }
            },
          }
        : {})}
    >
      <View className="absolute bottom-0 left-0 right-0 top-0 flex-row items-center justify-between px-5">
        <Animated.View style={completeStyle}>
          {swipeRightIcon ?? <Check size={22} className="text-emerald-600" />}
        </Animated.View>
        <Animated.View style={scheduleStyle}>
          {swipeLeftIcon ?? <Calendar size={22} className="text-amber-600" />}
        </Animated.View>
      </View>
      <GestureDetector gesture={pan}>
        {/* NativeWind does not style the Reanimated view, so the row's opaque surface is a plain inner View. */}
        <Animated.View style={rowStyle}>
          <View className="bg-white dark:bg-zinc-950">{children}</View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
