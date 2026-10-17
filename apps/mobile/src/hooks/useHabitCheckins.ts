import { useCallback, useMemo } from "react";
import {
  derivedUuidV2,
  toHabitCheckin,
  type CheckinState,
  type HabitCheckin,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

/** The three states a day can be put into; `null` clears it back to "no data". */
export type DayState = CheckinState | null;

export interface UseHabitCheckins {
  /** Recorded days, habit id -> date key -> state. Built once per store change. */
  index: Map<string, Map<string, CheckinState>>;
  statesFor: (habitId: string) => Map<string, CheckinState>;
  stateFor: (habitId: string, date: string) => CheckinState | undefined;
  checkinFor: (habitId: string, date: string) => HabitCheckin | undefined;
  /** Set a day's state (or clear it); returns a closure restoring exactly what was there. */
  setState: (habitId: string, date: string, next: DayState) => () => void;
  /** Advance a day: clear -> done -> skip -> clear. */
  cycle: (habitId: string, date: string) => { next: DayState; undo: () => void };
  /** Attach a note to an already-recorded day. No-op on a day with no check-in. */
  setNote: (habitId: string, date: string, note: string) => void;
}

/** The composite key a (habit, day) pair is stored under. NUL cannot occur in either part. */
const dayKey = (habitId: string, date: string) => `${habitId}\0${date}`;

const EMPTY: Map<string, CheckinState> = new Map();

/**
 * Habit check-ins for the phone: one `habit_checkin` entity per habit per day.
 *
 * Two load-bearing choices:
 *
 * - Reads go through a `habit -> date -> state` map built once per store change, not a table scan
 *   per habit per render.
 * - A new row's id is derived from `(habit_id, date)`, so two devices ticking the same day offline
 *   converge on one row. Lookups go through the index, not the recomputed id, so rows with older
 *   ids (random, or the weaker `derivedUuidV1`) still resolve, and writing a day collapses any
 *   duplicates it finds.
 */
export function useHabitCheckins(): UseHabitCheckins {
  const { store, version, kick } = useStore();

  const { index, rows } = useMemo(() => {
    const index = new Map<string, Map<string, CheckinState>>();
    // Every row for a day: it may carry duplicates from before derived ids.
    const rows = new Map<string, HabitCheckin[]>();
    for (const entity of store.list("habit_checkin")) {
      const checkin = toHabitCheckin(entity.id, entity.fields);
      if (!checkin.habit_id || !checkin.date) continue;

      const key = dayKey(checkin.habit_id, checkin.date);
      const list = rows.get(key);
      if (list) list.push(checkin);
      else rows.set(key, [checkin]);

      let perHabit = index.get(checkin.habit_id);
      if (!perHabit) {
        perHabit = new Map();
        index.set(checkin.habit_id, perHabit);
      }
      // If duplicates disagree, a completion wins.
      const seen = perHabit.get(checkin.date);
      perHabit.set(
        checkin.date,
        seen === "done" || checkin.state === "done" ? "done" : checkin.state,
      );
    }
    return { index, rows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const statesFor = useCallback((habitId: string) => index.get(habitId) ?? EMPTY, [index]);

  const stateFor = useCallback(
    (habitId: string, date: string) => index.get(habitId)?.get(date),
    [index],
  );

  const checkinFor = useCallback(
    (habitId: string, date: string) => rows.get(dayKey(habitId, date))?.[0],
    [rows],
  );

  const setState = useCallback(
    (habitId: string, date: string, next: DayState) => {
      const existing = rows.get(dayKey(habitId, date)) ?? [];
      // Captured before writing, for the undo.
      const before = existing.map((c) => ({ ...c }));
      const newId = derivedUuidV2("habit_checkin", dayKey(habitId, date));

      if (next === null) {
        for (const checkin of existing) store.remove("habit_checkin", checkin.id);
      } else if (existing.length > 0) {
        // Keep one row and tombstone the rest, so a duplicated day converges from here on.
        const [keep, ...duplicates] = existing;
        store.set("habit_checkin", keep!.id, "state", next);
        for (const checkin of duplicates) store.remove("habit_checkin", checkin.id);
      } else {
        store.set("habit_checkin", newId, "habit_id", habitId);
        store.set("habit_checkin", newId, "date", date);
        store.set("habit_checkin", newId, "state", next);
        store.set("habit_checkin", newId, "value", 1);
        store.set("habit_checkin", newId, "created_at", Date.now());
      }
      kick();

      return () => {
        if (before.length === 0) {
          // Nothing was there, so undoing means removing the row we just created.
          store.remove("habit_checkin", newId);
        } else {
          // Re-setting the fields with a fresh HLC beats the tombstone, so a removed row comes back.
          for (const checkin of before) {
            store.set("habit_checkin", checkin.id, "habit_id", checkin.habit_id);
            store.set("habit_checkin", checkin.id, "date", checkin.date);
            store.set("habit_checkin", checkin.id, "state", checkin.state);
            store.set("habit_checkin", checkin.id, "value", checkin.value);
            store.set("habit_checkin", checkin.id, "note", checkin.note);
            store.set("habit_checkin", checkin.id, "created_at", checkin.created_at);
          }
        }
        kick();
      };
    },
    [rows, store, kick],
  );

  const cycle = useCallback(
    (habitId: string, date: string) => {
      const current = index.get(habitId)?.get(date);
      // clear -> done -> skip -> clear, so a mis-tap can always return to "no data".
      const next: DayState = current === undefined ? "done" : current === "done" ? "skip" : null;
      return { next, undo: setState(habitId, date, next) };
    },
    [index, setState],
  );

  const setNote = useCallback(
    (habitId: string, date: string, note: string) => {
      const existing = rows.get(dayKey(habitId, date)) ?? [];
      if (existing.length === 0) return;
      store.set("habit_checkin", existing[0]!.id, "note", note);
      kick();
    },
    [rows, store, kick],
  );

  return { index, statesFor, stateFor, checkinFor, setState, cycle, setNote };
}
