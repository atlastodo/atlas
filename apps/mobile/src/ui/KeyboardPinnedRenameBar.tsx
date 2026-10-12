import { useEffect, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlas/client-core";
import { PRIORITY_COLOR } from "@atlas/shared";
import { useIsWide } from "../hooks/useIsWide";
import { Calendar, Check, FileText, Flag, Folder } from "./icons";
import { useMotion } from "../lib/motion";

export interface KeyboardPinnedRenameBarProps {
  /** The task currently being renamed */
  task: Task;
  /** Navigate directly to task detail screen (/task/[id]) */
  onOpenDescription: () => void;
  /** Open quick reschedule sheet */
  onOpenDue: () => void;
  /** Cycle priority or update priority */
  onCyclePriority: () => void;
  /** Open MoveToPicker to move project/section */
  onOpenMove: () => void;
  /** Done renaming - commit the draft title (like Enter) and exit rename mode */
  onDone: () => void;
}

/**
 * Mobile-only toolbar pinned right above the software keyboard when renaming a task inline.
 * Gives quick one-tap access to Description/Details, Due Date, Priority, Project/Section, and Done.
 */
export function KeyboardPinnedRenameBar({
  task,
  onOpenDescription,
  onOpenDue,
  onCyclePriority,
  onOpenMove,
  onDone,
}: KeyboardPinnedRenameBarProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isWide = useIsWide();
  const m = useMotion();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) => {
      if (e?.endCoordinates?.height) {
        setKeyboardHeight(e.endCoordinates.height);
      }
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const isPhone = Platform.OS !== "web" && !isWide;
  // On phones, MobileBottomNav sits at the bottom of the drawer shell (~64dp + insets.bottom).
  // The keyboard opens over the full window, covering MobileBottomNav.
  // We subtract bottomNavHeight so the toolbar sits flush right on top of the keyboard.
  const bottomNavHeight = isPhone ? 64 + Math.max(insets.bottom, 6) : 0;
  // Positioned right above the keyboard with ~0.5 cm (24dp) clearance
  const bottomOffset = keyboardHeight > 0 ? Math.max(0, keyboardHeight - bottomNavHeight + 24) : 0;

  const priority = task.priority ?? 4;
  const flagColor = PRIORITY_COLOR[priority] ?? "";

  return (
    <Animated.View layout={m.panelLayout} style={[styles.bar, { bottom: bottomOffset }]}>
      {/* The bar's surface is on this plain View: NativeWind ignores `className` on Reanimated's
          Animated.View. */}
      <View className="flex-row items-center justify-between border-t border-neutral-200 bg-white/95 px-3 py-1.5 shadow-lg backdrop-blur-md dark:border-neutral-800 dark:bg-neutral-900/95">
        {/* Left actions: Description, Due Date, Priority, Project */}
        <View className="flex-row items-center gap-1.5">
          {/* 1. Description / Details */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("taskDetail.notes")}
            onPress={onOpenDescription}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-xl p-2 active:bg-neutral-100 dark:active:bg-neutral-800"
          >
            <FileText
              size={20}
              className={
                task.notes
                  ? "text-accent-600 dark:text-accent-400"
                  : "text-neutral-600 dark:text-neutral-400"
              }
            />
          </Pressable>

          {/* 2. Due Date */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("taskDetail.dueDate", "Due date")}
            onPress={onOpenDue}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-xl p-2 active:bg-neutral-100 dark:active:bg-neutral-800"
          >
            <Calendar
              size={20}
              className={
                task.due_at != null
                  ? "text-accent-600 dark:text-accent-400"
                  : "text-neutral-600 dark:text-neutral-400"
              }
            />
          </Pressable>

          {/* 3. Priority */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("taskDetail.priority", "Priority")}
            onPress={onCyclePriority}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-xl p-2 active:bg-neutral-100 dark:active:bg-neutral-800"
          >
            <Flag size={20} className={flagColor || "text-neutral-500"} />
            {priority < 4 && (
              <Text
                className={
                  "text-xs font-bold " + (flagColor || "text-neutral-600 dark:text-neutral-400")
                }
              >
                P{priority}
              </Text>
            )}
          </Pressable>

          {/* 4. Project / Section */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("taskDetail.project", "Project")}
            onPress={onOpenMove}
            hitSlop={8}
            className="flex-row items-center gap-1 rounded-xl p-2 active:bg-neutral-100 dark:active:bg-neutral-800"
          >
            <Folder
              size={20}
              className={
                task.project_id != null
                  ? "text-accent-600 dark:text-accent-400"
                  : "text-neutral-600 dark:text-neutral-400"
              }
            />
          </Pressable>
        </View>

        {/* Right action: Done */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.done", "Done")}
          onPress={onDone}
          hitSlop={8}
          className="flex-row items-center gap-1.5 rounded-full bg-accent-600 px-3.5 py-1.5 active:bg-accent-700"
        >
          <Check size={16} className="text-white" />
          <Text className="text-xs font-semibold text-white">{t("common.done", "Done")}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 90,
  },
});
