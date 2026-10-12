import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, X } from "./icons";
import type { SidebarItem, SidebarSection } from "./AppDrawerContent";
import type { ContextMenuItem } from "./ContextMenu";
import { ThemeScope } from "../theme/ThemeProvider";
import { haptics } from "../lib/haptics";
import { useSheetDismiss, WEB_OVERLAY_STYLE } from "./useSheetDismiss";

export interface MobileMenuModalProps {
  visible: boolean;
  onClose: () => void;
  sections: SidebarSection[];
  activeHref: string | null;
  onNavigate: (href: string) => void;
  brand?: string;
  statusSlot?: ReactNode;
}

/**
 * Mobile-optimized menu popup modal that presents all routes, projects,
 * filters, and settings in a spacious touch-friendly sheet designed for phones.
 */
export function MobileMenuModal({
  visible,
  onClose,
  sections,
  activeHref,
  onNavigate,
  brand = "Atlas Todo",
  statusSlot,
}: MobileMenuModalProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const {
    isWeb,
    dismiss,
    animatedStyle,
    headerPanGesture,
    scrollHandler,
    composedGesture,
    scrollAnimatedProps,
  } = useSheetDismiss(onClose, visible);

  const handleItemPress = (item: SidebarItem) => {
    if (item.onToggle) {
      haptics.selection();
      item.onToggle();
    } else if (item.href !== null) {
      haptics.impact("light");
      onClose();
      onNavigate(item.href);
    }
  };

  // Action sheet state for long-pressed menu items
  const [activeMenu, setActiveMenu] = useState<{ title: string; items: ContextMenuItem[] } | null>(
    null,
  );

  // Section title mapping
  const sectionTitle = (key: string): string => {
    switch (key) {
      case "smart":
        return t("nav.smartLists", "Smart lists");
      case "favorites":
        return t("nav.favorites", "Favorites");
      case "utility":
        return t("nav.viewsAndTools", "Views & Tools");
      case "projects":
        return t("nav.projects", "Projects");
      case "filters":
        return t("nav.filters", "Filters");
      case "history":
        return t("nav.historyAndTrash", "History & Trash");
      case "settings":
        return t("common.settings", "Settings");
      default:
        return "";
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <ThemeScope
          className="flex-1 justify-end bg-black/60"
          style={isWeb ? WEB_OVERLAY_STYLE : undefined}
        >
          {/* Backdrop */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close", "Close")}
            onPress={dismiss}
            style={StyleSheet.absoluteFill}
          />

          {/* Bottom Sheet Container */}
          <Animated.View
            style={[{ width: "100%", height: "85%", maxHeight: "90%" }, animatedStyle]}
          >
            {/* The surface is a plain View: NativeWind ignores `className` on Reanimated's
                Animated.View, which left the sheet without a background or padding. */}
            <View
              style={{ flex: 1, paddingBottom: Math.max(insets.bottom, 16) }}
              className="w-full flex-col rounded-t-3xl border-t border-neutral-200 bg-white px-5 pt-3 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
            >
              {/* Drag Handle & Header */}
              <GestureDetector gesture={headerPanGesture}>
                <View className="pb-1">
                  {/* Drag Handle */}
                  {!isWeb && (
                    <View className="mb-2 items-center bg-transparent py-1">
                      <View className="h-1.5 w-12 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                    </View>
                  )}

                  {/* Header */}
                  <View className="flex-row items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
                    <View className="flex-row items-center gap-2.5 shrink min-w-0">
                      <Text className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 shrink-0">
                        {brand}
                      </Text>
                      {statusSlot}
                    </View>

                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t("common.close", "Close")}
                      onPress={dismiss}
                      hitSlop={12}
                      className="rounded-full bg-neutral-100 p-2 shrink-0 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
                    >
                      <X size={22} className="text-neutral-700 dark:text-neutral-300" />
                    </Pressable>
                  </View>
                </View>
              </GestureDetector>

              {/* Menu Items List */}
              <GestureDetector gesture={composedGesture}>
                <Animated.ScrollView
                  showsVerticalScrollIndicator={false}
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingTop: 12, paddingBottom: 48 }}
                  keyboardShouldPersistTaps="handled"
                  scrollEventThrottle={16}
                  onScroll={scrollHandler}
                  animatedProps={scrollAnimatedProps}
                >
                  {sections.map((section, idx) => {
                    const title = sectionTitle(section.key);
                    if (section.items.length === 0) return null;

                    return (
                      <View key={section.key || idx} className="mb-4">
                        {title !== "" && (
                          <Text className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                            {title}
                          </Text>
                        )}
                        <View className="gap-1.5">
                          {section.items.map((item) => {
                            const isActive = item.href != null && activeHref === item.href;
                            const Icon = item.icon;
                            const Chevron = item.expanded ? ChevronDown : ChevronRight;

                            return (
                              <Pressable
                                key={item.key}
                                accessibilityRole="button"
                                accessibilityState={{
                                  selected: isActive,
                                  expanded: item.expanded,
                                }}
                                accessibilityLabel={item.label}
                                onPress={() => handleItemPress(item)}
                                onLongPress={() => {
                                  if (item.menuItems && item.menuItems.length > 0) {
                                    haptics.impact("medium");
                                    setActiveMenu({ title: item.label, items: item.menuItems });
                                  }
                                }}
                                delayLongPress={350}
                                className={
                                  "flex-row items-center justify-between rounded-2xl p-4 " +
                                  (isActive
                                    ? "border border-accent-600 bg-accent-50 dark:bg-accent-950"
                                    : "border border-neutral-200 bg-neutral-50/40 active:bg-neutral-100 dark:border-neutral-800/80 dark:bg-neutral-800/20 dark:active:bg-neutral-800")
                                }
                              >
                                <View className="flex-1 flex-row items-center gap-3.5">
                                  {/* Tree depth indentation for nested projects */}
                                  {(item.depth ?? 0) > 0 && (
                                    <View style={{ width: (item.depth ?? 0) * 14 }} />
                                  )}
                                  <Icon
                                    size={24}
                                    color={item.tint}
                                    className={
                                      item.tint
                                        ? undefined
                                        : isActive
                                          ? "text-accent-600 dark:text-accent-400"
                                          : "text-neutral-500 dark:text-neutral-400"
                                    }
                                  />
                                  <Text
                                    numberOfLines={1}
                                    className={
                                      "flex-1 text-lg " +
                                      (isActive
                                        ? "font-bold text-accent-600 dark:text-accent-400"
                                        : "font-medium text-neutral-800 dark:text-neutral-200")
                                    }
                                  >
                                    {item.label}
                                  </Text>
                                </View>

                                <View className="flex-row items-center gap-2">
                                  {/* Notification badge */}
                                  {item.badge != null && item.badge > 0 && (
                                    <View className="rounded-full bg-accent-600 px-2 py-0.5">
                                      <Text className="text-xs font-bold text-white">
                                        {item.badge}
                                      </Text>
                                    </View>
                                  )}

                                  {/* Folder expand/collapse or chevron */}
                                  {item.onToggle ? (
                                    <Chevron size={20} className="text-neutral-500" />
                                  ) : null}
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                </Animated.ScrollView>
              </GestureDetector>
            </View>
          </Animated.View>

          {/* Quick Action Modal for Long-Pressed Item */}
          {activeMenu != null && (
            <Modal
              visible={true}
              transparent
              animationType="fade"
              onRequestClose={() => setActiveMenu(null)}
              statusBarTranslucent
            >
              <ThemeScope className="flex-1 justify-end bg-black/60">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("common.close", "Close")}
                  onPress={() => setActiveMenu(null)}
                  style={StyleSheet.absoluteFill}
                />
                <View
                  style={{ paddingBottom: Math.max(insets.bottom, 20) }}
                  className="w-full rounded-t-3xl border-t border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <View className="mb-3 items-center">
                    <View className="h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                  </View>
                  <Text className="mb-4 text-center text-lg font-bold text-neutral-900 dark:text-neutral-100">
                    {activeMenu.title}
                  </Text>
                  <View className="gap-2">
                    {activeMenu.items.map((menuItem) => {
                      const MenuIcon = menuItem.icon;
                      return (
                        <Pressable
                          key={menuItem.key}
                          accessibilityRole="button"
                          accessibilityLabel={menuItem.label}
                          onPress={() => {
                            setActiveMenu(null);
                            menuItem.onPress();
                          }}
                          className={
                            "flex-row items-center gap-3.5 rounded-xl p-3.5 " +
                            (menuItem.danger
                              ? "bg-red-50/50 active:bg-red-100 dark:bg-red-950/30 dark:active:bg-red-900/50"
                              : "bg-neutral-100/60 active:bg-neutral-200 dark:bg-neutral-800/50 dark:active:bg-neutral-800")
                          }
                        >
                          {MenuIcon && (
                            <MenuIcon
                              size={20}
                              className={
                                menuItem.danger
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-neutral-700 dark:text-neutral-300"
                              }
                            />
                          )}
                          <Text
                            className={
                              "text-base font-semibold " +
                              (menuItem.danger
                                ? "text-red-600 dark:text-red-400"
                                : "text-neutral-900 dark:text-neutral-100")
                            }
                          >
                            {menuItem.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </ThemeScope>
            </Modal>
          )}
        </ThemeScope>
      </GestureHandlerRootView>
    </Modal>
  );
}
