import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { ComposedGesture } from "react-native-gesture-handler";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import type { useAnimatedProps, useAnimatedScrollHandler } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, CopyPlus, Ellipsis, SkipForward, Trash2, X } from "../ui/icons";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { isModalOpen } from "../lib/modalOpen";
import { useIsWide } from "../hooks/useIsWide";
import { useSheetDismiss } from "../ui/useSheetDismiss";

export interface SheetScrollContextValue {
  scrollHandler: ReturnType<typeof useAnimatedScrollHandler>;
  composedGesture?: ComposedGesture;
  /** Freezes the scroll view while a pull drives the sheet. */
  scrollAnimatedProps?: ReturnType<typeof useAnimatedProps>;
}

const SheetScrollContext = createContext<SheetScrollContextValue | null>(null);

export function useSheetScroll() {
  return useContext(SheetScrollContext);
}

/** The chrome around the task detail, which the route presents as a `transparentModal`: a right-side panel (~420px) over a tap-to-close backdrop when wide, a bottom sheet with pull-down dismissal on a phone. */
export interface TaskDetailWebFrameProps {
  isWide?: boolean;
  title: string;
  projectName?: string;
  onProjectPress?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  onSkip?: () => void;
  onClose: () => void;
  hasUnsavedChanges?: boolean;
  onDiscard?: () => void;
  onSaveAndClose?: () => void;
  children: ReactNode;
}

export function TaskDetailWebFrame({
  isWide: propIsWide,
  title,
  projectName,
  onProjectPress,
  onArchive,
  onDelete,
  onDuplicate,
  onSkip,
  onClose,
  hasUnsavedChanges = false,
  onDiscard,
  onSaveAndClose,
  children,
}: TaskDetailWebFrameProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const detectedWide = useIsWide();
  const isWide = propIsWide ?? detectedWide;
  const {
    isWeb,
    dismiss,
    animatedStyle,
    headerPanGesture,
    scrollHandler,
    composedGesture,
    scrollAnimatedProps,
  } = useSheetDismiss(onClose);

  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const requestClose = useCallback(() => {
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  }, [hasUnsavedChanges, onClose]);

  const handleBackdropPress = () => {
    requestClose();
  };

  useEffect(() => {
    if (!isWeb || typeof window === "undefined") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A dialog open over the detail (picker, scope prompt, palette, discard confirm) takes its own Escape.
      if (e.key === "Escape" && !isModalOpen()) {
        e.preventDefault();
        e.stopPropagation();
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
          return;
        }
        requestClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isWeb, showDiscardConfirm, requestClose]);

  const confirmDialog = (
    <ConfirmDialog
      visible={showDiscardConfirm}
      title={t("taskDetail.discardTitle", "Discard unsaved changes?")}
      message={t(
        "taskDetail.discardMessage",
        "You have unsaved changes. What would you like to do?",
      )}
      confirmLabel={t("common.discard", "Discard")}
      cancelLabel={t("common.keepEditing", "Keep editing")}
      saveLabel={t("taskDetail.saveAndClose", "Save & Close")}
      danger
      onConfirm={() => {
        setShowDiscardConfirm(false);
        onDiscard?.();
        onClose();
      }}
      onSave={() => {
        setShowDiscardConfirm(false);
        onSaveAndClose?.();
        onClose();
      }}
      onCancel={() => {
        setShowDiscardConfirm(false);
      }}
    />
  );

  const [showActionsMenu, setShowActionsMenu] = useState(false);

  const actionsModal = showActionsMenu ? (
    <Modal
      transparent
      animationType="fade"
      visible={showActionsMenu}
      onRequestClose={() => setShowActionsMenu(false)}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          isWeb ? ({ position: "fixed", zIndex: 10000 } as object) : undefined,
        ]}
        className="justify-end p-4"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={() => setShowActionsMenu(false)}
          style={StyleSheet.absoluteFill}
          className="bg-black/60"
        />
        <View className="z-10 rounded-2xl border border-neutral-200 bg-white p-3 shadow-2xl dark:border-neutral-800 dark:bg-zinc-900 sm:mx-auto sm:max-w-md sm:w-full">
          <View className="mb-2 items-center py-1">
            <View className="h-1 w-8 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          </View>
          <Text className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {t("task.actions", "Task actions")}
          </Text>

          {onDuplicate && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.duplicate")}
              onPress={() => {
                setShowActionsMenu(false);
                onDuplicate();
              }}
              className="flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-neutral-100 dark:active:bg-neutral-800 web:cursor-pointer"
            >
              <CopyPlus size={18} className="text-neutral-500" />
              <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t("common.duplicate")}
              </Text>
            </Pressable>
          )}

          {onArchive && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("common.archive")}
              onPress={() => {
                setShowActionsMenu(false);
                onArchive();
              }}
              className="flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-neutral-100 dark:active:bg-neutral-800 web:cursor-pointer"
            >
              <Archive size={18} className="text-neutral-500" />
              <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t("common.archive")}
              </Text>
            </Pressable>
          )}

          {onSkip && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("task.skipOccurrence")}
              onPress={() => {
                setShowActionsMenu(false);
                onSkip();
              }}
              className="flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-neutral-100 dark:active:bg-neutral-800 web:cursor-pointer"
            >
              <SkipForward size={18} className="text-neutral-500" />
              <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {t("task.skipOccurrence")}
              </Text>
            </Pressable>
          )}

          {onDelete && (
            <>
              <View className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.delete")}
                onPress={() => {
                  setShowActionsMenu(false);
                  onDelete();
                }}
                className="flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-red-50 dark:active:bg-red-950/40 web:cursor-pointer"
              >
                <Trash2 size={18} className="text-red-500" />
                <Text className="text-sm font-medium text-red-600 dark:text-red-400">
                  {t("common.delete")}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </Modal>
  ) : null;

  if (isWeb) {
    return (
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            position: "fixed",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            backgroundColor: "rgba(0, 0, 0, 0.55)",
            justifyContent: "center",
            alignItems: "center",
          } as object,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={handleBackdropPress}
          style={StyleSheet.absoluteFill}
        />

        <View
          style={{
            width: isWide ? "92%" : "94%",
            maxWidth: isWide ? 1000 : 680,
            height: isWide ? "88%" : "85%",
            maxHeight: isWide ? 840 : 780,
            zIndex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderRadius: 16,
          }}
          className="bg-white dark:bg-zinc-950 shadow-2xl border border-neutral-200 dark:border-neutral-800"
        >
          <View
            style={{ paddingHorizontal: 24, paddingVertical: 16 }}
            className="border-b border-neutral-100 dark:border-neutral-800 flex-row items-center justify-between"
          >
            {onProjectPress ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("moveTo.title")}
                onPress={onProjectPress}
                className="flex-row items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700 web:cursor-pointer"
              >
                <View className="h-2 w-2 rounded-full bg-accent-500" />
                <Text className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
                  {projectName ?? title}
                </Text>
                <ChevronDown size={14} className="text-neutral-500" />
              </Pressable>
            ) : (
              <Text className="flex-1 text-lg font-bold text-neutral-900 dark:text-neutral-100">
                {title}
              </Text>
            )}
            <View className="flex-row items-center gap-1">
              {(onArchive || onDelete || onDuplicate || onSkip) && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("task.actions", "Task actions")}
                  onPress={() => setShowActionsMenu(true)}
                  hitSlop={8}
                  className="rounded-full p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 web:cursor-pointer"
                >
                  <Ellipsis size={20} className="text-neutral-500" />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
                onPress={requestClose}
                hitSlop={8}
                className="rounded-full p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 web:cursor-pointer"
              >
                <X size={20} className="text-neutral-500" />
              </Pressable>
            </View>
          </View>

          <SheetScrollContext.Provider
            value={{ scrollHandler, composedGesture, scrollAnimatedProps }}
          >
            <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</View>
          </SheetScrollContext.Provider>
        </View>

        {confirmDialog}
        {actionsModal}
      </View>
    );
  }

  const handleNativeDismiss = () => {
    if (hasUnsavedChanges) {
      setShowDiscardConfirm(true);
      return;
    }
    dismiss();
  };

  return (
    <View className="flex-1 justify-end bg-black/60">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={handleNativeDismiss}
        style={StyleSheet.absoluteFill}
      />

      {/* The Reanimated view only slides; NativeWind does not style it, so the sheet's surface is
          the plain View inside. */}
      <Animated.View style={[{ width: "100%", height: "88%", maxHeight: "92%" }, animatedStyle]}>
        <View
          style={{ paddingBottom: Math.max(insets.bottom, 16), paddingHorizontal: 24 }}
          className="w-full flex-1 flex-col rounded-t-3xl border-t border-neutral-200 bg-white pt-3 shadow-2xl dark:border-neutral-800 dark:bg-zinc-950 sm:mx-auto sm:max-w-xl"
        >
          <GestureDetector gesture={headerPanGesture}>
            <View className="pb-1">
              {!isWeb && (
                <View className="mb-2 items-center bg-transparent py-1">
                  <View className="h-1.5 w-12 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                </View>
              )}

              <View className="flex-row items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
                {onProjectPress ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("moveTo.title")}
                    onPress={onProjectPress}
                    className="flex-row items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
                  >
                    <View className="h-2 w-2 rounded-full bg-accent-500" />
                    <Text
                      className="max-w-[200px] text-xs font-semibold text-neutral-800 dark:text-neutral-200"
                      numberOfLines={1}
                    >
                      {projectName ?? title}
                    </Text>
                    <ChevronDown size={14} className="text-neutral-500" />
                  </Pressable>
                ) : (
                  <Text className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
                    {title}
                  </Text>
                )}
                <View className="flex-row items-center gap-1">
                  {(onArchive || onDelete || onDuplicate || onSkip) && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("task.actions", "Task actions")}
                      onPress={() => setShowActionsMenu(true)}
                      hitSlop={8}
                      className="rounded-full bg-neutral-100 p-2 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
                    >
                      <Ellipsis size={20} className="text-neutral-700 dark:text-neutral-300" />
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("common.close")}
                    onPress={handleNativeDismiss}
                    hitSlop={12}
                    className="rounded-full bg-neutral-100 p-2 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
                  >
                    <X size={20} className="text-neutral-700 dark:text-neutral-300" />
                  </Pressable>
                </View>
              </View>
            </View>
          </GestureDetector>

          <SheetScrollContext.Provider
            value={{ scrollHandler, composedGesture, scrollAnimatedProps }}
          >
            <View style={{ flex: 1 }}>{children}</View>
          </SheetScrollContext.Provider>
        </View>
      </Animated.View>

      {confirmDialog}
      {actionsModal}
    </View>
  );
}
