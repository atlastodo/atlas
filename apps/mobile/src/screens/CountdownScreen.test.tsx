import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { CountdownScreen } from "./CountdownScreen";

// A Wednesday afternoon, so "the weekend" is a couple of days out.
const NOW = new Date(2026, 5, 17, 15, 0, 0).getTime();

describe("CountdownScreen", () => {
  it("enables a preset when its chip is tapped", async () => {
    await render(<CountdownScreen now={NOW} />, { wrapper: withApp(new LocalStore("test")) });

    expect(screen.getByText("No countdowns yet")).toBeTruthy();

    // Only the chip carries this label until a card exists, so this press is unambiguous.
    await fireEvent.press(screen.getByLabelText("The weekend"));

    // A card appeared (it has the remove control) and the empty state is gone.
    expect(screen.getByLabelText("Remove preset")).toBeTruthy();
    expect(screen.queryByText("No countdowns yet")).toBeNull();
  });
});
