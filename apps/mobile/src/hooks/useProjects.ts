import { useCallback, useMemo } from "react";
import type { Project, ProjectView } from "@atlastodo/client-core";
import {
  DEFAULT_FOLDER_ICON,
  DEFAULT_PROJECT_ICON,
  defaultColorForIndex,
  hiddenProjectIds,
  isTrashed,
  moveProjectTarget,
  planProjectDuplicate,
  projectCreateFields,
  purge,
  reorderRank,
  softDelete,
  toProject,
  toSection,
  toTask,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/**
 * Projects from the shared store: list, create (default icon, rotated colour), rename, icon/colour,
 * deep-duplicate (via `planProjectDuplicate`), soft-delete to Trash, and archive.
 *
 * `projects` is real projects only; folders come back separately, because only a project gets a
 * board/list. Trashed projects are filtered out, and so is anything behind an archived or trashed
 * folder at any depth; the tasks follow via the read-time cascade in `taskOps`. The tree rules
 * live in `@atlastodo/shared`'s `projectTree`.
 */

export interface UseProjects {
  /** Real projects (never folders), in display order, minus anything hidden by an ancestor. */
  projects: Project[];
  /** Folders, in display order, under the same visibility rules. */
  folders: Project[];
  /** Projects and folders archived in their own right (not merely inside an archived folder). */
  archivedProjects: Project[];
  createProject: (
    name: string,
    opts?: { parentId?: string | null; icon?: string; color?: string; defaultView?: ProjectView },
  ) => string;
  /** Create a folder: a project entity that holds other projects instead of tasks. */
  createFolder: (
    name: string,
    opts?: { parentId?: string | null; icon?: string; color?: string },
  ) => string;
  renameProject: (id: string, name: string) => void;
  /** Deep-duplicate a project (its sections + open tasks); returns the new id + an undo that removes it. */
  duplicateProject: (id: string) => { newId: string; undo: () => void };
  updateProject: (
    id: string,
    patch: { icon?: string; color?: string; default_view?: ProjectView },
  ) => void;
  /**
   * Move a project or folder into `parentId` (`null` = top level). Returns an undo closure, or
   * **`null` when the move was refused** because it would put a folder inside its own subtree.
   */
  setProjectParent: (id: string, parentId: string | null) => (() => void) | null;
  /** Move a project one place up or down among its own siblings. A no-op at either end. */
  reorderProject: (id: string, direction: "up" | "down") => void;
  /** Soft-delete a project to Trash (its sections/tasks hide via the cascade); returns an undo closure. */
  removeProject: (id: string) => () => void;
  setProjectArchived: (id: string, archived: boolean) => void;
}

export function useProjects(): UseProjects {
  const { store, version, kick } = useStore();

  const allProjects = useMemo(
    () =>
      store
        .list("project")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toProject(e.id, e.fields))
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version],
  );

  // The ancestor cascade, resolved once for the whole set (this runs on every store change): a
  // project inside an archived or trashed folder is hidden as if archived itself.
  const active = useMemo(() => {
    const hidden = hiddenProjectIds(allProjects);
    return allProjects.filter((p) => !hidden.has(p.id));
  }, [allProjects]);

  const projects = useMemo(() => active.filter((p) => p.kind === "project"), [active]);
  const folders = useMemo(() => active.filter((p) => p.kind === "folder"), [active]);
  // Archived in its own right: a project merely inside an archived folder is restored with it.
  const archivedProjects = useMemo(
    () => allProjects.filter((p) => p.archived_at != null),
    [allProjects],
  );

  const create = useCallback(
    (
      name: string,
      kind: "project" | "folder",
      opts: { parentId?: string | null; icon?: string; color?: string; defaultView?: ProjectView },
    ) => {
      // The store's generator, never `crypto.randomUUID()` (Hermes has none; non-UUIDs 422 the push).
      const id = store.newEntityId();
      // Colour rotates by the live count so back-to-back creates stay distinct.
      const count = store
        .list("project")
        .filter((e) => (e.fields.kind === "folder") === (kind === "folder")).length;
      const fields = projectCreateFields({
        name,
        kind,
        parent_id: opts.parentId ?? null,
        icon: opts.icon || (kind === "folder" ? DEFAULT_FOLDER_ICON : DEFAULT_PROJECT_ICON),
        color: opts.color || defaultColorForIndex(count),
        default_view: kind === "project" ? opts.defaultView : undefined,
        sort_order: Date.now(),
      });
      for (const [field, value] of Object.entries(fields)) store.set("project", id, field, value);
      kick();
      return id;
    },
    [store, kick],
  );

  const createProject = useCallback(
    (
      name: string,
      opts?: { parentId?: string | null; icon?: string; color?: string; defaultView?: ProjectView },
    ) => create(name, "project", opts ?? {}),
    [create],
  );

  const createFolder = useCallback(
    (name: string, opts?: { parentId?: string | null; icon?: string; color?: string }) =>
      create(name, "folder", opts ?? {}),
    [create],
  );

  const renameProject = useCallback(
    (id: string, name: string) => {
      store.set("project", id, "name", name);
      kick();
    },
    [store, kick],
  );

  const duplicateProject = useCallback(
    (id: string) => {
      const source = store.get("project", id);
      if (!source) return { newId: id, undo: () => {} };
      const project = toProject(id, source);
      const sections = store
        .list("section")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toSection(e.id, e.fields))
        .filter((s) => s.project_id === id)
        .sort((a, b) => a.sort_order - b.sort_order);
      const tasks = store
        .list("task")
        .filter((e) => !isTrashed(e.fields))
        .map((e) => toTask(e.id, e.fields))
        .filter((tk) => tk.project_id === id);
      const { newProjectId, writes } = planProjectDuplicate(project, sections, tasks, {
        mkId: () => store.newEntityId(),
        now: Date.now(),
      });
      for (const w of writes) store.set(w.kind, w.id, w.field, w.value);
      kick();
      // Undo hard-tombstones the copy and its cloned sections/tasks.
      return { newId: newProjectId, undo: () => purge(store, kick, "project", newProjectId) };
    },
    [store, kick],
  );

  const updateProject = useCallback(
    (id: string, patch: { icon?: string; color?: string; default_view?: ProjectView }) => {
      if (patch.icon !== undefined) store.set("project", id, "icon", patch.icon);
      if (patch.color !== undefined) store.set("project", id, "color", patch.color);
      if (patch.default_view !== undefined) {
        store.set("project", id, "default_view", patch.default_view);
      }
      kick();
    },
    [store, kick],
  );

  const setProjectParent = useCallback(
    (id: string, parentId: string | null) => {
      // The cycle guard lives here, not only in the picker: sync bypasses any server parent check.
      const target = moveProjectTarget(allProjects, id, parentId);
      if (!target) return null;
      const before = allProjects.find((p) => p.id === id);
      store.set("project", id, "parent_id", target.parent_id);
      store.set("project", id, "sort_order", target.sort_order);
      kick();
      return () => {
        store.set("project", id, "parent_id", before?.parent_id ?? null);
        if (before) store.set("project", id, "sort_order", before.sort_order);
        kick();
      };
    },
    [store, kick, allProjects],
  );

  const reorderProject = useCallback(
    (id: string, direction: "up" | "down") => {
      const self = active.find((p) => p.id === id);
      if (!self) return;
      // Siblings only: `active` is in display order, and reorderRank re-ranks the moved row (and
      // tied siblings); at either end `to` is out of range and nothing happens.
      const siblings = active.filter((p) => p.parent_id === self.parent_id);
      const from = siblings.findIndex((p) => p.id === id);
      const move = reorderRank(siblings, from, direction === "up" ? from - 1 : from + 1);
      if (!move) return;
      for (const w of move.writes) store.set("project", w.id, "sort_order", w.sort_order);
      kick();
    },
    [store, kick, active],
  );

  const removeProject = useCallback(
    (id: string) => softDelete(store, kick, "project", id),
    [store, kick],
  );

  const setProjectArchived = useCallback(
    (id: string, archived: boolean) => {
      store.set("project", id, "archived_at", archived ? Date.now() : null);
      kick();
    },
    [store, kick],
  );

  return {
    projects,
    folders,
    archivedProjects,
    createProject,
    createFolder,
    renameProject,
    duplicateProject,
    updateProject,
    setProjectParent,
    reorderProject,
    removeProject,
    setProjectArchived,
  };
}
