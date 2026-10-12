import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronDown, ChevronRight, Globe, type LucideIcon } from "./icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { useHoverTooltip } from "./HoverTooltip";

/**
 * The app's navigation list. On a phone it is the slide-in drawer's body; on a wide viewport the
 * drawer is `permanent` and it is the persistent sidebar. Presentational and router-free: the
 * `(drawer)` layout builds sections from `navModel` and passes `onNavigate`, so it is testable
 * without expo-router. Rows may carry `menuItems`, opened by right-click (web only).
 */
export interface SidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The expo-router path this row navigates to, or `null` for a container row (a folder header). */
  href: string | null;
  badge?: number;
  tint?: string;
  depth?: number;
  expanded?: boolean;
  onToggle?: () => void;
  /** When set, pressing the row runs this instead of `onNavigate(href)`: an action rather than a destination. */
  onPress?: () => void;
  menuItems?: ContextMenuItem[];
}

export interface SidebarSection {
  key: string;
  items: SidebarItem[];
}

export interface AppDrawerContentProps {
  sections: SidebarSection[];
  activeHref: string | null;
  onNavigate: (href: string) => void;
  brand: string;
  onBrandPress?: () => void;
  statusSlot?: ReactNode;
  action?: ReactNode;
  collapsed?: boolean;
}

/** One navigation row; its own component so `useContextMenu` is one hook per row. */
function SidebarRow({
  item,
  active,
  collapsed,
  onNavigate,
  onOpenMenu,
}: {
  item: SidebarItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: (href: string) => void;
  onOpenMenu: (item: SidebarItem, pos: MenuPos) => void;
}) {
  const ref = useContextMenu((pos) => item.menuItems && onOpenMenu(item, pos));
  const [hovered, setHovered] = useState(false);
  const tip = useHoverTooltip(item.label);
  const Icon = item.icon;
  const iconEl = item.tint ? (
    <Icon size={20} color={item.tint} />
  ) : (
    <Icon size={20} className={active ? "text-accent-600" : "text-neutral-500"} />
  );
  const press = () => {
    if (item.onToggle) item.onToggle();
    else if (item.onPress) item.onPress();
    else if (item.href !== null) onNavigate(item.href);
  };
  const Chevron = item.expanded ? ChevronDown : ChevronRight;

  if (collapsed) {
    // Rail mode: an icon-only square; the label is carried by accessibility and a web hover tooltip
    // (a fixed overlay escapes the rail ScrollView's clipping).
    return (
      <Pressable
        ref={ref}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={item.label}
        onPress={press}
        onHoverIn={tip.onHoverIn}
        onHoverOut={tip.onHoverOut}
        className={`mx-2 my-0.5 items-center justify-center rounded-lg py-2.5 web:cursor-pointer ${
          active
            ? "bg-neutral-100 dark:bg-neutral-800"
            : "web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
        }`}
      >
        {iconEl}
        {item.badge != null && item.badge > 0 && (
          <View className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-accent-600" />
        )}
        {tip.tooltip}
      </Pressable>
    );
  }
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityState={{ selected: active, expanded: item.expanded }}
      accessibilityLabel={item.label}
      onPress={press}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      // `web:` scopes pointer affordances to the browser. The active row uses a neutral highlight so the label stays legible.
      className={`mx-2 flex-row items-center gap-3 rounded-lg px-3 py-2.5 web:cursor-pointer web:focus-visible:outline web:focus-visible:outline-2 web:focus-visible:outline-accent-500 ${
        active
          ? "bg-neutral-100 dark:bg-neutral-800"
          : "web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
      }`}
    >
      {/* Indent as a leading spacer, not padding, so the row stays one contiguous touch target. */}
      {(item.depth ?? 0) > 0 && <View style={{ width: (item.depth ?? 0) * 14 }} />}
      {iconEl}
      <Text
        className={`flex-1 text-sm ${
          active
            ? "font-semibold text-accent-700 dark:text-accent-300"
            : "text-neutral-700 dark:text-neutral-200"
        }`}
      >
        {item.label}
      </Text>
      {item.badge != null && item.badge > 0 && (
        <View className="min-w-[20px] items-center rounded-full bg-accent-600 px-1.5 py-0.5">
          <Text className="text-xs font-semibold text-white">{item.badge}</Text>
        </View>
      )}
      {/* Web shows the folder chevron on hover only; native has no hover, so it always shows. */}
      {item.expanded !== undefined && (hovered || Platform.OS !== "web") && (
        <Chevron size={16} className="text-neutral-500" />
      )}
    </Pressable>
  );
}

export function AppDrawerContent({
  sections,
  activeHref,
  onNavigate,
  brand,
  onBrandPress,
  statusSlot,
  action,
  collapsed = false,
}: AppDrawerContentProps) {
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState<{ items: ContextMenuItem[]; pos: MenuPos } | null>(null);
  const brandTip = useHoverTooltip(brand);
  return (
    <ScrollView
      className="flex-1 bg-white dark:bg-neutral-950"
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }}
    >
      {collapsed ? (
        <View className="items-center gap-1 pb-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={brand}
            onPress={onBrandPress}
            onHoverIn={brandTip.onHoverIn}
            onHoverOut={brandTip.onHoverOut}
            disabled={!onBrandPress}
            className="rounded-lg p-2 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
          >
            <Globe size={20} className="text-accent-600" />
            {brandTip.tooltip}
          </Pressable>
          {action}
        </View>
      ) : (
        <View className="flex-row items-center justify-between px-4 pb-3">
          {/* No flex `gap` between icon and text: react-native-web does not count it as part of a child, so a click in the gap missed the press. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={brand}
            onPress={onBrandPress}
            disabled={!onBrandPress}
            className="-mx-1 flex-row items-center rounded-lg px-1 py-1 shrink-0 web:cursor-pointer web:hover:bg-neutral-100 dark:web:hover:bg-neutral-900"
          >
            <Globe size={20} className="text-accent-600" />
            <Text className="pl-2 text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {brand}
            </Text>
          </Pressable>
          <View className="flex-row items-center gap-2 shrink min-w-0">
            {statusSlot}
            {action}
          </View>
        </View>
      )}
      {sections.map((section, index) => (
        <View
          key={section.key}
          className={
            index > 0 ? "mt-2 border-t border-neutral-100 pt-2 dark:border-neutral-800" : undefined
          }
        >
          {section.items.map((item) => (
            <SidebarRow
              key={item.key}
              item={item}
              active={item.href !== null && item.href === activeHref}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onOpenMenu={(it, pos) => it.menuItems && setMenu({ items: it.menuItems, pos })}
            />
          ))}
        </View>
      ))}
      {menu && <ContextMenu items={menu.items} pos={menu.pos} onClose={() => setMenu(null)} />}
    </ScrollView>
  );
}
