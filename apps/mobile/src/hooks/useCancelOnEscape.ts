import { useRef } from "react";
import type { TextInputKeyPressEvent, TextInputInstance } from "react-native";

/**
 * Escape cancels what is being typed: it discards the draft and leaves the field. The companion to
 * keeping the caret in the field after Enter (`lib/submitBehavior`): a field that holds focus
 * between entries needs a way out that does not commit.
 *
 * No platform split: react-native-web routes `onKeyPress` to a DOM keydown, and native reports only
 * character keys, so the branch never fires on a phone. react-native-web's TextInput calls
 * `stopPropagation` on every key event, so this is the only place Escape can be handled while a
 * field has focus; the global hotkey layer never sees it.
 */

/** Whether a TextInput key event is Escape. For fields that own their own `onKeyPress`. */
export function isEscapeKey(e: TextInputKeyPressEvent): boolean {
  return e.nativeEvent.key === "Escape";
}

export interface CancelOnEscape {
  ref: React.RefObject<TextInputInstance | null>;
  onKeyPress: (e: TextInputKeyPressEvent) => void;
  /**
   * For a field that also commits on blur: true exactly once, for the blur the cancel itself
   * caused. That blur fires before React re-renders with the cleared draft, so without this the
   * commit-on-blur would save the text Escape discarded.
   */
  consume: () => boolean;
}

export function useCancelOnEscape(cancel: () => void): CancelOnEscape {
  const ref = useRef<TextInputInstance>(null);
  const cancelling = useRef(false);
  return {
    ref,
    onKeyPress: (e) => {
      if (!isEscapeKey(e)) return;
      cancelling.current = true;
      cancel();
      ref.current?.blur();
    },
    consume: () => {
      const was = cancelling.current;
      cancelling.current = false;
      return was;
    },
  };
}
