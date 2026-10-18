import { useCallback, useMemo } from "react";
import {
  DEFAULT_POMODORO,
  PREFERENCES_ID as PREF_ID,
  type PomodoroConfig,
} from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

export interface UsePomodoroConfig {
  config: PomodoroConfig;
  setConfig: (patch: Partial<PomodoroConfig>) => void;
}

/** Preference field name for each config value. */
const FIELDS: Record<keyof PomodoroConfig, string> = {
  workMin: "pomodoro_work_min",
  shortBreakMin: "pomodoro_short_break_min",
  longBreakMin: "pomodoro_long_break_min",
  longBreakEvery: "pomodoro_long_break_every",
};

/**
 * Pomodoro lengths and cadence, persisted on the shared preference entity so they sync across
 * devices. The timer that consumes this lives in the focus screen; settings only sets it.
 */
export function usePomodoroConfig(): UsePomodoroConfig {
  const { store, version, kick } = useStore();

  const config = useMemo<PomodoroConfig>(() => {
    const prefs = store.get("preference", PREF_ID) ?? {};
    // A non-positive length would be a phase that never runs; do not trust the wire.
    const read = (key: keyof PomodoroConfig) => {
      const v = prefs[FIELDS[key]];
      return typeof v === "number" && v > 0 ? v : DEFAULT_POMODORO[key];
    };
    return {
      workMin: read("workMin"),
      shortBreakMin: read("shortBreakMin"),
      longBreakMin: read("longBreakMin"),
      longBreakEvery: read("longBreakEvery"),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const setConfig = useCallback(
    (patch: Partial<PomodoroConfig>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (typeof value === "number" && value > 0) {
          store.set("preference", PREF_ID, FIELDS[key as keyof PomodoroConfig], value);
        }
      }
      kick();
    },
    [store, kick],
  );

  return { config, setConfig };
}
