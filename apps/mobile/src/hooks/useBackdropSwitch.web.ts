import { useEffect, useRef, type RefObject } from "react";
import type { ViewInstance } from "react-native";

/**
 * Makes a context menu's full-screen backdrop route a right-click to the row beneath it.
 *
 * The menu renders in a Modal whose backdrop covers the viewport, so a right-click meant for
 * another row would land on the backdrop and show the browser's default menu. A `contextmenu`
 * listener on the backdrop suppresses that, finds the element under the cursor (with the backdrop
 * momentarily click-through), closes the menu and re-dispatches the right-click there, so a row's
 * own listener opens its menu in one click; on empty space the menu just closes. Native uses the
 * no-op `useBackdropSwitch.ts`.
 *
 * Returns the ref to spread onto the backdrop `Pressable`.
 */
export function useBackdropSwitch(onClose: () => void): RefObject<ViewInstance | null> {
  const ref = useRef<ViewInstance | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null;
    if (!el) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const x = e.clientX;
      const y = e.clientY;
      const prev = el.style.pointerEvents;
      el.style.pointerEvents = "none";
      const target = document.elementFromPoint(x, y);
      el.style.pointerEvents = prev;
      // Same tick, so the menu switches in one step.
      onCloseRef.current();
      target?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    };
    el.addEventListener("contextmenu", onContext);
    return () => el.removeEventListener("contextmenu", onContext);
  }, []);

  return ref;
}
