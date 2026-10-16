import { useRef, type RefObject } from "react";
import type { ViewInstance } from "react-native";

/**
 * Backdrop right-click routing: a native no-op, since native never opens the menu. Metro resolves
 * `useBackdropSwitch.web.ts` for the browser; the signatures match so `tsc` sees one shape.
 */
export function useBackdropSwitch(_onClose: () => void): RefObject<ViewInstance | null> {
  return useRef<ViewInstance | null>(null);
}
