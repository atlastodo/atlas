import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Task } from "@atlastodo/client-core";
import { filterActions, searchTasks, type TaskSearchHit } from "@atlastodo/shared";
import { ThemeScope } from "../theme/ThemeProvider";
import type { Command } from "../hooks/useCommands";
import type { TaskSearchSource } from "../hooks/useTaskSearch";
import { useListKeyboardNav } from "../hooks/useListKeyboardNav";
import { useIsWide } from "../hooks/useIsWide";
import { ELEVATED_SURFACE_CLASS, PLACEHOLDER_COLOR, SCRIM_CLASS } from "./useSheetDismiss";
import { Search } from "./icons";
import { displayTitle } from "../lib/taskTitle";

/**
 * The command palette: a search box over a fuzzy-filtered action list (`filterActions`). When the
 * query matches no destination but does match task text, it falls through to a task-results
 * section over the local store (`searchTasks` via `search`); a query matching a destination stays
 * navigation-only. The phone opens it from a header search button. Presentational: the container
 * supplies commands, the task source and callbacks, and handles navigation.
 */
export interface CommandPaletteProps {
  visible: boolean;
  onClose: () => void;
  commands: Command[];
  onSelect: (command: Command) => void;
  search?: TaskSearchSource;
  onSelectTask?: (task: Task) => void;
}

/** One row of the palette's single FlatList, homogeneous per query. */
type PaletteRow = { kind: "command"; command: Command } | { kind: "task"; hit: TaskSearchHit };

function rowClass(active: boolean): string {
  return `flex-row items-center justify-between px-3 py-3 web:cursor-pointer ${
    active
      ? "bg-accent-50 dark:bg-accent-950"
      : "web:hover:bg-neutral-100 dark:web:hover:bg-neutral-800"
  }`;
}

function rowLabelClass(active: boolean): string {
  return `flex-1 text-sm ${
    active ? "text-accent-700 dark:text-accent-300" : "text-neutral-700 dark:text-neutral-200"
  }`;
}

export function CommandPalette({
  visible,
  onClose,
  commands,
  onSelect,
  search,
  onSelectTask,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const listRef = useRef<FlatList<PaletteRow>>(null);
  const isWide = useIsWide();

  const results = useMemo(() => filterActions(query, commands), [query, commands]);
  const hits = useMemo(() => (search ? searchTasks(search.tasks, query) : []), [search, query]);
  // Destinations win; a query matching none but matching task text gets the task section.
  const showingTasks = results.length === 0 && hits.length > 0;

  const rows = useMemo<PaletteRow[]>(
    () =>
      showingTasks
        ? hits.map((hit) => ({ kind: "task", hit }))
        : results.map((command) => ({ kind: "command", command })),
    [showingTasks, hits, results],
  );

  function handleClose() {
    setQuery("");
    onClose();
  }

  function run(command: Command) {
    onSelect(command);
    handleClose();
  }

  function openTask(task: Task) {
    onSelectTask?.(task);
    handleClose();
  }

  // Desktop keyboard navigation (arrows, Enter, Escape); no-op on native. Returns the highlighted index.
  const highlighted = useListKeyboardNav({
    enabled: visible,
    count: rows.length,
    onEnter: (index) => {
      const row = rows[index];
      if (!row) return;
      if (row.kind === "command") run(row.command);
      else openTask(row.hit.task);
    },
    onEscape: handleClose,
  });

  useEffect(() => {
    if (visible && rows.length > 0) {
      listRef.current?.scrollToIndex({ index: highlighted, viewPosition: 0.5 });
    }
  }, [highlighted, visible, rows.length]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <ThemeScope className="flex-1">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.close")}
          onPress={handleClose}
          className={`flex-1 ${SCRIM_CLASS}`}
        />
        {/* A 640px column ~12% from the top on wide screens; full width under the header on a phone.
            The frame passes presses outside the panel through to the backdrop. */}
        <View
          style={{ top: isWide ? "12%" : 96, bottom: "10%", pointerEvents: "box-none" }}
          className="absolute inset-x-3 items-center"
        >
          <View
            className={`max-h-full w-full max-w-[640px] overflow-hidden rounded-xl ${ELEVATED_SURFACE_CLASS}`}
          >
            <View className="flex-row items-center gap-2 border-b border-neutral-100 px-3 dark:border-neutral-800">
              <Search size={16} className="text-neutral-500" />
              <TextInput
                accessibilityLabel={t("palette.search")}
                placeholder={t("palette.placeholder")}
                placeholderTextColor={PLACEHOLDER_COLOR}
                value={query}
                onChangeText={setQuery}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                // The panel is the field; a focus ring around the bare input would double it.
                className="flex-1 py-3 text-sm text-neutral-900 dark:text-neutral-100 web:outline-none"
              />
            </View>
            <FlatList
              ref={listRef}
              data={rows}
              keyExtractor={(row) =>
                row.kind === "task" ? `task:${row.hit.task.id}` : row.command.id
              }
              keyboardShouldPersistTaps="handled"
              onScrollToIndexFailed={() => {}}
              ListHeaderComponent={
                showingTasks ? (
                  <Text className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
                    {t("palette.taskResults")}
                  </Text>
                ) : undefined
              }
              ListEmptyComponent={
                <Text className="px-3 py-6 text-center text-sm text-neutral-500">
                  {t("palette.noMatches")}
                </Text>
              }
              renderItem={({ item, index }) => {
                const active = index === highlighted;
                if (item.kind === "task") {
                  const task = item.hit.task;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={displayTitle(task, t)}
                      accessibilityState={{ selected: active }}
                      onPress={() => openTask(task)}
                      className={rowClass(active)}
                    >
                      <Text className={rowLabelClass(active)} numberOfLines={1}>
                        {displayTitle(task, t)}
                      </Text>
                      {search && (
                        <Text className="ml-2 text-xs text-neutral-500">
                          {search.context(task)}
                        </Text>
                      )}
                    </Pressable>
                  );
                }
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={item.command.label}
                    accessibilityState={{ selected: active }}
                    onPress={() => run(item.command)}
                    className={rowClass(active)}
                  >
                    <Text className={rowLabelClass(active)}>{item.command.label}</Text>
                    {item.command.hint != null && (
                      <Text className="text-xs text-neutral-500">{item.command.hint}</Text>
                    )}
                  </Pressable>
                );
              }}
            />
          </View>
        </View>
      </ThemeScope>
    </Modal>
  );
}
