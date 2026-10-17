import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Label, Priority, Project, Section, Task } from "@atlastodo/client-core";
import type { GroupBy } from "@atlastodo/shared";
import { useAuth } from "../auth/AuthContext";
import { useLocalTasks } from "./useLocalTasks";
import { useLabels } from "./useLabels";
import { useProjects } from "./useProjects";
import { useAllSections } from "./useAllSections";
import { useNow } from "./useNow";
import { usePreferences, type ListPref } from "./usePreferences";
import { useFormat } from "./useFormat";
import { useToast } from "../data/ToastProvider";

/**
 * Everything a smart-list screen shares: the tasks, the clock, the group/sort preference, the
 * formatters and the bulk actions. Each screen only picks which tasks it shows.
 *
 * Group titles resolve here: date/priority/completed keys map through the catalogs, project and
 * label keys through the loaded lists ("inbox"/"none" buckets and unknown ids use the generic label).
 */

export interface UseTaskListView {
  tasks: Task[];
  now: number;
  timeZone: string | undefined;
  /** Whether quick-add should recognize date/time phrases (the synced smart-dates preference). */
  smartDates: boolean;
  listPref: ListPref;
  setListPref: (patch: Partial<ListPref>) => void;
  groupTitle: (kind: GroupBy, key: string) => string;
  formatDue: (ms: number) => string;
  toggle: (task: Task) => void;
  /** Reschedule a single task (swipe-left). */
  reschedule: (task: Task, dueAt: number | null) => void;
  /** Reschedule several tasks at once with one undo toast (Today's "reschedule all overdue"). */
  rescheduleMany: (tasks: Task[], dueAt: number | null) => void;
  /**
   * Apply plan-my-day decisions: one `due_at` op per task, with a single undoable toast. A write
   * that throws is skipped; the task keeps its date and comes back on the next review pass.
   */
  applyPlanDay: (writes: { id: string; dueAt: number }[]) => void;
  /** Persist a reordered task's new sort_order (drag reorder). */
  reorderTask: (id: string, sortOrder: number) => void;
  /** Reparent a task (subtasks): new parent (or null for top-level) + rank; cycle-guarded. */
  reparentTask: (id: string, parentId: string | null, sortOrder: number) => void;
  /** Apply a board move (section_id + sort_order) to a task. */
  moveCard: (
    id: string,
    patch: { section_id: string | null; sort_order?: number; parent_id?: string | null },
  ) => void;
  /** Bulk actions over ids, for the selection toolbar. */
  bulkSetPriority: (ids: string[], priority: Priority) => void;
  bulkSetDue: (ids: string[], dueAt: number | null) => void;
  /** Apply a label change-set to every task. Idempotent per task; other labels are untouched. */
  bulkSetLabels: (ids: string[], change: { add: string[]; remove: string[] }) => void;
  /** Strip every label from the selected tasks. */
  bulkClearLabels: (ids: string[]) => void;
  bulkDuplicate: (ids: string[]) => void;
  bulkDelete: (ids: string[]) => void;
  /** Complete several tasks at once with a single undoable toast. */
  bulkComplete: (ids: string[]) => void;
  /** Move the selected tasks to another project/section, with an undo toast. */
  bulkMove: (
    ids: string[],
    target: { project_id: string | null; section_id: string | null },
  ) => void;
  create: ReturnType<typeof useLocalTasks>["create"];
  update: ReturnType<typeof useLocalTasks>["update"];
  discard: ReturnType<typeof useLocalTasks>["discard"];
  /** Skip a recurring task's occurrence (advance its due date without completing). */
  skip: ReturnType<typeof useLocalTasks>["skip"];
  /** Resolve quick-add `@label` names to label ids, creating any that don't exist. */
  resolveLabels: (names: string[]) => string[];
  /** Resolve a quick-add `#project` name to its id (case-insensitive), for the parser. */
  resolveProject: (name: string) => string | null;
  /** Create a project/label from quick-add (returns its id), so a new one is a real entity. */
  createProject: (name: string) => string;
  createLabel: (name: string, color?: string) => string;
  /** Existing labels, for quick-add's compose bar and its `@` autocomplete. */
  labels: Label[];
  /** Existing projects, for quick-add's compose bar and its `#` autocomplete. */
  projects: Project[];
  /** Existing sections, for quick-add's compose bar section selection. */
  sections: Section[];
}

/**
 * @param viewKey the key the group/sort preference is stored under (the view's route segment).
 * @param fallback this view's default grouping, when the user has not chosen one.
 */
export function useTaskListView(
  viewKey: string,
  fallback: ListPref = { group: "none", sort: "manual" },
): UseTaskListView {
  const { t } = useTranslation();
  const { session } = useAuth();
  const {
    tasks,
    create,
    toggle: toggleBase,
    update,
    move,
    reparent,
    moveToProject,
    remove,
    restore,
    duplicate,
    discard,
    skip,
  } = useLocalTasks(session?.user.id);
  const { timezone, smartDatesEnabled, listPrefFor, setListPref: writeListPref } = usePreferences();
  const { labels, createLabel } = useLabels();
  const { projects, createProject } = useProjects();
  const allSections = useAllSections();
  const toast = useToast();
  const format = useFormat();
  const now = useNow();

  const resolveLabels = useCallback(
    (names: string[]) =>
      names
        .map((name) => {
          const existing = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
          return existing ? existing.id : null;
        })
        .filter((id): id is string => id != null),
    [labels],
  );

  const resolveProject = useCallback(
    (name: string) => {
      const p = projects.find((proj) => proj.name.toLowerCase() === name.toLowerCase());
      return p ? p.id : null;
    },
    [projects],
  );
  const timeZone = timezone || undefined;
  const listPref = listPrefFor(viewKey, fallback);

  const setListPref = useCallback(
    (patch: Partial<ListPref>) => writeListPref(viewKey, patch),
    [writeListPref, viewKey],
  );

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const groupTitle = useCallback(
    (kind: GroupBy, key: string): string => {
      if (kind === "date") return t(`group.${key === "none" ? "noDate" : key}`);
      if (kind === "priority") return t(`group.${key === "none" ? "noPriority" : key}`);
      if (kind === "completed")
        return t(
          key === "today"
            ? "group.completedToday"
            : key === "thisWeek"
              ? "group.completedThisWeek"
              : key === "thisMonth"
                ? "group.completedThisMonth"
                : "group.completedOlder",
        );
      if (kind === "project")
        return key === "inbox"
          ? t("group.inbox")
          : (projects.find((p) => p.id === key)?.name ?? t("group.inbox"));
      if (kind === "label")
        return key === "none"
          ? t("group.noLabel")
          : (labels.find((l) => l.id === key)?.name ?? t("group.noLabel"));
      return "";
    },
    [t, projects, labels],
  );

  const bulkSetPriority = useCallback(
    (ids: string[], priority: Priority) => {
      const prev: { task: Task; priority: Priority }[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        // A locked task refuses the write, so it is not counted or undone.
        if (task && task.priority !== priority && update(task, { priority })) {
          prev.push({ task, priority: task.priority });
        }
      }
      if (prev.length === 0) return;
      toast.show(t("toast.priorityCount", { count: prev.length }), {
        label: t("common.undo"),
        // `updateTask` skips a field equal to the passed task's value, so undo passes a task
        // carrying the new priority.
        run: () => prev.forEach((p) => update({ ...p.task, priority }, { priority: p.priority })),
      });
    },
    [byId, update, toast, t],
  );

  const bulkSetDue = useCallback(
    (ids: string[], dueAt: number | null) => {
      const prev: { id: string; due_at: number | null }[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        if (task && task.due_at !== dueAt && move(id, { due_at: dueAt })) {
          prev.push({ id, due_at: task.due_at });
        }
      }
      if (prev.length === 0) return;
      // Any date, so not the "to today" wording `rescheduleMany` uses.
      toast.show(t("toast.rescheduledMany", { count: prev.length }), {
        label: t("common.undo"),
        run: () => prev.forEach((p) => move(p.id, { due_at: p.due_at })),
      });
    },
    [byId, move, toast, t],
  );

  const bulkMove = useCallback(
    (ids: string[], target: { project_id: string | null; section_id: string | null }) => {
      // Append to the target in selection order via increasing now-based ranks.
      const prev: {
        id: string;
        project_id: string | null;
        section_id: string | null;
        sort_order: number;
      }[] = [];
      const base = now;
      let i = 0;
      for (const id of ids) {
        const task = byId.get(id);
        if (!task) continue;
        const moved = moveToProject(id, {
          project_id: target.project_id,
          section_id: target.section_id,
          sort_order: base + i,
        });
        if (!moved) continue;
        prev.push({
          id,
          project_id: task.project_id,
          section_id: task.section_id,
          sort_order: task.sort_order,
        });
        i++;
      }
      if (prev.length === 0) return;
      toast.show(t("toast.movedCount", { count: prev.length }), {
        label: t("common.undo"),
        run: () =>
          prev.forEach((p) =>
            moveToProject(p.id, {
              project_id: p.project_id,
              section_id: p.section_id,
              sort_order: p.sort_order,
            }),
          ),
      });
    },
    [byId, moveToProject, now, toast, t],
  );

  const bulkComplete = useCallback(
    (ids: string[]) => {
      const prev: Task[] = [];
      const spawned: string[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        // A locked task is never completed (see `toggle`).
        if (task && !task.is_completed && !task.locked) {
          prev.push(task);
          const spawnedId = toggleBase(task);
          if (spawnedId != null) spawned.push(spawnedId);
        }
      }
      if (prev.length === 0) return;
      toast.show(t("toast.completedCount", { count: prev.length }), {
        label: t("common.undo"),
        run: () => {
          // Discard the next instance a recurring completion spawned.
          for (const id of spawned) discard(id);
          for (const p of prev) {
            toggleBase({ ...p, is_completed: true });
          }
        },
      });
    },
    [byId, toggleBase, discard, toast, t],
  );

  // Undo re-toggles a completed snapshot (`toggleTask` reads that as "reopen") and discards a
  // recurring completion's spawned next instance.
  const toggle = useCallback(
    (task: Task) => {
      // A task this device cannot decrypt is not completed: a recurring one would spawn its next
      // instance from placeholder fields. Covers the swipe, keyboard and menu paths.
      if (task.locked) return;
      const spawnedId = toggleBase(task);
      if (!task.is_completed) {
        toast.show(t("toast.completed"), {
          label: t("common.undo"),
          run: () => {
            if (spawnedId != null) discard(spawnedId);
            toggleBase({ ...task, is_completed: true });
          },
        });
      }
    },
    [toggleBase, discard, toast, t],
  );

  const reschedule = useCallback(
    (task: Task, dueAt: number | null) => {
      const prev = task.due_at;
      if (!move(task.id, { due_at: dueAt })) return;
      toast.show(t("toast.rescheduled"), {
        label: t("common.undo"),
        run: () => move(task.id, { due_at: prev }),
      });
    },
    [move, toast, t],
  );

  const rescheduleMany = useCallback(
    (tasksToMove: Task[], dueAt: number | null) => {
      const prev = tasksToMove
        .map((tk) => ({ id: tk.id, due_at: tk.due_at }))
        .filter((p) => move(p.id, { due_at: dueAt }));
      if (prev.length === 0) return;
      toast.show(t("toast.rescheduledCount", { count: prev.length }), {
        label: t("common.undo"),
        run: () => prev.forEach((p) => move(p.id, { due_at: p.due_at })),
      });
    },
    [move, toast, t],
  );

  // Unlike `rescheduleMany`, every task moves to its own target, so undo snapshots per task. Each
  // write is guarded so one failure leaves the rest applied.
  const applyPlanDay = useCallback(
    (writes: { id: string; dueAt: number }[]) => {
      const prev: { id: string; due_at: number | null }[] = [];
      for (const w of writes) {
        const task = byId.get(w.id);
        if (!task || task.due_at === w.dueAt) continue;
        try {
          // A locked task refuses the write and stays out of the undo snapshot.
          if (move(task.id, { due_at: w.dueAt })) prev.push({ id: task.id, due_at: task.due_at });
        } catch {
          // Leave this one for the next pass.
        }
      }
      if (prev.length === 0) return;
      toast.show(t("toast.rescheduledMany", { count: prev.length }), {
        label: t("common.undo"),
        run: () => prev.forEach((p) => move(p.id, { due_at: p.due_at })),
      });
    },
    [byId, move, toast, t],
  );

  const reparentTask = useCallback(
    (id: string, parentId: string | null, sortOrder: number) => reparent(id, parentId, sortOrder),
    [reparent],
  );

  const reorderTask = useCallback(
    (id: string, sortOrder: number) => move(id, { sort_order: sortOrder }),
    [move],
  );

  const moveCard = useCallback(
    (
      id: string,
      patch: { section_id: string | null; sort_order?: number; parent_id?: string | null },
    ) => move(id, patch),
    [move],
  );

  const bulkDuplicate = useCallback(
    (ids: string[]) => {
      const newIds: string[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        const copyId = task ? duplicate(task) : null;
        if (copyId != null) newIds.push(copyId);
      }
      if (newIds.length === 0) return;
      toast.show(t("toast.duplicated", { count: newIds.length }), {
        label: t("common.undo"),
        run: () => newIds.forEach((id) => discard(id)),
      });
    },
    [byId, duplicate, discard, toast, t],
  );

  // One `label_ids` op per task. A task already holding exactly the target set (order aside) is skipped.
  const bulkSetLabels = useCallback(
    (ids: string[], change: { add: string[]; remove: string[] }) => {
      if (change.add.length === 0 && change.remove.length === 0) return;
      const prev: { task: Task; label_ids: string[] }[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        if (!task) continue;
        const next = task.label_ids.filter((l) => !change.remove.includes(l));
        for (const added of change.add) if (!next.includes(added)) next.push(added);
        if (
          next.length === task.label_ids.length &&
          next.every((l) => task.label_ids.includes(l))
        ) {
          continue;
        }
        // A locked task's label_ids are a placeholder `[]`: the write is refused.
        if (update(task, { label_ids: next })) prev.push({ task, label_ids: [...task.label_ids] });
      }
      if (prev.length === 0) return;
      toast.show(t("toast.labelAddedMany", { count: prev.length }), {
        label: t("common.undo"),
        run: () => prev.forEach((p) => update(p.task, { label_ids: p.label_ids })),
      });
    },
    [byId, update, toast, t],
  );

  const bulkClearLabels = useCallback(
    (ids: string[]) => {
      const prev: { task: Task; label_ids: string[] }[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        if (task && task.label_ids.length > 0 && update(task, { label_ids: [] })) {
          prev.push({ task, label_ids: [...task.label_ids] });
        }
      }
      if (prev.length === 0) return;
      toast.show(t("toast.labelRemovedMany", { count: prev.length }), {
        label: t("common.undo"),
        run: () => prev.forEach((p) => update(p.task, { label_ids: p.label_ids })),
      });
    },
    [byId, update, toast, t],
  );

  const bulkDelete = useCallback(
    (ids: string[]) => {
      const removed: Task[] = [];
      for (const id of ids) {
        const task = byId.get(id);
        if (task && remove(task)) removed.push(task);
      }
      if (removed.length === 0) return;
      toast.show(t("toast.deletedCount", { count: removed.length }), {
        label: t("common.undo"),
        run: () => removed.forEach((task) => restore(task)),
      });
    },
    [byId, remove, restore, toast, t],
  );

  return {
    tasks,
    now,
    timeZone,
    smartDates: smartDatesEnabled,
    listPref,
    setListPref,
    groupTitle,
    formatDue: format.dueChip,
    toggle,
    reschedule,
    rescheduleMany,
    applyPlanDay,
    reorderTask,
    reparentTask,
    moveCard,
    bulkSetPriority,
    bulkSetDue,
    bulkSetLabels,
    bulkClearLabels,
    bulkDuplicate,
    bulkDelete,
    bulkComplete,
    bulkMove,
    create,
    update,
    discard,
    skip,
    resolveLabels,
    resolveProject,
    createProject,
    createLabel,
    labels,
    projects,
    sections: allSections.sections,
  };
}
