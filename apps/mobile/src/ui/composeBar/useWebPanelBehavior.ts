import { useEffect, useRef } from "react";
import { Platform, type ViewInstance } from "react-native";

/**
 * Web only: focus moves into a newly opened panel (not the quick-add title field), and Escape
 * closes the panel rather than the whole draft. Inputs inside keep their own Escape handling:
 * react-native-web stops their key events before the window.
 */
export function useWebPanelBehavior(panel: string | null, cancel: () => void) {
  const panelRef = useRef<ViewInstance>(null);

  useEffect(() => {
    if (Platform.OS !== "web" || panel === null) return;
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [panel]);

  useEffect(() => {
    if (Platform.OS !== "web" || panel === null) return;
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, cancel]);

  return panelRef;
}
