import { useCallback, useMemo } from "react";
import type { Label } from "@atlastodo/client-core";
import { defaultColorForIndex, isTrashed, softDelete } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";
import { useAuth } from "../auth/AuthContext";

function toLabel(id: string, fields: Record<string, unknown>): Label {
  return {
    id,
    owner_id: typeof fields.owner_id === "string" ? fields.owner_id : "",
    name: typeof fields.name === "string" ? fields.name : "",
    color: typeof fields.color === "string" ? fields.color : "",
  };
}

/**
 * User labels from the shared store: user-private `label` entities that tasks reference by id in
 * `label_ids`. Soft-deletes to Trash. Ids come from `store.newEntityId()`, never
 * `crypto.randomUUID()` (Hermes has no global `crypto`, and a non-UUID id 422s the whole push).
 */

export interface UseLabels {
  labels: Label[];
  byId: (id: string) => Label | undefined;
  /** Create a label (rotating colour if none given); returns its id. */
  createLabel: (name: string, color?: string) => string;
  updateLabel: (id: string, patch: Partial<Pick<Label, "name" | "color">>) => void;
  /** Soft-delete a label to Trash; returns a closure that restores it (for an undo toast). */
  removeLabel: (id: string) => () => void;
}

export function useLabels(): UseLabels {
  const { store, kick } = useStore();
  const { session } = useAuth();
  const ownerId = session?.user.id ?? "";

  // Keyed on the label revision rather than `version`, so `byId` keeps its identity across task
  // edits: task rows take it as a prop and are memoised on it.
  const labelRevision = store.revision("label");
  const labels = useMemo(
    () =>
      store
        .list("label")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toLabel(e.id, e.fields))
        .sort((a, b) => a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, labelRevision],
  );

  const map = useMemo(() => {
    const m = new Map<string, Label>();
    for (const l of labels) m.set(l.id, l);
    return m;
  }, [labels]);
  const byId = useCallback((id: string) => map.get(id), [map]);

  const createLabel = useCallback(
    (name: string, color?: string) => {
      const id = store.newEntityId();
      // Read the count live (not the memoized list) so back-to-back creates rotate.
      const chosen = color ?? defaultColorForIndex(store.list("label").length);
      store.set("label", id, "name", name);
      store.set("label", id, "color", chosen);
      if (ownerId) store.set("label", id, "owner_id", ownerId);
      kick();
      return id;
    },
    [store, kick, ownerId],
  );

  const updateLabel = useCallback(
    (id: string, patch: Partial<Pick<Label, "name" | "color">>) => {
      for (const [field, value] of Object.entries(patch)) store.set("label", id, field, value);
      kick();
    },
    [store, kick],
  );

  const removeLabel = useCallback(
    (id: string) => softDelete(store, kick, "label", id),
    [store, kick],
  );

  return { labels, byId, createLabel, updateLabel, removeLabel };
}
