import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import Reanimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import {
  PREFERENCES_ID,
  TOAST_TTL_MS,
  toastReducer,
  type Toast,
  type ToastAction,
} from "@atlastodo/shared";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsWide } from "../hooks/useIsWide";
import { X } from "../ui/icons";
import { useMotion } from "../lib/motion";
import { useStoreOptional } from "./StoreProvider";

/**
 * In-app toast layer over the pure `toastReducer`/`TOAST_TTL_MS` from `@atlastodo/shared`. Toasts
 * appear bottom-centre, auto-dismiss after {@link TOAST_TTL_MS}, and can carry an Undo action.
 * Mounted around the navigator so any screen can `useToast().show(...)`.
 */

export interface ToastApi {
  /** Show a transient toast with an optional action (e.g. Undo). Auto-dismisses after a timeout. */
  show: (message: string, action?: ToastAction) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ephemeral UI ids, not entities: a counter avoids Hermes's missing `crypto`.
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    dispatch({ type: "dismiss", id });
  }, []);

  const storeCtx = useStoreOptional();
  const rawDuration = storeCtx?.store.get("preference", PREFERENCES_ID)?.toast_duration;
  const ttlMs =
    typeof rawDuration === "number" && rawDuration > 0 ? rawDuration * 1000 : TOAST_TTL_MS;

  const show = useCallback(
    (message: string, action?: ToastAction) => {
      const id = `t${seq.current++}`;
      dispatch({ type: "add", toast: { id, message, action } });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ttlMs),
      );
    },
    [dismiss, ttlMs],
  );

  // Clear pending auto-dismiss timers on unmount.
  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const timer of timerMap.values()) clearTimeout(timer);
      timerMap.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  const insets = useSafeAreaInsets();
  const isWide = useIsWide();
  const isWeb = Platform.OS === "web";
  // Any phone width has the bottom nav, web included.
  const isPhone = !isWide;

  // On phones, place toasts just above the MobileBottomNav (~56px high + insets.bottom + 12px margin);
  // on wide viewports, where there is no bottom nav, use safe-area bottom offset + 24px.
  const bottomOffset = isPhone
    ? 56 + Math.max(insets.bottom, 6) + 12
    : Math.max(insets.bottom + 16, 24);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && (
        <View
          style={{ bottom: bottomOffset, pointerEvents: isWeb ? "none" : "box-none" }}
          className="absolute inset-x-0 z-40 items-center gap-2 px-4"
        >
          {toasts.map((toast) => (
            <ToastItem
              key={toast.id}
              toast={toast}
              closeLabel={t("common.close")}
              onDismiss={() => dismiss(toast.id)}
              ttlMs={ttlMs}
            />
          ))}
        </View>
      )}
    </ToastContext.Provider>
  );
}

/**
 * One toast row with a countdown bar that drains right-to-left over ttlMs, showing how long an Undo
 * stays available. The drain is one Reanimated timing on the UI thread; React state would
 * re-render the whole toast every frame.
 */
function ToastItem({
  toast,
  closeLabel,
  onDismiss,
  ttlMs,
}: {
  toast: Toast;
  closeLabel: string;
  onDismiss: () => void;
  ttlMs: number;
}) {
  const motion = useMotion();
  const remaining = useSharedValue(1);

  useEffect(() => {
    remaining.value = 1;
    remaining.value = withTiming(0, { duration: ttlMs, easing: Easing.linear });
  }, [remaining, ttlMs]);

  const barStyle = useAnimatedStyle(() => ({ width: `${remaining.value * 100}%` }));

  return (
    <Reanimated.View
      entering={motion.toastEntering}
      exiting={motion.toastExiting}
      style={{ width: "50%", maxWidth: 384, alignSelf: "center", pointerEvents: "auto" }}
    >
      <View
        accessibilityRole="alert"
        className="w-full overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-lg"
      >
        <View className="flex-row items-center justify-between gap-2 px-3 py-2">
          <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-neutral-100">
            {toast.message}
          </Text>
          <View className="flex-row items-center gap-1">
            {toast.action && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={toast.action.label}
                onPress={() => {
                  toast.action?.run();
                  onDismiss();
                }}
                hitSlop={8}
                className="rounded px-2 py-1 web:cursor-pointer"
              >
                <Text className="text-xs font-semibold text-accent-300">{toast.action.label}</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              onPress={onDismiss}
              hitSlop={8}
              className="rounded p-1 web:cursor-pointer"
            >
              <X size={14} className="text-neutral-500" />
            </Pressable>
          </View>
        </View>
        <View className="h-1 w-full overflow-hidden bg-neutral-700">
          {/* The colour sits on a plain View: NativeWind ignores `className` on Reanimated views. */}
          <Reanimated.View style={[{ height: "100%" }, barStyle]}>
            <View className="h-full w-full bg-accent-500" />
          </Reanimated.View>
        </View>
      </View>
    </Reanimated.View>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
