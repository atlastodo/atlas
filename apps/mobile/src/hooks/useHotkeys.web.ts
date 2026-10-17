import { useEffect, useRef } from "react";
import { dispatchHotkey, type HotkeyHandlers } from "@atlastodo/shared";
import { isModalOpen } from "../lib/modalOpen";

/**
 * Keyboard shortcuts on web: one `window` `keydown` listener that routes each event through
 * `@atlastodo/shared`'s pure {@link dispatchHotkey}, which owns the binding table and its typing/modifier
 * guards. Native uses the no-op `useHotkeys.ts`.
 *
 * Handlers are read through a ref, so the listener subscribes once and callers can pass fresh
 * handlers each render.
 *
 * Nothing fires while a modal is open: the keys belong to the dialog on top, never the list
 * behind it, and Cmd-K would stack a second palette.
 */
export function useHotkeys(handlers: HotkeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isModalOpen()) return;
      const handled = dispatchHotkey(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          typing: isTyping(e.target),
        },
        ref.current,
      );
      if (handled) e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Whether focus is in a text-entry element, where global single-key shortcuts must not fire. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
