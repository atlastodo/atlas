import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_FOCUS_CORNER, isFocusCorner, type FocusCorner } from "@atlastodo/shared";

/**
 * Which corner the floating focus bar is parked in: device-local, not synced. Where the bar is out
 * of the way is a fact about the screen in front of you (a phone has an add button and a nav bar, a
 * desktop window has neither), so syncing it would untidy one device when tidying another. It uses
 * AsyncStorage, like the running timer in `FocusProvider`. The read is async, so the first render
 * uses {@link DEFAULT_FOCUS_CORNER} and the stored value lands a tick later.
 */
const FOCUS_CORNER_KEY = "atlas.focusCorner";

export interface UseFocusCorner {
  corner: FocusCorner;
  setCorner: (corner: FocusCorner) => void;
}

export function useFocusCorner(): UseFocusCorner {
  const [corner, setCornerState] = useState<FocusCorner>(DEFAULT_FOCUS_CORNER);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(FOCUS_CORNER_KEY)
      // Unreadable storage keeps the default; an uncaught rejection would be filed as a crash.
      .catch(() => null)
      .then((raw) => {
        // A corner from a newer build, or a half-written value, falls back to the default.
        if (!cancelled && isFocusCorner(raw)) setCornerState(raw);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCorner = useCallback((next: FocusCorner) => {
    setCornerState(next);
    // Fire-and-forget: failing to remember a corner is not worth a crash report.
    AsyncStorage.setItem(FOCUS_CORNER_KEY, next).catch(() => {});
  }, []);

  return { corner, setCorner };
}
