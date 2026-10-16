import type { ViewProps } from "react-native";
import { useSelectionRow } from "../data/SelectionProvider";

/** The pointer props (+ a hit-test marker) a row spreads to become paintable. */
export type PaintHandlers = Pick<ViewProps, "onPointerDown" | "onPointerEnter" | "dataSet">;

/**
 * Click-drag "paint" selection on web: in select mode, pressing a row and dragging across others
 * selects (or deselects) the swath. react-native-web maps `onPointerDown` on a `View` to a DOM
 * pointer event, which anchors the paint (`paintBegin`). The drag itself is driven by the
 * provider's document-level `pointermove` hit-test, not per-row `onPointerEnter`, because the row's
 * `GestureDetector` captures the pointer on the anchor. The `dataSet` marker (`data-atlas-row`) maps
 * the element under the cursor back to a task id; `onPointerEnter` is kept as a fallback. Metro
 * resolves this over the native no-op `usePaintHandlers.ts`.
 *
 * Handlers are wired only in select mode (`selectMode`, the row's prop), so a normal click is
 * untouched. `useSelectionRow` returns null without a provider, so the row still mounts in
 * isolation (with no handlers).
 */
export function usePaintHandlers(id: string, selectMode = false): PaintHandlers {
  const sel = useSelectionRow();
  if (!sel || !selectMode) return {};
  return {
    onPointerDown: () => sel.paintBegin(id),
    onPointerEnter: () => sel.paintOver(id),
    dataSet: { atlasRow: id },
  };
}

import { Gesture, type LegacyPanGesture } from "react-native-gesture-handler";

/** Web uses full-row pointer handlers; the checkbox paint gesture is a no-op on web. */
export function useCheckboxPaintGesture(_id: string, _selectMode = false): LegacyPanGesture {
  return Gesture.Pan().enabled(false);
}
