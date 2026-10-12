import { FlatList, Platform, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSavedFilters, type SavedFilter } from "../hooks/useSavedFilters";
import { usePreferences } from "../hooks/usePreferences";
import { useToast } from "../data/ToastProvider";
import { ListFilter, Plus, Star, Trash2 } from "../ui/icons";
import { EmptyState } from "../ui/EmptyState";

/** Lists every saved filter. Each row opens, favorites or deletes the filter; a header button composes a new one. Navigation is injected (`onOpen`, `onNew`). */
export interface FiltersScreenProps {
  onOpen?: (id: string) => void;
  onNew?: () => void;
}

export function FiltersScreen({ onOpen, onNew }: FiltersScreenProps) {
  const { t } = useTranslation();
  const { filters, removeFilter } = useSavedFilters();
  const { isFavorite, toggleFavorite } = usePreferences();
  const toast = useToast();
  const isWeb = Platform.OS === "web";

  const header = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("filter.newFilter")}
      onPress={onNew}
      className="mx-3 mb-2 mt-3 flex-row items-center gap-2 self-start rounded-md bg-accent-600 px-3 py-2.5 active:bg-accent-700 web:cursor-pointer"
    >
      <Plus size={isWeb ? 16 : 18} className="text-white" />
      <Text className={"font-medium text-white " + (isWeb ? "text-sm" : "text-base")}>
        {t("filter.newFilter")}
      </Text>
    </Pressable>
  );

  // The empty state carries the create action itself, next to the explanation it belongs to.
  if (filters.length === 0) {
    return (
      <EmptyState
        icon={ListFilter}
        title={t("filters.empty")}
        description={t("filters.emptyHint")}
        actions={onNew ? [{ label: t("filter.newFilter"), onPress: onNew, primary: true }] : []}
      />
    );
  }

  return (
    <FlatList
      className="flex-1 bg-white dark:bg-zinc-950"
      data={filters}
      keyExtractor={(f) => f.id}
      ListHeaderComponent={header}
      renderItem={({ item }) => {
        const isFav = isFavorite(`filter:${item.id}`);
        return (
          <FilterRow
            filter={item}
            isFav={isFav}
            onOpen={() => onOpen?.(item.id)}
            onToggleFavorite={() => {
              toggleFavorite(`filter:${item.id}`);
              toast.show(isFav ? t("toast.favRemoved") : t("toast.favAdded"));
            }}
            onDelete={() => {
              const undo = removeFilter(item.id);
              toast.show(t("toast.filterDeleted"), { label: t("common.undo"), run: undo });
            }}
          />
        );
      }}
    />
  );
}

function FilterRow({
  filter,
  isFav,
  onOpen,
  onToggleFavorite,
  onDelete,
}: {
  filter: SavedFilter;
  isFav: boolean;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const isWeb = Platform.OS === "web";
  return (
    <View className="flex-row items-center gap-2 border-b border-neutral-100 px-3 py-3 dark:border-neutral-800">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={filter.name}
        onPress={onOpen}
        className="min-w-0 flex-1"
      >
        <Text
          className={
            "font-medium text-neutral-800 dark:text-neutral-100 " + (isWeb ? "text-sm" : "text-lg")
          }
          numberOfLines={1}
        >
          {filter.name}
        </Text>
        <Text
          className={"font-mono text-neutral-500 " + (isWeb ? "text-xs" : "text-base")}
          numberOfLines={1}
        >
          {filter.query}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          isFav
            ? t("workspace.unfavorite", "Remove from favorites")
            : t("workspace.favorite", "Favorite")
        }
        onPress={onToggleFavorite}
        hitSlop={8}
        className="p-1"
      >
        <Star
          size={isWeb ? 16 : 18}
          className={isFav ? "text-amber-500 fill-amber-500" : "text-neutral-500"}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("filter.delete")}
        onPress={onDelete}
        hitSlop={8}
        className="p-1"
      >
        <Trash2 size={isWeb ? 16 : 18} className="text-neutral-500" />
      </Pressable>
    </View>
  );
}
