import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask, endOfDay } from "@atlastodo/shared";
import { laterToday, withApp } from "../testutil";
import { TodayScreen } from "./TodayScreen";

// Over a real in-memory `LocalStore`; the overdue/today split is tested in `@atlastodo/shared`.

const DAY = 86_400_000;

/** A store holding tasks due at the given offsets from now (in ms). */
function storeWith(entries: Array<{ title: string; dueIn: number }>) {
  const store = new LocalStore("test");
  for (const { title, dueIn } of entries) {
    const due_at = dueIn === 0 ? laterToday() : Date.now() + dueIn;
    createTask(store, { title, due_at: due_at });
  }
  return store;
}

describe("TodayScreen", () => {
  it("reschedules all overdue tasks to today from the group header", async () => {
    const store = storeWith([
      { title: "Pay the rent", dueIn: -2 * DAY },
      { title: "Return the book", dueIn: -3 * DAY },
      { title: "Buy milk", dueIn: 0 },
    ]);
    await render(<TodayScreen />, { wrapper: withApp(store) });

    expect(screen.getByLabelText("Overdue (2)")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Reschedule all to today"));

    // The overdue tasks are now due today, so the Overdue group is gone and they stay in the view.
    expect(screen.queryByLabelText(/^Overdue/)).toBeNull();
    expect(screen.getByText("Pay the rent")).toBeTruthy();
    expect(screen.getByText("Return the book")).toBeTruthy();
  });

  it("collapses the overdue group, keeping its count visible", async () => {
    const store = storeWith([
      { title: "Pay the rent", dueIn: -2 * DAY },
      { title: "Buy milk", dueIn: 0 },
    ]);
    await render(<TodayScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Overdue (1)"));

    expect(screen.queryByText("Pay the rent")).toBeNull();
    // Collapsing hides the rows, not the fact that they exist.
    expect(screen.getByLabelText("Overdue (1)")).toBeTruthy();
    // ...and it must not disturb today's tasks.
    expect(screen.getByText("Buy milk")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Overdue (1)"));
    expect(screen.getByText("Pay the rent")).toBeTruthy();
  });

  it("does not claim there is nothing to do when overdue is merely collapsed", async () => {
    const store = storeWith([{ title: "Pay the rent", dueIn: -2 * DAY }]);
    await render(<TodayScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Overdue (1)"));

    // Every row is hidden, but the day is not empty -- the empty state would be a lie.
    expect(screen.queryByText(/No tasks here/)).toBeNull();
  });

  it("completing a task drops it out of the list", async () => {
    const store = storeWith([{ title: "Buy milk", dueIn: 0 }]);
    await render(<TodayScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Complete task"));

    // Today lists what is still to do; a completed task has left the view.
    expect(screen.queryByText("Buy milk")).toBeNull();
  });

  it("adds a task due today, so it appears in this view", async () => {
    const store = new LocalStore("test");
    await render(<TodayScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Add"));
    const field = screen.getByLabelText("Add a task");
    await fireEvent.changeText(field, "Water the plants");
    await fireEvent(field, "submitEditing");

    // The view's default due date is what makes a task added here actually land here.
    expect(screen.getByText("Water the plants")).toBeTruthy();
  });

  describe("plan day", () => {
    it("opens the guided review from the toolbar, proposing overdue first", async () => {
      const store = storeWith([
        { title: "Pay the rent", dueIn: -2 * DAY },
        { title: "Buy milk", dueIn: 0 },
      ]);
      await render(<TodayScreen />, { wrapper: withApp(store) });

      await fireEvent.press(screen.getByLabelText("Plan day"));

      expect(screen.getByText("Plan your day")).toBeTruthy();
      expect(screen.getByText("2 tasks to review")).toBeTruthy();
      // The rows are in the sheet; the same titles also sit in the list behind the modal.
      expect(screen.getAllByText("Pay the rent").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Buy milk").length).toBeGreaterThan(0);
      // The overdue row is called out as such.
      expect(screen.getByText(/^Overdue, /)).toBeTruthy();
    });

    it("applies the pass through the real store path, with the undoable toast", async () => {
      const store = new LocalStore("test");
      const overdueDue = Date.now() - 2 * DAY;
      const rentId = createTask(store, { title: "Pay the rent", due_at: overdueDue });
      createTask(store, { title: "Buy milk", due_at: laterToday() });
      await render(<TodayScreen />, { wrapper: withApp(store) });

      await fireEvent.press(screen.getByLabelText("Plan day"));
      await fireEvent.press(screen.getByLabelText("Postpone: Pay the rent"));
      await fireEvent.press(screen.getByLabelText("Apply changes"));

      // The sheet closed, the write landed (same `due_at` op a quick-reschedule makes), and the
      // postponed task has left Today's list -- it is due tomorrow now.
      expect(screen.queryByText("Plan your day")).toBeNull();
      expect(store.get("task", rentId)!.due_at).toBe(endOfDay(Date.now() + DAY));
      expect(screen.queryByLabelText(/^Overdue/)).toBeNull();
      expect(screen.queryByText("Pay the rent")).toBeNull();
      expect(screen.getByText("Buy milk")).toBeTruthy();
      // ... and the standard undo toast offers the way back.
      expect(screen.getByText("Rescheduled 1 task")).toBeTruthy();
      await fireEvent.press(screen.getByLabelText("Undo"));
      expect(store.get("task", rentId)!.due_at).toBe(overdueDue);
    });

    it("starts from an empty state on a clear day, still offering the upcoming picker", async () => {
      const store = new LocalStore("test");
      await render(<TodayScreen />, { wrapper: withApp(store) });

      await fireEvent.press(screen.getByLabelText("Plan day"));
      expect(screen.getByText("Nothing to plan")).toBeTruthy();

      await fireEvent.press(screen.getByText("Add from upcoming"));
      expect(screen.getByText("Next 7 days")).toBeTruthy();
      expect(screen.getByText("Nothing due in the next 7 days")).toBeTruthy();
    });

    it("pulls an upcoming task into today when the pass keeps it", async () => {
      const store = new LocalStore("test");
      const laundryDue = Date.now() + 2 * DAY;
      const laundryId = createTask(store, { title: "Laundry", due_at: laundryDue });
      await render(<TodayScreen />, { wrapper: withApp(store) });

      await fireEvent.press(screen.getByLabelText("Plan day"));
      expect(screen.getByText("Nothing to plan")).toBeTruthy();
      await fireEvent.press(screen.getByText("Add from upcoming"));
      await fireEvent.press(screen.getByLabelText("Add from upcoming: Laundry"));
      await fireEvent.press(screen.getByLabelText("Apply changes"));

      // Keeping a pulled-in task is the real date change: onto today's list (end of day).
      expect(store.get("task", laundryId)!.due_at).toBe(endOfDay(Date.now()));
      expect(screen.getByText("Laundry")).toBeTruthy();
    });

    it("keeps the picker to the next 7 days", async () => {
      const store = new LocalStore("test");
      createTask(store, { title: "Laundry", due_at: Date.now() + 2 * DAY });
      createTask(store, { title: "Next month's report", due_at: Date.now() + 12 * DAY });
      await render(<TodayScreen />, { wrapper: withApp(store) });

      await fireEvent.press(screen.getByLabelText("Plan day"));
      await fireEvent.press(screen.getByText("Add from upcoming"));

      expect(screen.getByText("Laundry")).toBeTruthy();
      expect(screen.queryByText("Next month's report")).toBeNull();
    });
  });
});
