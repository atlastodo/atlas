import { useEffect, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useContextMenu, type MenuPos } from "../hooks/useContextMenu";
import { ChevronDown, ChevronRight, EllipsisVertical, Pencil } from "./icons";
import { haptics } from "../lib/haptics";
import { useCancelOnEscape } from "../hooks/useCancelOnEscape";

/**
 * The section rows for the flattened, drag-reorderable project list ({@link ProjectTaskList}): a
 * collapsible section header (inline rename and a long-press actions menu, both driven by the
 * parent) and the header of the unsectioned group.
 */

export interface SectionHeaderRowProps {
  name: string;
  count: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  onRename: (name: string) => void;
  onOpenActions: (pos: MenuPos) => void;
}

export function SectionHeaderRow({
  name,
  count,
  collapsed,
  onToggleCollapsed,
  editing,
  onStartEdit,
  onEndEdit,
  onRename,
  onOpenActions,
}: SectionHeaderRowProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(name);
  const isWeb = Platform.OS === "web";
  useEffect(() => {
    if (editing) setDraft(name);
  }, [editing, name]);
  // Web right-click opens the section menu; no-op on native.
  const contextRef = useContextMenu((pos) => onOpenActions(pos));

  const commit = () => {
    if (escapeRename.consume()) return;
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    onEndEdit();
  };
  // Escape abandons the rename without writing; the blur it causes must not commit (hence `consume`).
  const escapeRename = useCancelOnEscape(() => {
    setDraft(name);
    onEndEdit();
  });

  return (
    <View
      ref={contextRef}
      className="flex-row items-center gap-1 bg-white px-3 pb-1 pt-4 dark:bg-zinc-950"
    >
      {editing ? (
        <>
          <ChevronDown size={16} className="text-neutral-500" />
          <TextInput
            ref={escapeRename.ref}
            autoFocus
            accessibilityLabel={t("board.renameSection", { name })}
            value={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            onKeyPress={escapeRename.onKeyPress}
            returnKeyType="done"
            className={
              "min-w-0 flex-1 rounded bg-neutral-100 px-2 py-1 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100 " +
              (isWeb ? "text-sm" : "text-lg")
            }
          />
        </>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: !collapsed }}
            accessibilityLabel={t("board.toggleSection", { name })}
            onPress={onToggleCollapsed}
            onLongPress={(e) => {
              haptics.impact("medium");
              onOpenActions({ x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 });
            }}
            className="min-w-0 flex-1 flex-row items-center gap-1.5"
          >
            {collapsed ? (
              <ChevronRight size={16} className="text-neutral-500" />
            ) : (
              <ChevronDown size={16} className="text-neutral-500" />
            )}
            <Text
              numberOfLines={1}
              className={
                "shrink font-medium uppercase text-neutral-500 " +
                (isWeb ? "text-xs" : "text-sm font-semibold")
              }
            >
              {name}
            </Text>
            <Text className={isWeb ? "text-xs text-neutral-500" : "text-sm text-neutral-500"}>
              {count}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("board.renameSection", { name })}
            onPress={onStartEdit}
            hitSlop={8}
            className="p-1 web:cursor-pointer"
          >
            <Pencil size={isWeb ? 14 : 16} className="text-neutral-500" />
          </Pressable>
          {/* A visible 3-dots button opens the full section menu (rename/duplicate/select/move/
              archive/delete) -- the long-press is undiscoverable and has no mouse equivalent. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("board.sectionActions", { name })}
            onPress={(e) =>
              onOpenActions({ x: e?.nativeEvent?.pageX ?? 0, y: e?.nativeEvent?.pageY ?? 0 })
            }
            hitSlop={8}
            className="p-1 web:cursor-pointer"
          >
            <EllipsisVertical size={isWeb ? 16 : 18} className="text-neutral-500" />
          </Pressable>
        </>
      )}
    </View>
  );
}

/** The "No section" drop-zone header: a plain label (no collapse / rename / actions). */
export function NoSectionHeaderRow({ count }: { count: number }) {
  const { t } = useTranslation();
  const isWeb = Platform.OS === "web";
  return (
    <View className="flex-row items-center gap-1.5 bg-white px-3 pb-1 pt-4 dark:bg-zinc-950">
      <Text
        className={
          "font-medium uppercase text-neutral-500 " + (isWeb ? "text-xs" : "text-sm font-semibold")
        }
      >
        {t("board.noSection")}
      </Text>
      <Text className={isWeb ? "text-xs text-neutral-500" : "text-sm text-neutral-500"}>
        {count}
      </Text>
    </View>
  );
}
