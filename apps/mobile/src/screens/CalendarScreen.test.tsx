import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { CalendarScreen } from "./CalendarScreen";

// Over a real in-memory `LocalStore`; layout maths is tested in `@atlastodo/shared`.

function storeWithTask(title: string) {
  const store = new LocalStore("test");
  // Due now, so it lands in the current month grid the screen opens on.
  const id = createTask(store, { title, due_at: Date.now() });
  return { store, id };
}

describe("CalendarScreen", () => {
  it("reschedules the picked task onto the tapped day", async () => {
    const { store, id } = storeWithTask("Dentist");
    const before = store.get("task", id)!.due_at as number;
    await render(<CalendarScreen />, { wrapper: withApp(store) });

    await fireEvent(screen.getAllByLabelText("Dentist")[0]!, "longPress");
    // The 15th is only ever an in-month cell (grid padding covers month edges, never mid-month),
    // so its label is unique.
    await fireEvent.press(screen.getByLabelText("15"));

    // Moving persists `due_at` to the end of the tapped day, so the banner clears and the stored
    // due date has actually changed off its original "now".
    expect(screen.queryByText(/Moving/)).toBeNull();
    expect(store.get("task", id)!.due_at).not.toBe(before);
  });

  it("shows dots instead of titled chips on a phone, leaving the titles to the agenda", async () => {
    const spy = jest
      .spyOn(
        jest.requireActual<typeof import("react-native")>("react-native"),
        "useWindowDimensions",
      )
      .mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    try {
      const { store } = storeWithTask("Dentist");
      await render(<CalendarScreen />, { wrapper: withApp(store) });

      // Only the agenda row names the task; the day cell counts it instead.
      expect(screen.getAllByLabelText("Dentist")).toHaveLength(1);
      expect(screen.getByLabelText(/^\d+, 1 task$/)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("hides week numbers when show_week_numbers is false", async () => {
    const { store } = storeWithTask("Dentist");
    store.set("preference", PREFERENCES_ID, "show_week_numbers", false);
    await render(<CalendarScreen />, { wrapper: withApp(store) });

    // Switch to week view
    await fireEvent.press(screen.getByLabelText("Week"));
    // Header should not contain week number
    expect(screen.queryByText(/· Week \d+/)).toBeNull();
  });

  it("reschedules a task to a specific time slot in week view", async () => {
    const { store, id } = storeWithTask("Dentist");
    await render(<CalendarScreen />, { wrapper: withApp(store) });

    // Switch to week view
    await fireEvent.press(screen.getByLabelText("Week"));

    // Long press task to pick it up
    await fireEvent(screen.getAllByLabelText("Dentist")[0]!, "longPress");
    expect(screen.getByText(/Moving/)).toBeTruthy();

    // Tap a specific slot on week timeline
    const slots = screen.getAllByLabelText(/\d+ \d+[:.]00/);
    expect(slots.length).toBeGreaterThan(0);
    await fireEvent.press(slots[0]!);

    // Banner clears and due_at is updated
    expect(screen.queryByText(/Moving/)).toBeNull();
    expect(store.get("task", id)?.due_at).toBeTruthy();
  });

  it("steps one month at a time in the preferred time zone, whatever the device's", async () => {
    // Samoa is west of any device clock this runs on, so a device-local midnight on the 1st is
    // still the previous month there.
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 15, 12));
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "timezone", "Pacific/Pago_Pago");
    await render(<CalendarScreen />, { wrapper: withApp(store) });

    expect(screen.getByText(/January 2026/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Next month"));
    expect(screen.getByText(/February 2026/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Next month"));
    expect(screen.getByText(/March 2026/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Previous month"));
    await fireEvent.press(screen.getByLabelText("Previous month"));
    expect(screen.getByText(/January 2026/)).toBeTruthy();
    now.mockRestore();
  });

  it("enters move mode on long-press, showing the move banner", async () => {
    await render(<CalendarScreen />, { wrapper: withApp(storeWithTask("Dentist").store) });
    await fireEvent(screen.getAllByLabelText("Dentist")[0]!, "longPress");
    expect(screen.getByText(/Moving/)).toBeTruthy();
  });
});
