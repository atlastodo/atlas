import { useMemo, useRef } from "react";
import type { ViewProps } from "react-native";
import { Gesture, type PanGesture } from "react-native-gesture-handler";
import { useSelectionRow } from "../data/SelectionProvider";

/** The pointer props (+ hit-test marker) a row spreads to become paintable. Empty on native. */
export type PaintHandlers = Pick<ViewProps, "onPointerDown" | "onPointerEnter" | "dataSet">;

/**
 * Click-drag "paint" selection: a native row-level no-op. Metro resolves `usePaintHandlers.web.ts`
 * for the desktop browser.
 */
export function usePaintHandlers(_id: string, _selectMode = false): PaintHandlers {
  return {};
}

/**
 * Mobile drag-selection over the checkbox column: in select mode, dragging vertically along it
 * activates a `Gesture.Pan()` that wins over ScrollView scrolling and selects or deselects rows live.
 */
export function useCheckboxPaintGesture(id: string, selectMode = false): PanGesture {
  const sel = useSelectionRow();
  const selRef = useRef(sel);
  selRef.current = sel;

  return useMemo(() => {
    return Gesture.Pan()
      .runOnJS(true)
      .enabled(selectMode)
      .activeOffsetY([-5, 5])
      .shouldCancelWhenOutside(false)
      .onStart(() => {
        selRef.current?.paintBegin(id);
      })
      .onUpdate((e) => {
        selRef.current?.paintMove(e.translationY);
      })
      .onEnd(() => {
        selRef.current?.paintEnd();
      })
      .onFinalize(() => {
        selRef.current?.paintEnd();
      });
  }, [id, selectMode]);
}
