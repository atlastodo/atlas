import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  const wrapper = withApp(new LocalStore("test"));

  it("calls onValueChange when pressed", async () => {
    const onValueChange = jest.fn();
    await render(<Toggle label="Test Toggle" value={false} onValueChange={onValueChange} />, {
      wrapper,
    });

    const toggle = screen.getByRole("switch");
    await fireEvent.press(toggle);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });
});
