import { useState, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { BottomSheet } from "./BottomSheet";
import { SheetScrollView } from "./SheetScroll";
import { StylePicker } from "./StylePicker";
import { SlidersHorizontal, Star, X, type LucideIcon } from "./icons";

/**
 * The rename + icon + colour editor shared by projects and saved filters. Both carry the same
 * name/icon/color from the same palette, so the editor is one component; a project just supplies an
 * extra `footer` (duplicate / archive / delete) that a filter does not.
 *
 * A bottom sheet, because the icon grid needs room a popover can't give on a phone. The name is
 * buffered and committed on close, so a rename is one write rather than one per keystroke.
 */
export interface StyleEditorProps {
  /** Whether the editor is open (its subject is non-null). */
  open: boolean;
  /** The subject's current name (re-seeds the buffered field each time the editor opens). */
  name: string;
  nameLabel: string;
  iconLabel: string;
  colorLabel: string;
  /** The subject's current icon name (marks its grid cell), or undefined for none. */
  selectedIcon: string | undefined;
  /** The subject's default icon; leads the grid so the type's default reads first. */
  defaultIcon: string;
  /** The subject's resolved colour hex (marks its swatch). */
  selectedColor: string;
  onRename: (name: string) => void;
  onSetIcon: (icon: string) => void;
  onSetColor: (color: string) => void;
  onClose: () => void;
  /** Optional favorite toggle for the project or filter */
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  /** Extra content below the icon/colour picker (e.g. a project's "Show completed" toggle). */
  extra?: ReactNode;
  /** Footer actions; given `close` so a button can act then dismiss (committing the name first). */
  footer?: (close: () => void) => ReactNode;
}

export function StyleEditor({
  open,
  name,
  nameLabel,
  iconLabel,
  colorLabel,
  selectedIcon,
  defaultIcon,
  selectedColor,
  onRename,
  onSetIcon,
  onSetColor,
  onClose,
  isFavorite,
  onToggleFavorite,
  extra,
  footer,
}: StyleEditorProps) {
  const { t } = useTranslation();
  const [buffer, setBuffer] = useState(name);
  // Re-seed the buffered name on the closed->open edge, so it starts from the subject's current name.
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setBuffer(name);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const commitName = () => {
    const trimmed = buffer.trim();
    if (open && trimmed !== "" && trimmed !== name) onRename(trimmed);
  };

  const close = () => {
    commitName();
    onClose();
  };

  return (
    <BottomSheet visible={open} onClose={close}>
      <View className="gap-4">
        <View className="flex-row items-center gap-3 border-b border-neutral-100 pb-4 dark:border-neutral-800">
          <TextInput
            accessibilityLabel={nameLabel}
            value={buffer}
            onChangeText={setBuffer}
            onBlur={commitName}
            placeholder={nameLabel}
            placeholderTextColor="#737373"
            className="flex-1 text-lg font-semibold text-neutral-900 dark:text-neutral-100"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            onPress={close}
            hitSlop={8}
            className="rounded-full bg-neutral-100 p-1.5 active:bg-neutral-200 dark:bg-neutral-800 dark:active:bg-neutral-700"
          >
            <X size={18} className="text-neutral-600 dark:text-neutral-300" />
          </Pressable>
        </View>

        <SheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-5 py-1"
        >
          {onToggleFavorite && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isFavorite
                  ? t("workspace.unfavorite", "Remove from favorites")
                  : t("workspace.favorite", "Favorite")
              }
              onPress={onToggleFavorite}
              className="flex-row items-center justify-between rounded-xl border border-neutral-200 bg-neutral-50/70 p-3 active:bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/40 dark:active:bg-neutral-800/80"
            >
              <View className="flex-row items-center gap-2.5">
                <Star
                  size={18}
                  className={isFavorite ? "text-amber-500 fill-amber-500" : "text-neutral-500"}
                />
                <Text className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {t("nav.favorites", "Favorites")}
                </Text>
              </View>
              <Text
                className={
                  "text-xs font-semibold " +
                  (isFavorite ? "text-amber-600 dark:text-amber-400" : "text-neutral-500")
                }
              >
                {isFavorite ? t("common.added") : t("common.add")}
              </Text>
            </Pressable>
          )}

          <StylePicker
            iconLabel={iconLabel}
            colorLabel={colorLabel}
            selectedIcon={selectedIcon}
            defaultIcon={defaultIcon}
            selectedColor={selectedColor}
            onSetIcon={onSetIcon}
            onSetColor={onSetColor}
          />
          {extra}
        </SheetScrollView>

        {footer && (
          <View className="flex-row gap-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
            {footer(close)}
          </View>
        )}
      </View>
    </BottomSheet>
  );
}

/** A footer action button for the {@link StyleEditor} (e.g. a project's duplicate/archive/delete). */
export function StyleAction({
  icon: Icon,
  label,
  onPress,
  danger = false,
  accessibilityLabel,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  danger?: boolean;
  /** A more descriptive screen-reader label than the visible text (e.g. "Delete project"). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      className="flex-1 flex-row items-center justify-center gap-1.5 rounded-md border border-neutral-200 py-2.5 dark:border-neutral-800"
    >
      <Icon
        size={16}
        className={danger ? "text-red-500" : "text-neutral-600 dark:text-neutral-300"}
      />
      <Text
        className={
          "text-sm " + (danger ? "text-red-500" : "text-neutral-600 dark:text-neutral-300")
        }
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The gear button that opens a {@link StyleEditor}, shared by the project and filter screen headers. */
export function StyleEditButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      className="p-1 web:cursor-pointer"
    >
      <SlidersHorizontal size={18} className="text-neutral-500" />
    </Pressable>
  );
}
