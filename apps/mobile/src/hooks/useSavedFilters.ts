import { useCallback, useMemo } from "react";
import { defaultColorForIndex, isTrashed, softDelete } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/**
 * Saved filters: `saved_filter` entities in the shared store. Ids come from `store.newEntityId()`,
 * never `crypto.randomUUID()` (Hermes has no global `crypto`, and a non-UUID id 422s the push).
 */

export interface SavedFilter {
  id: string;
  name: string;
  query: string;
  pinned: boolean;
  icon: string;
  color: string;
  sort_order: number;
}

function toSavedFilter(id: string, fields: Record<string, unknown>): SavedFilter {
  return {
    id,
    name: typeof fields.name === "string" ? fields.name : "",
    query: typeof fields.query === "string" ? fields.query : "",
    pinned: fields.pinned === true,
    icon: typeof fields.icon === "string" ? fields.icon : "",
    color: typeof fields.color === "string" ? fields.color : "",
    sort_order: typeof fields.sort_order === "number" ? fields.sort_order : 0,
  };
}

export interface UseSavedFilters {
  filters: SavedFilter[];
  createFilter: (name: string, query: string, pinned?: boolean) => string;
  updateFilter: (id: string, patch: Partial<Omit<SavedFilter, "id">>) => void;
  /** Delete a saved filter; returns a closure that restores it (for an undo). */
  removeFilter: (id: string) => () => void;
}

export function useSavedFilters(): UseSavedFilters {
  const { store, version, kick } = useStore();

  const filters = useMemo(
    () =>
      store
        .list("saved_filter")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toSavedFilter(e.id, e.fields))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  const createFilter = useCallback(
    (name: string, query: string, pinned = true) => {
      const id = store.newEntityId();
      store.set("saved_filter", id, "name", name);
      store.set("saved_filter", id, "query", query);
      store.set("saved_filter", id, "pinned", pinned);
      // Rotate a distinct default colour by the live count, as for projects.
      store.set(
        "saved_filter",
        id,
        "color",
        defaultColorForIndex(store.list("saved_filter").length),
      );
      store.set("saved_filter", id, "sort_order", Date.now());
      kick();
      return id;
    },
    [store, kick],
  );

  const updateFilter = useCallback(
    (id: string, patch: Partial<Omit<SavedFilter, "id">>) => {
      for (const [field, value] of Object.entries(patch))
        store.set("saved_filter", id, field, value);
      kick();
    },
    [store, kick],
  );

  const removeFilter = useCallback(
    (id: string) => softDelete(store, kick, "saved_filter", id),
    [store, kick],
  );

  return { filters, createFilter, updateFilter, removeFilter };
}
