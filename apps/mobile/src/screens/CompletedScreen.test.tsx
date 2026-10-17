import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { CompletedScreen } from "./CompletedScreen";

/**
 * Over a real in-memory `LocalStore`. The completion-recency buckets are `@atlastodo/shared`'s
 * `groupTasks(..., "completed")` (tested there); these assert this screen renders those buckets and
 * that the search box narrows the list.
 */
const DAY = 86_400_000;

/** A completed task titled `title`, completed `daysAgo` days ago. */
function addCompleted(store: LocalStore, title: string, daysAgo: number) {
  const id = createTask(store, { title });
  store.set("task", id, "is_completed", true);
  store.set("task", id, "completed_at", Date.now() - daysAgo * DAY);
  return id;
}

describe("CompletedScreen", () => {
  it("groups completed tasks by when they were completed", async () => {
    const store = new LocalStore("test");
    addCompleted(store, "Painted the fence", 1);
    addCompleted(store, "Filed taxes", 40);
    await render(<CompletedScreen />, { wrapper: withApp(store) });

    // Bucket headers (with counts). "This week" is expanded; "Older" starts collapsed.
    expect(screen.getByLabelText("This week (1)")).toBeTruthy();
    expect(screen.getByLabelText("Older (1)")).toBeTruthy();
    expect(screen.getByText("Painted the fence")).toBeTruthy();
    expect(screen.queryByText("Filed taxes")).toBeNull();

    // Expanding the Older group reveals its task.
    await fireEvent.press(screen.getByLabelText("Older (1)"));
    expect(screen.getByText("Filed taxes")).toBeTruthy();
  });

  it("filters the list by the search box", async () => {
    const store = new LocalStore("test");
    addCompleted(store, "Painted the fence", 1);
    addCompleted(store, "Filed taxes", 1);
    await render(<CompletedScreen />, { wrapper: withApp(store) });

    await fireEvent.changeText(screen.getByLabelText("Search completed tasks"), "paint");
    expect(screen.getByText("Painted the fence")).toBeTruthy();
    expect(screen.queryByText("Filed taxes")).toBeNull();
  });
});
