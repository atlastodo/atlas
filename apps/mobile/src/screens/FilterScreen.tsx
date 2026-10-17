import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_FILTER_ICON,
  evaluate,
  parse,
  resolveProjectColor,
  type EvalContext,
} from "@atlastodo/shared";
import type { Task } from "@atlastodo/client-core";
import { useTaskListView } from "../hooks/useTaskListView";
import { useProjects } from "../hooks/useProjects";
import { useLabels } from "../hooks/useLabels";
import { useSavedFilters } from "../hooks/useSavedFilters";
import { usePreferences } from "../hooks/usePreferences";
import { useToast } from "../data/ToastProvider";

import { ViewTaskList } from "./ViewTaskList";
import { ListPrefMenu } from "../ui/ListPrefMenu";
import { SelectButton } from "../ui/SelectButton";
import { FilterHelp } from "../ui/FilterHelp";
import { StyleEditor, StyleEditButton } from "../ui/StyleEditor";
import { CircleAlert, ChevronDown, ChevronRight, Save, Star, Trash2 } from "../ui/icons";

/**
 * Compose or edit a saved filter: a query input (parsed live, parse error inline), a live preview
 * via the shared list layer, and save / pin / delete. A new filter (`filterId === "new"`) is named
 * and created here; an existing one auto-saves its query on blur. The query language is
 * `filterQuery.ts`; `@label` resolves via `useLabels`, `#project` via `useProjects`. Navigation is
 * injected.
 */
export interface FilterScreenProps {
  filterId: string;
  onOpenTask?: (task: Task) => void;
  onSaved?: (id: string) => void;
  onDeleted?: () => void;
}

export function FilterScreen(props: FilterScreenProps) {
  // The route instance is reused across filters: remount per filter so a draft query can never carry over and overwrite another.
  return <FilterEditor key={props.filterId} {...props} />;
}

function FilterEditor({ filterId, onOpenTask, onSaved, onDeleted }: FilterScreenProps) {
  const { t } = useTranslation();
  const isNew = filterId === "new";
  const view = useTaskListView(`filter:${filterId}`);
  const { projects } = useProjects();
  const { byId: labelById } = useLabels();
  const { filters, createFilter, updateFilter, removeFilter } = useSavedFilters();
  const { timezone, weekStartsOn, isFavorite, toggleFavorite } = usePreferences();
  const toast = useToast();

  const existing = isNew ? null : (filters.find((f) => f.id === filterId) ?? null);
  const isFav = existing ? isFavorite(`filter:${existing.id}`) : false;
  const [name, setName] = useState("");
  const [draft, setQuery] = useState<string | null>(null);
  const query = draft ?? existing?.query ?? "";
  const [helpOpen, setHelpOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const parsed = useMemo(() => parse(query), [query]);

  const ctx = useMemo<EvalContext>(() => {
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    return {
      now: view.now,
      timeZone: timezone,
      weekStartsOn,
      labelsOf: (task: Task) =>
        task.label_ids
          .map((id) => labelById(id)?.name)
          .filter((name): name is string => name != null && name !== ""),
      projectNameOf: (task: Task) =>
        task.project_id ? (projectName.get(task.project_id) ?? null) : null,
    };
  }, [projects, labelById, view.now, timezone, weekStartsOn]);

  const results = useMemo(() => {
    if (!parsed.ok) return [];
    return view.tasks.filter((task) => !task.is_completed && evaluate(parsed.ast, task, ctx));
  }, [parsed, view.tasks, ctx]);

  const canCreate = isNew && name.trim().length > 0 && query.trim().length > 0 && parsed.ok;

  function handleCreate() {
    if (!canCreate) return;
    onSaved?.(createFilter(name.trim(), query.trim()));
  }

  function commitQuery() {
    if (
      existing &&
      draft !== null &&
      parsed.ok &&
      query.trim() &&
      query.trim() !== existing.query
    ) {
      updateFilter(existing.id, { query: query.trim() });
    }
  }

  const header = (
    <View className="gap-2 px-4 pb-1 pt-2">
      {isNew ? (
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel={t("filter.name")}
            placeholder={t("filter.name")}
            placeholderTextColor="#737373"
            value={name}
            onChangeText={setName}
            className="flex-1 rounded-md border border-neutral-200 px-2 py-1.5 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.create")}
            disabled={!canCreate}
            onPress={handleCreate}
            className={
              "flex-row items-center gap-1 rounded-md bg-accent-600 px-3 py-2 " +
              (canCreate ? "" : "opacity-40")
            }
          >
            <Save size={16} className="text-white" />
            <Text className="text-sm font-medium text-white">{t("common.create")}</Text>
          </Pressable>
        </View>
      ) : existing ? null : (
        <Text className="text-sm text-neutral-500">{t("common.nothingHere")}</Text>
      )}

      <TextInput
        accessibilityLabel={t("filter.query")}
        placeholder={t("filter.queryPlaceholder")}
        placeholderTextColor="#737373"
        value={query}
        onChangeText={setQuery}
        onBlur={commitQuery}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-md border border-neutral-200 px-2 py-1.5 font-mono text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
      />
      {query.trim() !== "" && !parsed.ok && (
        <View className="flex-row items-center gap-1">
          <CircleAlert size={14} className="text-red-500" />
          <Text className="text-xs text-red-500">{parsed.error}</Text>
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: helpOpen }}
        onPress={() => setHelpOpen((o) => !o)}
        className="flex-row items-center gap-1 self-start"
      >
        {helpOpen ? (
          <ChevronDown size={14} className="text-neutral-500" />
        ) : (
          <ChevronRight size={14} className="text-neutral-500" />
        )}
        <Text className="text-xs text-neutral-500">{t("filter.help")}</Text>
      </Pressable>
      {helpOpen && <FilterHelp />}

      {/* One toolbar row: the match count, then Select and the filter's own actions. */}
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 text-xs text-neutral-500">
          {parsed.ok ? t("filter.matching", { count: results.length }) : t("filter.enterValid")}
        </Text>
        {results.length > 0 && <SelectButton />}
        {existing && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                isFav
                  ? t("workspace.unfavorite", "Remove from favorites")
                  : t("workspace.favorite", "Favorite")
              }
              onPress={() => {
                toggleFavorite(`filter:${existing.id}`);
                toast.show(isFav ? t("toast.favRemoved") : t("toast.favAdded"));
              }}
              hitSlop={8}
              className="p-1 web:cursor-pointer"
            >
              <Star
                size={18}
                className={isFav ? "text-amber-500 fill-amber-500" : "text-neutral-500"}
              />
            </Pressable>
            <StyleEditButton label={t("filter.editStyle")} onPress={() => setEditing(true)} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("filter.delete")}
              onPress={() => {
                const undo = removeFilter(existing.id);
                onDeleted?.();
                toast.show(t("toast.filterDeleted", { name: existing.name }), {
                  label: t("common.undo"),
                  run: undo,
                });
              }}
              hitSlop={8}
              className="p-1"
            >
              <Trash2 size={18} className="text-neutral-500" />
            </Pressable>
          </>
        )}
        <ListPrefMenu value={view.listPref} onChange={view.setListPref} />
      </View>
    </View>
  );

  return (
    <>
      <ViewTaskList
        view={view}
        tasks={results}
        onOpenTask={onOpenTask}
        emptyLabel={t("filter.empty")}
        header={header}
        showToolbar={false}
      />
      <StyleEditor
        open={editing && !!existing}
        name={existing?.name ?? ""}
        nameLabel={t("filter.name")}
        iconLabel={t("common.icon")}
        colorLabel={t("common.color")}
        selectedIcon={existing?.icon || DEFAULT_FILTER_ICON}
        defaultIcon={DEFAULT_FILTER_ICON}
        selectedColor={existing ? resolveProjectColor(existing) : ""}
        isFavorite={isFav}
        onToggleFavorite={() => {
          if (existing) {
            toggleFavorite(`filter:${existing.id}`);
            toast.show(isFav ? t("toast.favRemoved") : t("toast.favAdded"));
          }
        }}
        onRename={(newName) => existing && updateFilter(existing.id, { name: newName })}
        onSetIcon={(icon) => existing && updateFilter(existing.id, { icon })}
        onSetColor={(color) => existing && updateFilter(existing.id, { color })}
        onClose={() => setEditing(false)}
      />
    </>
  );
}
