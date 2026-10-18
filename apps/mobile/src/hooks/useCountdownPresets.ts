import { useCallback, useMemo } from "react";
import { PREFERENCES_ID as PREF_ID, type CountdownPresetId } from "@atlastodo/shared";
import { useStore } from "../data/StoreProvider";

const PRESETS_FIELD = "default_countdowns";

export interface UseCountdownPresets {
  /** Enabled synthetic-countdown preset ids (e.g. weekend, month end), in enable order. */
  enabled: CountdownPresetId[];
  isEnabled: (id: CountdownPresetId) => boolean;
  toggle: (id: CountdownPresetId) => void;
}

/**
 * Which synthetic countdown presets the user has enabled, persisted as the `default_countdowns`
 * array on the shared preference entity so they sync across devices.
 */
export function useCountdownPresets(): UseCountdownPresets {
  const { store, version, kick } = useStore();

  const enabled = useMemo(() => {
    const prefs = store.get("preference", PREF_ID) ?? {};
    const raw = prefs[PRESETS_FIELD];
    return Array.isArray(raw)
      ? (raw.filter((x): x is CountdownPresetId => typeof x === "string") as CountdownPresetId[])
      : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, version]);

  const isEnabled = useCallback((id: CountdownPresetId) => enabled.includes(id), [enabled]);

  const toggle = useCallback(
    (id: CountdownPresetId) => {
      const next = enabled.includes(id) ? enabled.filter((x) => x !== id) : [...enabled, id];
      store.set("preference", PREF_ID, PRESETS_FIELD, next);
      kick();
    },
    [enabled, store, kick],
  );

  return { enabled, isEnabled, toggle };
}
