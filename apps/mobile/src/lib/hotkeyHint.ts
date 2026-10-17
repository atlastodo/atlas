import { Platform } from "react-native";
import { HOTKEY_BINDINGS, type HotkeyHandlers } from "@atlastodo/shared";

/**
 * A compact hint for an action's keyboard shortcut ("T", "Del", "Ctrl+D", "⌘D"), read from
 * `@atlastodo/shared`'s `HOTKEY_BINDINGS` so a menu's hints track the real bindings. `pick` chooses
 * which of a binding's display keys to show when it lists alternatives (Delete shows "⌫" and "Del").
 */
export function hotkeyHint(action: keyof HotkeyHandlers, pick?: string): string | undefined {
  const binding = HOTKEY_BINDINGS.find((b) => b.action === action);
  if (!binding) return undefined;
  if (binding.mod) {
    const key = binding.displayKeys.find((k) => k !== "Mod") ?? "";
    return isMac() ? `⌘${key}` : `Ctrl+${key}`;
  }
  return pick && binding.displayKeys.includes(pick) ? pick : binding.displayKeys[0];
}

function isMac(): boolean {
  return (
    Platform.OS === "web" &&
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/i.test(navigator.userAgent)
  );
}
