import type { HotkeyHandlers } from "@atlastodo/shared";

/**
 * Keyboard shortcuts: a native no-op, since a phone or tablet has no hardware keyboard driving
 * these bindings. Metro resolves `useHotkeys.web.ts` for the browser.
 */
export function useHotkeys(_handlers: HotkeyHandlers): void {}
