import { useCallback, useMemo } from "react";
import {
  DEFAULT_FOLDER_ICON,
  DEFAULT_PROJECT_ICON,
  appendScheduleChange,
  defaultColorForIndex,
  habitSiblings,
  hiddenHabitIds,
  isTrashed,
  moveHabitTarget,
  reorderRank,
  softDelete,
  toHabit,
  type Habit,
  type HabitGoalKind,
  type HabitKind,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

export interface NewHabit {
  name: string;
  /** `"group"` makes a routine rather than a habit. */
  kind?: HabitKind;
  /** The group to create it in. Ignored for a group -- groups do not nest. */
  parent_id?: string | null;
  goal_kind?: HabitGoalKind;
  days?: number[];
  target?: number;
  color?: string;
  icon?: string;
  notes?: string;
  steps?: string[];
  reminder_time?: string | null;
}

/** The fields the UI may edit. `created_at`/`sort_order` are set on create and by reorder. */
export type HabitPatch = Partial<
  Pick<
    Habit,
    | "name"
    | "goal_kind"
    | "days"
    | "target"
    | "color"
    | "icon"
    | "notes"
    | "steps"
    | "unit"
    | "reminder_time"
  >
>;

export interface UseHabits {
  /** Real habits, groups excluded: a group has no schedule, check-ins or reminder. */
  habits: Habit[];
  /** Habit groups (routines). */
  habitGroups: Habit[];
  /** Archived habits and groups: out of the lists but never deleted, so history stays intact. */
  archivedHabits: Habit[];
  createHabit: (spec: NewHabit) => string;
  updateHabit: (id: string, patch: HabitPatch) => void;
  /** Archive or restore; returns a closure that puts it back. */
  setArchived: (id: string, archived: boolean) => () => void;
  /** Move a habit into a group, or out with `null`. Returns false when the move is refused. */
  moveHabit: (id: string, groupId: string | null) => boolean;
  /** Apply a resolved drop from the two-level list. */
  applyHabitDrop: (drop: { id: string; parent_id: string | null; sort_order: number }) => void;
  /** Move a top-level row among its siblings, for the group menu's Move up / Move down. */
  /** Nudge a habit or a group one place among its own siblings (the menu's Move up / Move down). */
  reorderSibling: (id: string, direction: "up" | "down") => void;
  /**
   * Soft-delete to Trash; returns a closure that restores it. Check-ins and, for a group, its
   * members are not cascaded, so restoring brings the whole routine and its history back.
   */
  removeHabit: (id: string) => () => void;
}

/**
 * Habits: `habit` entities in the shared store. The streak/schedule rules live in `@atlastodo/shared`.
 * Ids come from `store.newEntityId()`, never `crypto.randomUUID()` (Hermes has no global crypto,
 * and a non-UUID id makes the server 422 the whole `/sync/push` batch).
 */
export function useHabits(): UseHabits {
  const { store, version, kick } = useStore();

  const all = useMemo(() => {
    const rows = store.list("habit");
    // Fed raw store rows: `Habit` has no `deleted_at`, so the trashed flag only exists on the
    // stored fields. A member of an archived or trashed group hides with it.
    const hidden = hiddenHabitIds(
      rows.map((entity) => ({
        id: entity.id,
        parent_id: typeof entity.fields.parent_id === "string" ? entity.fields.parent_id : null,
        archived_at:
          typeof entity.fields.archived_at === "number" ? entity.fields.archived_at : null,
        deleted_at: isTrashed(entity.fields) ? 1 : null,
      })),
    );
    return rows
      .filter((entity) => !isTrashed(entity.fields))
      .map((entity) => toHabit(entity.id, entity.fields))
      .map((habit) => ({ habit, hidden: hidden.has(habit.id) }))
      .sort(
        (a, b) =>
          a.habit.sort_order - b.habit.sort_order || a.habit.created_at - b.habit.created_at,
      );
    // `version` is the store's change signal: it re-reads the mutable store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const visible = useMemo(() => all.filter((row) => !row.hidden).map((row) => row.habit), [all]);
  const habits = useMemo(() => visible.filter((habit) => habit.kind !== "group"), [visible]);
  const habitGroups = useMemo(() => visible.filter((habit) => habit.kind === "group"), [visible]);
  // Archived in its own right: a member hidden only by its group is restored with the group, so a
  // loose Restore in the Archive would do nothing.
  const archivedHabits = useMemo(
    () => all.map((row) => row.habit).filter((habit) => habit.archived_at !== null),
    [all],
  );

  const createHabit = useCallback(
    (spec: NewHabit) => {
      const id = store.newEntityId();
      const now = Date.now();
      // Read the count live, not off a memo, so back-to-back creates get distinct colours.
      const index = store.list("habit").length;
      store.set("habit", id, "name", spec.name);
      store.set("habit", id, "kind", spec.kind ?? "habit");
      store.set("habit", id, "parent_id", spec.kind === "group" ? null : (spec.parent_id ?? null));
      store.set("habit", id, "goal_kind", spec.goal_kind ?? "daily");
      store.set("habit", id, "days", spec.days ?? []);
      store.set("habit", id, "target", spec.target ?? 1);
      store.set("habit", id, "color", spec.color ?? defaultColorForIndex(index));
      // A `#` icon on a group reads as a habit; the group's StyleEditor already defaults to `folder`.
      store.set(
        "habit",
        id,
        "icon",
        spec.icon ?? (spec.kind === "group" ? DEFAULT_FOLDER_ICON : DEFAULT_PROJECT_ICON),
      );
      store.set("habit", id, "notes", spec.notes ?? "");
      store.set("habit", id, "steps", spec.steps ?? []);
      store.set("habit", id, "reminder_time", spec.reminder_time ?? null);
      store.set("habit", id, "archived_at", null);
      store.set("habit", id, "created_at", now);
      store.set("habit", id, "sort_order", now);
      kick();
      return id;
    },
    [store, kick],
  );

  const updateHabit = useCallback(
    (id: string, patch: HabitPatch) => {
      // Record the schedule change before writing the patch, so history stamps the schedule being
      // replaced. `appendScheduleChange` returns null for anything but a schedule change.
      const fields = store.get("habit", id);
      if (fields) {
        const history = appendScheduleChange(toHabit(id, fields), patch, Date.now());
        if (history) store.set("habit", id, "schedule_history", history);
      }
      for (const [field, value] of Object.entries(patch)) store.set("habit", id, field, value);
      kick();
    },
    [store, kick],
  );

  const setArchived = useCallback(
    (id: string, archived: boolean) => {
      const raw = store.get("habit", id)?.archived_at;
      const previous = typeof raw === "number" ? raw : null;
      store.set("habit", id, "archived_at", archived ? Date.now() : null);
      kick();
      return () => {
        store.set("habit", id, "archived_at", previous);
        kick();
      };
    },
    [store, kick],
  );

  const applyHabitDrop = useCallback(
    (drop: { id: string; parent_id: string | null; sort_order: number }) => {
      store.set("habit", drop.id, "parent_id", drop.parent_id);
      store.set("habit", drop.id, "sort_order", drop.sort_order);
      kick();
    },
    [store, kick],
  );

  const moveHabit = useCallback(
    (id: string, groupId: string | null) => {
      const drop = moveHabitTarget(visible, id, groupId);
      if (!drop) return false;
      applyHabitDrop(drop);
      return true;
    },
    [visible, applyHabitDrop],
  );

  const reorderSibling = useCallback(
    (id: string, direction: "up" | "down") => {
      const habit = visible.find((h) => h.id === id);
      if (!habit) return;
      // Ranked against siblings, not rendered rows: a group's members are not its neighbours.
      // `habitSiblings` is the rule a drop resolves against too.
      const siblings = habitSiblings(visible, habit);
      const from = siblings.findIndex((h) => h.id === id);
      if (from === -1) return;
      const moved = reorderRank(siblings, from, direction === "up" ? from - 1 : from + 1);
      if (!moved) return;
      for (const w of moved.writes) store.set("habit", w.id, "sort_order", w.sort_order);
      kick();
    },
    [visible, store, kick],
  );

  const removeHabit = useCallback(
    (id: string) => softDelete(store, kick, "habit", id),
    [store, kick],
  );

  return {
    habits,
    habitGroups,
    archivedHabits,
    createHabit,
    updateHabit,
    setArchived,
    moveHabit,
    applyHabitDrop,
    reorderSibling,
    removeHabit,
  };
}
