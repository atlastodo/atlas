import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import { DEFAULT_FILTER_ICON, resolveProjectColor } from "@atlastodo/shared";
import { FilterScreen } from "../../../src/screens/FilterScreen";
import { useSavedFilters } from "../../../src/hooks/useSavedFilters";
import { usePreferences } from "../../../src/hooks/usePreferences";
import { useHeaderTitle } from "../../../src/ui/useHeaderTitle";
import { projectIconFor } from "../../../src/ui/projectIcons";
import { viewPath } from "../../../src/nav/navModel";
import { ScreenFocusBoundary } from "../../../src/ui/ScreenFocusBoundary";

/**
 * Compose (`/filter/new`) or edit (`/filter/<id>`) a saved filter, as a drawer screen: a filter is
 * a view like the smart lists, so it keeps the sidebar (wide) or hamburger bar (narrow) rather than
 * pushing over the shell. Creating a filter replaces the route with the saved id.
 *
 * The filter name is the header title (set here), so the editor shows only its controls.
 */
export default function FilterRoute() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { filters } = useSavedFilters();
  const { defaultView } = usePreferences();
  const isNew = id === "new";
  const filter = isNew ? undefined : filters.find((f) => f.id === id);

  useHeaderTitle({
    icon: projectIconFor(filter?.icon || DEFAULT_FILTER_ICON),
    title: isNew ? t("nav.newFilter") : (filter?.name ?? t("nav.filters")),
    color: filter ? resolveProjectColor(filter) : undefined,
  });

  if (typeof id !== "string") return null;

  return (
    <ScreenFocusBoundary>
      <FilterScreen
        filterId={id}
        onOpenTask={(task) => router.push(`/task/${task.id}`)}
        onSaved={(newId) => router.replace(`/filter/${newId}`)}
        onDeleted={() => router.replace(viewPath(defaultView))}
      />
    </ScreenFocusBoundary>
  );
}
