import { useEffect, useRef, type RefObject } from "react";
import type { ViewInstance } from "react-native";

/** Viewport coordinates of a right-click. */
export interface MenuPos {
  x: number;
  y: number;
}

/**
 * Desktop right-click context menu. react-native-web forwards a `View` ref to its DOM node, so this
 * attaches a `contextmenu` listener directly and calls `onOpen({x, y})` at the cursor, suppressing
 * the browser's menu. Native uses the no-op `useContextMenu.ts`. Returns the ref for the row's
 * outer `View`.
 */
export function useContextMenu(onOpen: (pos: MenuPos) => void): RefObject<ViewInstance | null> {
  const ref = useRef<ViewInstance | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      onOpenRef.current({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener("contextmenu", onContext);
    return () => el.removeEventListener("contextmenu", onContext);
  }, []);

  return ref;
}
