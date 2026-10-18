import { useCallback, useContext, useMemo } from "react";
import { rescopeNeeded, rescopeSection, type Section } from "@atlastodo/client-core";
import {
  isTrashed,
  moveSectionToProject as moveSectionToProjectOp,
  planSectionDuplicate,
  purge,
  reorderRank,
  sectionCreateFields,
  setSectionArchived,
  softDelete,
  toSection,
  toTask,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";
import { AuthContext } from "../auth/AuthContext";

/**
 * A project's sections (its Kanban columns): list, create, rename, deep-duplicate (via
 * `planSectionDuplicate`), soft-delete. Trashed sections are filtered out and their tasks hide via
 * the read cascade.
 */

export interface UseSections {
  sections: Section[];
  createSection: (name: string, sortOrder?: number) => string;
  renameSection: (id: string, name: string) => void;
  /** Deep-duplicate a section (its open tasks); returns the new id + an undo that hard-removes it. */
  duplicateSection: (id: string) => { newId: string; undo: () => void };
  /** Soft-delete a section to Trash (its tasks hide with it); returns an undo closure. */
  removeSection: (id: string) => () => void;
  /** Archive a section (hidden without deleting; its tasks hide with it); returns an undo closure. */
  archiveSection: (id: string) => () => void;
  /** Move a whole section (and its tasks) to another project; returns an undo closure. */
  moveSectionToProject: (id: string, targetProjectId: string) => () => void;
  /** Reorder a section one step up or down among its siblings (re-ranks its `sort_order`). */
  reorderSection: (id: string, direction: "up" | "down") => void;
  /** Move a section to an arbitrary index among its siblings (drag-reorder; re-ranks `sort_order`). */
  reorderSectionTo: (id: string, toIndex: number) => void;
}

export function useSections(projectId: string): UseSections {
  const { store, version, kick } = useStore();
  const keyring = useContext(AuthContext)?.keyring ?? null;

  const sections = useMemo(
    () =>
      store
        .list("section")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toSection(e.id, e.fields))
        .filter((s) => s.project_id === projectId && s.archived_at == null)
        .sort((a, b) => a.sort_order - b.sort_order),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, projectId],
  );

  const createSection = useCallback(
    (name: string, sortOrder?: number) => {
      // Store-minted ids, never crypto.randomUUID() (Hermes has no global crypto).
      const id = store.newEntityId();
      const fields = sectionCreateFields({
        project_id: projectId,
        name,
        sort_order: sortOrder ?? Date.now(),
      });
      for (const [field, value] of Object.entries(fields)) store.set("section", id, field, value);
      kick();
      return id;
    },
    [store, kick, projectId],
  );

  const renameSection = useCallback(
    (id: string, name: string) => {
      store.set("section", id, "name", name);
      kick();
    },
    [store, kick],
  );

  const duplicateSection = useCallback(
    (id: string) => {
      const src = store.get("section", id);
      if (!src) return { newId: id, undo: () => {} };
      const section = toSection(id, src);
      const tasks = store
        .list("task")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toTask(e.id, e.fields));
      const { newSectionId, writes } = planSectionDuplicate(section, tasks, {
        mkId: () => store.newEntityId(),
        now: Date.now(),
      });
      for (const w of writes) store.set(w.kind, w.id, w.field, w.value);
      kick();
      // Undo hard-tombstones the new section and its cloned tasks.
      return { newId: newSectionId, undo: () => purge(store, kick, "section", newSectionId) };
    },
    [store, kick],
  );

  const removeSection = useCallback(
    (id: string) => softDelete(store, kick, "section", id),
    [store, kick],
  );

  const archiveSection = useCallback(
    (id: string) => {
      setSectionArchived(store, id, true);
      kick();
      return () => {
        setSectionArchived(store, id, false);
        kick();
      };
    },
    [store, kick],
  );

  const moveSectionToProject = useCallback(
    (id: string, targetProjectId: string) => {
      // The move is symmetric, so undo moves it back. Content crossing into or out of a shared
      // project is re-sent under its new scope's key.
      const move = (from: string, to: string) => {
        const rescope = rescopeNeeded(store, keyring, from, to);
        moveSectionToProjectOp(store, id, to);
        if (rescope) rescopeSection(store, keyring, id, from);
        kick();
      };
      move(projectId, targetProjectId);
      return () => move(targetProjectId, projectId);
    },
    [store, kick, projectId, keyring],
  );

  const reorderSection = useCallback(
    (id: string, direction: "up" | "down") => {
      const from = sections.findIndex((s) => s.id === id);
      const to = direction === "up" ? from - 1 : from + 1;
      // reorderRank re-ranks the moved section (and tied siblings); a no-op at the ends.
      const move = reorderRank(sections, from, to);
      if (!move) return;
      for (const w of move.writes) store.set("section", w.id, "sort_order", w.sort_order);
      kick();
    },
    [store, kick, sections],
  );

  const reorderSectionTo = useCallback(
    (id: string, toIndex: number) => {
      const from = sections.findIndex((s) => s.id === id);
      if (from < 0) return;
      // A no-op when the target index does not change its position.
      const move = reorderRank(sections, from, toIndex);
      if (!move) return;
      for (const w of move.writes) store.set("section", w.id, "sort_order", w.sort_order);
      kick();
    },
    [store, kick, sections],
  );

  return {
    sections,
    createSection,
    renameSection,
    duplicateSection,
    removeSection,
    archiveSection,
    moveSectionToProject,
    reorderSection,
    reorderSectionTo,
  };
}
