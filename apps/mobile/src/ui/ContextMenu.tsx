import { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Check, type LucideIcon } from "./icons";
import type { MenuPos } from "../hooks/useContextMenu";
import { clampMenuPosition, type Size } from "../lib/menuPosition";
import { useBackdropSwitch } from "../hooks/useBackdropSwitch";
import { ThemeScope } from "../theme/ThemeProvider";
import { useIsWide } from "../hooks/useIsWide";

/**
 * A generic context menu over a full-screen backdrop (Escape closes too): at the cursor for a
 * right-click, or right-aligned under a ⋮ trigger (`align="right"`). Drives the data-driven sidebar
 * menus and the section/project ⋮ menus; `TaskContextMenu` is separate.
 *
 * The overlay is a `Modal`: a transformed ancestor turns an inline `position: fixed` into a
 * relative box, so an outside press beside the sidebar missed. A Modal portals to the document root.
 */

/**
 * The menu panel's surface, shared with `TaskContextMenu`. Dark mode lifts it a step above the page
 * (neutral-900 on zinc-950, a lighter border, a dark shadow): a plain shadow vanishes on black.
 */
export const MENU_SURFACE =
  "overflow-hidden rounded-md border border-neutral-200 bg-white p-1.5 shadow-xl dark:border-neutral-700 dark:bg-neutral-900 dark:shadow-black/60";

export interface ContextMenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  items: ContextMenuItem[];
  pos: MenuPos;
  onClose: () => void;
  /**
   * Which menu edge sits at `pos.x`: "left" (the default) opens rightward from a cursor; "right"
   * right-aligns it under a trigger at the end of a header, so it doesn't cover what's beside it.
   */
  align?: "left" | "right";
}

export function ContextMenu({ items, pos, onClose, align = "left" }: ContextMenuProps) {
  const { t } = useTranslation();
  const { width, height } = useWindowDimensions();

  // Guarded on a real DOM `window`: jest/native may expose a partial one without `addEventListener`.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Positioned against the measured menu size: placed invisibly at the cursor until the first `onLayout`, then revealed clamped.
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height });
  const anchor = size && align === "right" ? { x: pos.x - size.width, y: pos.y } : pos;
  const placed = size ? clampMenuPosition(anchor, size, { width, height }) : pos;
  // On web a right-click on the backdrop routes to the element beneath, so another row's menu opens instead of the browser's.
  const backdropRef = useBackdropSwitch(onClose);

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <ThemeScope className="flex-1">
        <Pressable
          ref={backdropRef}
          accessibilityLabel={t("common.close")}
          onPress={onClose}
          className="absolute inset-0"
        />
        <View
          accessibilityLabel={t("context.actions")}
          onLayout={onLayout}
          style={{
            position: "absolute",
            left: placed.x,
            top: placed.y,
            maxHeight: height - 8,
            opacity: size ? 1 : 0,
          }}
          className={"w-56 " + MENU_SURFACE}
        >
          <ScrollView showsVerticalScrollIndicator={false}>
            {items.map((item) => {
              return (
                <View key={item.key}>
                  {item.separatorBefore && (
                    <View className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
                  )}
                  <MenuItem
                    icon={item.icon}
                    label={item.label}
                    danger={item.danger}
                    onPress={item.onPress}
                    onClose={onClose}
                  />
                </View>
              );
            })}
          </ScrollView>
        </View>
      </ThemeScope>
    </Modal>
  );
}

/** Touch (native, or a phone-width browser) gets 44px menu rows; a desktop pointer keeps compact ones. */
export function useTouchMenu(): boolean {
  const isWide = useIsWide();
  return Platform.OS !== "web" || !isWide;
}

/** The current value in a menu: a soft accent fill, no ring. Shared by rows and the priority chips. */
export const MENU_SELECTED_CLASS = "bg-accent-50 dark:bg-accent-950/70";
export const MENU_SELECTED_TEXT_CLASS = "font-semibold text-accent-700 dark:text-accent-200";

/**
 * One menu row: runs `onPress`, then closes the menu. Shared with `TaskContextMenu`. `shortcut` is a
 * right-aligned key hint for the same action. `selected` marks the row as the current value (the
 * task's due date) with the selected fill and a check.
 */
export function MenuItem({
  icon: Icon,
  label,
  danger,
  shortcut,
  selected = false,
  onPress,
  onClose,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  shortcut?: string;
  selected?: boolean;
  onPress: () => void;
  onClose: () => void;
}) {
  const touch = useTouchMenu();
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityState={selected ? { selected } : undefined}
      onPress={() => {
        onPress();
        onClose();
      }}
      className={
        "flex-row items-center gap-2 rounded px-2 web:cursor-pointer " +
        (selected
          ? MENU_SELECTED_CLASS + " "
          : "web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800 ") +
        (touch ? "min-h-[44px] py-2.5" : "py-1.5")
      }
    >
      <Icon
        size={16}
        className={
          danger
            ? "text-red-500"
            : selected
              ? "text-accent-600 dark:text-accent-300"
              : "text-neutral-500"
        }
      />
      <Text
        className={
          "flex-1 " +
          (touch ? "text-base " : "text-sm ") +
          (danger
            ? "text-red-500"
            : selected
              ? MENU_SELECTED_TEXT_CLASS
              : "text-neutral-700 dark:text-neutral-200")
        }
      >
        {label}
      </Text>
      {selected && <Check size={16} className="text-accent-600 dark:text-accent-300" />}
      {shortcut != null && <ShortcutHint keys={shortcut} />}
    </Pressable>
  );
}

/** A right-aligned key hint on a menu row or heading. Hidden from screen readers: it repeats the hotkey help. */
export function ShortcutHint({ keys }: { keys: string }) {
  return (
    <Text aria-hidden className="text-xs text-neutral-500 dark:text-neutral-400">
      {keys}
    </Text>
  );
}
