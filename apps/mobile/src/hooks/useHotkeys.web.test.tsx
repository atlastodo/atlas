/**
 * @jest-environment jsdom
 */
import { render } from "@testing-library/react-native";
import { View } from "react-native";
import type { HotkeyHandlers } from "@atlastodo/shared";
import { useHotkeys } from "./useHotkeys.web";

/**
 * The web keyboard layer. jsdom gives real `window`/`KeyboardEvent`, so this drives the DOM
 * wiring end-to-end (the binding decisions themselves are proven in `@atlastodo/shared`'s `hotkeys.test`).
 */
function Harness({ handlers }: { handlers: HotkeyHandlers }) {
  useHotkeys(handlers);
  return <View />;
}

describe("useHotkeys.web", () => {
  it("opens the palette on a Cmd-K keydown and prevents default", async () => {
    const openPalette = jest.fn();
    await render(<Harness handlers={{ openPalette }} />);
    const event = new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(openPalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not fire single-key shortcuts while typing in a text field", async () => {
    const focusQuickAdd = jest.fn();
    await render(<Harness handlers={{ focusQuickAdd }} />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    expect(focusQuickAdd).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("removes its listener on unmount", async () => {
    const openPalette = jest.fn();
    const { unmount } = await render(<Harness handlers={{ openPalette }} />);
    await unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    expect(openPalette).not.toHaveBeenCalled();
  });

  it("fires nothing while a modal is open over the page", async () => {
    // react-native-web marks an open Modal with aria-modal; the keys are the dialog's then.
    const completeCursor = jest.fn();
    const openPalette = jest.fn();
    await render(<Harness handlers={{ completeCursor, openPalette }} />);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    expect(completeCursor).not.toHaveBeenCalled();
    expect(openPalette).not.toHaveBeenCalled();

    document.body.removeChild(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
    expect(completeCursor).toHaveBeenCalledTimes(1);
  });
});
