import { fireEvent, render, screen } from "@testing-library/react-native";
import { ShortcutsModal } from "./ShortcutsHelp";

/** The modal's ways out; the table is data-driven from `@atlastodo/shared`'s `HOTKEY_BINDINGS`. */

describe("ShortcutsHelp", () => {
  it("renders nothing when closed", async () => {
    await render(<ShortcutsModal visible={false} onClose={() => {}} />);
    expect(screen.queryByText("Keyboard Shortcuts")).toBeNull();
  });

  it("closes from both close affordances (backdrop and header button)", async () => {
    const onClose = jest.fn();
    await render(<ShortcutsModal visible onClose={onClose} />);
    const closes = screen.getAllByLabelText("Close");
    expect(closes.length).toBe(2);
    await fireEvent.press(closes[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
    await fireEvent.press(closes[1]!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
