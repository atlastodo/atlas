import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask, toTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { UpcomingScreen } from "./UpcomingScreen";

// Over a real in-memory `LocalStore`; upcoming/grouping logic is tested in `@atlastodo/shared`.

const DAY = 86_400_000;

function storeWith(entries: Array<{ title: string; dueIn: number }>) {
  const store = new LocalStore("test");
  for (const { title, dueIn } of entries) {
    createTask(store, { title, due_at: Date.now() + dueIn });
  }
  return store;
}

const tasks = (store: LocalStore) => store.list("task").map((e) => toTask(e.id, e.fields));
const taskNamed = (store: LocalStore, title: string) => tasks(store).find((t) => t.title === title);

/** Enter multi-select as a phone does: the toolbar's Select button turns on select mode, then a tap on a row selects it. */
async function startSelectionOn(title: string) {
  await fireEvent.press(screen.getByLabelText("Select"));
  await fireEvent.press(screen.getByText(title));
}

describe("UpcomingScreen", () => {
  it("collapses a day group, keeping its count", async () => {
    const store = storeWith([{ title: "Call the dentist", dueIn: DAY }]);
    await render(<UpcomingScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Tomorrow (1)"));
    expect(screen.queryByText("Call the dentist")).toBeNull();
    // The count stays: a folded group reading "(0)" would look like a problem rather than a fold.
    expect(screen.getByLabelText("Tomorrow (1)")).toBeTruthy();
  });

  it("stores a grouping choice, so it syncs", async () => {
    const store = storeWith([{ title: "Call the dentist", dueIn: DAY }]);
    await render(<UpcomingScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("List options"));
    // Qualified: "Priority" is both a grouping and a sort in this sheet.
    await fireEvent.press(screen.getByLabelText("Group: Priority"));

    const prefs = store.get("preference", PREFERENCES_ID) ?? {};
    expect(prefs.list_prefs).toEqual({ upcoming: { group: "priority", sort: "manual" } });
  });

  it("adds a task due tomorrow, so it lands in this view", async () => {
    // A task added to Upcoming that landed on *today* would vanish from the list you added it to.
    const store = storeWith([]);
    await render(<UpcomingScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Add"));
    await fireEvent.changeText(screen.getByLabelText("Add a task"), "Call the dentist");
    await fireEvent(screen.getByLabelText("Add a task"), "submitEditing");

    expect(screen.getByText("Call the dentist")).toBeTruthy();
  });
});

describe("UpcomingScreen multi-select", () => {
  async function mountTwo() {
    const store = storeWith([
      { title: "Call the dentist", dueIn: DAY },
      { title: "Book the flight", dueIn: 2 * DAY },
    ]);
    await render(<UpcomingScreen />, { wrapper: withApp(store) });
    return store;
  }

  it("tapping a row in select mode selects rather than opens", async () => {
    const onOpen = jest.fn();
    const store = storeWith([{ title: "Call the dentist", dueIn: DAY }]);
    await render(<UpcomingScreen onOpenTask={onOpen} />, { wrapper: withApp(store) });

    await startSelectionOn("Call the dentist");
    await fireEvent.press(screen.getByText("Call the dentist"));

    // Opening a task mid-selection would throw away the selection you were building.
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("bulk-completes the selection", async () => {
    const store = await mountTwo();
    await startSelectionOn("Call the dentist");
    await fireEvent(screen.getByText("Book the flight"), "press");
    expect(screen.getByText("2 selected")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Complete task"));

    expect(taskNamed(store, "Call the dentist")?.is_completed).toBe(true);
    expect(taskNamed(store, "Book the flight")?.is_completed).toBe(true);
    // Select mode stays on after a bulk action so several actions can run in a row -- the toolbar
    // remains until the user explicitly exits (the old behaviour cleared it here).
    expect(screen.getByLabelText("Selection actions")).toBeTruthy();
  });

  it("bulk-deletes to the trash, not to a tombstone", async () => {
    const store = await mountTwo();
    await startSelectionOn("Call the dentist");

    await fireEvent.press(screen.getByLabelText("Delete"));

    // A soft delete, so Recently Deleted can still restore it.
    expect(taskNamed(store, "Call the dentist")?.deleted_at).not.toBeNull();
    expect(screen.queryByText("Call the dentist")).toBeNull();
  });

  it("clearing leaves select mode", async () => {
    await mountTwo();
    await startSelectionOn("Call the dentist");
    await fireEvent.press(screen.getByLabelText("Exit selection"));

    expect(screen.queryByLabelText("Selection actions")).toBeNull();
    // Back to normal rows: the completion control is a toggle again, not a checkbox.
    expect(screen.getAllByLabelText("Complete task").length).toBeGreaterThan(0);
  });

  it("keeps the selection when a background sync changes the store", async () => {
    // Repro for "Ctrl+A selects everything for a second then deselects": a periodic sync bumps the
    // store version and re-derives the list; the selection must survive that re-render.
    const store = await mountTwo();
    await startSelectionOn("Call the dentist");
    await fireEvent.press(screen.getByLabelText("Select all"));
    expect(screen.getByText("2 selected")).toBeTruthy();

    // A sync arrives: an unrelated task lands, bumping the version and re-running the list derivation.
    await act(() => {
      createTask(store, { title: "New from another device", due_at: Date.now() + 3 * DAY });
    });
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("select-all skips the rows in a collapsed group", async () => {
    // You cannot see a collapsed group's rows, so "select all" must not silently pick them -- a
    // following bulk action would then hit tasks you never saw.
    const store = storeWith([
      { title: "Call the dentist", dueIn: DAY },
      { title: "Book the flight", dueIn: 2 * DAY },
    ]);
    await render(<UpcomingScreen />, { wrapper: withApp(store) });

    // Upcoming groups by day; fold tomorrow's group away, then start a selection on the other.
    await fireEvent.press(screen.getByLabelText("Tomorrow (1)"));
    await startSelectionOn("Book the flight");
    await fireEvent.press(screen.getByLabelText("Select all"));

    // Only the still-visible task is selected, not the folded-away one.
    expect(screen.getByText("1 selected")).toBeTruthy();
  });

  it("keeps the selection when a sync edits one of the selected tasks", async () => {
    const store = await mountTwo();
    await startSelectionOn("Call the dentist");
    await fireEvent.press(screen.getByLabelText("Select all"));
    expect(screen.getByText("2 selected")).toBeTruthy();

    // A remote edit to a selected task (a new object identity, same id) must not drop it.
    const target = taskNamed(store, "Call the dentist")!;
    await act(() => {
      createTask(store, { title: "unrelated", due_at: Date.now() + 4 * DAY });
      store.set("task", target.id, "priority", 1);
    });
    expect(screen.getByText("2 selected")).toBeTruthy();
  });
});
