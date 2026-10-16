import { useRef, type RefObject } from "react";
import type { ViewInstance } from "react-native";

/** Viewport coordinates of a right-click. */
export interface MenuPos {
  x: number;
  y: number;
}

/**
 * Desktop right-click context menu: a native no-op, since right-click has no touch idiom (a phone
 * uses long-press/swipe). It attaches nothing and returns an unused ref. Metro resolves
 * `useContextMenu.web.ts` for the browser.
 */
export function useContextMenu(_onOpen: (pos: MenuPos) => void): RefObject<ViewInstance | null> {
  return useRef<ViewInstance | null>(null);
}
