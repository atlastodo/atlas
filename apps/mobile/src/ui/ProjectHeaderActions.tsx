import { useRef, useState } from "react";
import { Pressable, View, type GestureResponderEvent, type ViewInstance } from "react-native";
import { useTranslation } from "react-i18next";
import { useIsWide } from "../hooks/useIsWide";
import { useSelection } from "../data/SelectionProvider";
import type { ListPref } from "../hooks/usePreferences";
import type { MenuPos } from "../hooks/useContextMenu";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ListPrefMenu, ListPrefSheet } from "./ListPrefMenu";
import { Segmented } from "./Segmented";
import { SelectButton } from "./SelectButton";
import { StyleEditButton } from "./StyleEditor";
import {
  EllipsisVertical,
  Kanban,
  ListChecks,
  ListFilter,
  ListTodo,
  SlidersHorizontal,
  Star,
  UserPlus,
} from "./icons";

/**
 * How the header lays out its actions: "inline" shows each one, "menu" keeps the List|Board switch
 * and folds the rest into an overflow, and "menu-compact" also shrinks the switch to icons.
 */
export type HeaderLayout = "inline" | "menu" | "menu-compact";

/** Below this pane width the inline actions (~360px) would crowd the project title. */
const INLINE_MIN_WIDTH = 640;
/** Below this the labelled List|Board switch (~130px) would truncate the title to a few letters. */
const COMPACT_MAX_WIDTH = 400;

/** The header layout for a content pane `width` wide (the pane, not the window: a sidebar may take the rest). */
export function headerLayoutFor(width: number): HeaderLayout {
  if (width >= INLINE_MIN_WIDTH) return "inline";
  return width < COMPACT_MAX_WIDTH ? "menu-compact" : "menu";
}

/**
 * A project's actions, rendered as the nav header's `headerRight` so the list and board keep their
 * full height. A wide pane shows every action inline, with the List|Board switch at the far right.
 * A narrow one keeps only the switch and folds the rest into an overflow menu, opened right-aligned
 * under its trigger. Both layouts use the same labels. Presentational: the screen owns what each
 * action does.
 */
export interface ProjectHeaderActionsProps {
  mode: "list" | "board";
  onSetMode: (mode: "list" | "board") => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onEdit: () => void;
  /** Absent when the project cannot be shared (local-only mode): the action is not offered. */
  onShare?: () => void;
  /** Whether Select is offered: the list has tasks and is not already selecting. Never on the board. */
  canSelect: boolean;
  listPref?: ListPref;
  onChangeListPref?: (patch: Partial<ListPref>) => void;
  accentColor?: string;
  /** From the screen's measured width ({@link headerLayoutFor}). Until it is measured, the window decides. */
  layout?: HeaderLayout;
}

export function ProjectHeaderActions({
  mode,
  onSetMode,
  isFavorite,
  onToggleFavorite,
  onEdit,
  onShare,
  canSelect,
  listPref,
  onChangeListPref,
  accentColor,
  layout: layoutProp,
}: ProjectHeaderActionsProps) {
  const { t } = useTranslation();
  const isWide = useIsWide();
  const selection = useSelection();
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const [arranging, setArranging] = useState(false);
  const triggerRef = useRef<ViewInstance>(null);
  const layout = layoutProp ?? (isWide ? "inline" : "menu");

  // The menu hangs right-aligned under the ⋮, so it covers the list rather than the title and switch.
  // Opens at the press point at once, then moves to the measured trigger (the menu stays hidden
  // until its own first layout, so the hop doesn't show).
  const openMenu = (e?: GestureResponderEvent) => {
    setMenuPos({ x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 });
    triggerRef.current?.measureInWindow?.((x, y, width, height) =>
      setMenuPos({ x: x + width, y: y + height + 4 }),
    );
  };

  const favoriteLabel = isFavorite
    ? t("workspace.unfavorite", "Remove from favorites")
    : t("workspace.favorite", "Favorite");

  const modeSwitch = (
    <Segmented
      value={mode}
      options={[
        { value: "list", label: t("board.viewList"), icon: ListTodo },
        { value: "board", label: t("board.viewBoard"), icon: Kanban },
      ]}
      onChange={onSetMode}
      label={t("board.viewMode")}
      accentColor={accentColor}
      iconOnly={layout === "menu-compact"}
    />
  );

  if (layout === "inline") {
    return (
      <View className="shrink-0 flex-row items-center gap-2 pr-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={favoriteLabel}
          onPress={onToggleFavorite}
          hitSlop={8}
          className="p-1 web:cursor-pointer"
        >
          <Star
            size={18}
            className={isFavorite ? "text-amber-500 fill-amber-500" : "text-neutral-500"}
          />
        </Pressable>
        <StyleEditButton label={t("workspace.editProject")} onPress={onEdit} />
        {onShare && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("workspace.shareProject")}
            onPress={onShare}
            hitSlop={8}
            className="p-1 web:cursor-pointer"
          >
            <UserPlus size={18} className="text-neutral-500" />
          </Pressable>
        )}
        {canSelect && <SelectButton />}
        {listPref && onChangeListPref && (
          <ListPrefMenu value={listPref} onChange={onChangeListPref} />
        )}
        {modeSwitch}
      </View>
    );
  }

  const items: ContextMenuItem[] = [
    { key: "favorite", label: favoriteLabel, icon: Star, onPress: onToggleFavorite },
    { key: "edit", label: t("workspace.editProject"), icon: SlidersHorizontal, onPress: onEdit },
    ...(onShare
      ? [{ key: "share", label: t("workspace.shareProject"), icon: UserPlus, onPress: onShare }]
      : []),
    ...(canSelect
      ? [
          {
            key: "select",
            label: t("selection.select"),
            icon: ListChecks,
            onPress: () => selection.enter(),
          },
        ]
      : []),
    ...(listPref && onChangeListPref
      ? [
          {
            key: "arrange",
            label: t("workspace.listOptions"),
            icon: ListFilter,
            onPress: () => setArranging(true),
          },
        ]
      : []),
  ];

  return (
    <View className="shrink-0 flex-row items-center gap-1 pr-2">
      {modeSwitch}
      <Pressable
        ref={triggerRef}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.projectActions")}
        onPress={openMenu}
        hitSlop={4}
        className="h-11 w-11 items-center justify-center rounded-full web:cursor-pointer active:bg-neutral-100 dark:active:bg-neutral-800"
      >
        <EllipsisVertical size={20} className="text-neutral-500" />
      </Pressable>
      {menuPos && (
        <ContextMenu items={items} pos={menuPos} align="right" onClose={() => setMenuPos(null)} />
      )}
      {listPref && onChangeListPref && (
        <ListPrefSheet
          visible={arranging}
          onClose={() => setArranging(false)}
          value={listPref}
          onChange={onChangeListPref}
        />
      )}
    </View>
  );
}
