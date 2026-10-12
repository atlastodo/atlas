import { useEffect, useRef, type ReactNode } from "react";
import { Modal, Platform, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ThemeScope } from "../theme/ThemeProvider";
import { haptics } from "../lib/haptics";
import { ELEVATED_SURFACE_CLASS, SCRIM_CLASS } from "./useSheetDismiss";

/**
 * A centred cross-platform confirm dialog, for the few actions that are not locally reversible
 * (the app otherwise prefers undo toasts). A plain `Modal`, since `Alert.alert` is unreliable under
 * react-native-web. `children` render between the message and the buttons, for a detail that must
 * be typed (the delete-account dialog's password).
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel,
  saveLabel,
  danger,
  confirmDisabled,
  onConfirm,
  onCancel,
  onSave,
  children,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  saveLabel?: string;
  danger?: boolean;
  /** Greys out and disables the confirm button, e.g. while the confirmation is being checked. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSave?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const cancel = cancelLabel ?? t("common.cancel");

  useEffect(() => {
    if (!visible) return;
    if (danger) haptics.warning();
    else haptics.selection();
  }, [visible, danger]);

  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Web: focus moves into the dialog so the field underneath keeps no caret or Escape. Escape
  // cancels on a capture-phase listener so it wins over earlier handlers (e.g. TaskDetailWebFrame
  // closing the screen). Native asks via the Modal's back button.
  const dialogRef = useRef<View>(null);
  useEffect(() => {
    if (!visible || Platform.OS !== "web") return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const raf = requestAnimationFrame(() => {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      const el = dialogRef.current as unknown as {
        focus?: () => void;
        contains?: (node: unknown) => boolean;
      } | null;
      if (el && typeof el.focus === "function") {
        const containsActive =
          typeof el.contains === "function" && active ? el.contains(active) : false;
        if (!containsActive) {
          el.focus();
        }
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <ThemeScope className="absolute inset-0 items-center justify-center p-6">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={onCancel}
          className={`absolute inset-0 ${SCRIM_CLASS}`}
        />
        <View
          ref={dialogRef}
          {...({ tabIndex: -1 } as object)}
          className={`w-full max-w-sm gap-3 rounded-2xl p-5 outline-none ${ELEVATED_SURFACE_CLASS}`}
        >
          <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {title}
          </Text>
          {message ? (
            <Text className="text-sm text-neutral-600 dark:text-neutral-300">{message}</Text>
          ) : null}
          {children}
          <View className="mt-2 flex-row justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cancel}
              onPress={onCancel}
              className="rounded-md px-4 py-2 web:cursor-pointer"
            >
              <Text className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
                {cancel}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityState={{ disabled: !!confirmDisabled }}
              disabled={confirmDisabled}
              onPress={onConfirm}
              className={
                "rounded-md px-4 py-2 web:cursor-pointer " +
                (danger ? "bg-red-600" : "bg-accent-600") +
                (confirmDisabled ? " opacity-60" : "")
              }
            >
              <Text className="text-sm font-semibold text-white">{confirmLabel}</Text>
            </Pressable>
            {saveLabel && onSave ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={saveLabel}
                onPress={onSave}
                className="rounded-md bg-accent-600 px-4 py-2 web:cursor-pointer"
              >
                <Text className="text-sm font-semibold text-white">{saveLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </ThemeScope>
    </Modal>
  );
}
