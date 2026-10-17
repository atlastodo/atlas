import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { FilterScreen } from "./FilterScreen";

/** The screen evaluates a live filter query against the store and previews the right tasks. */

function seed() {
  const store = new LocalStore("test");
  createTask(store, { title: "Urgent thing", priority: 1 });
  createTask(store, { title: "Someday thing", priority: 4 });
  return store;
}

describe("FilterScreen", () => {
  it("previews only the tasks matching the query", async () => {
    await render(<FilterScreen filterId="new" />, { wrapper: withApp(seed()) });

    await fireEvent.changeText(screen.getByLabelText("Filter query"), "p1");

    expect(screen.getByText("Urgent thing")).toBeTruthy();
    expect(screen.queryByText("Someday thing")).toBeNull();
    expect(screen.getByText("1 matching")).toBeTruthy();
  });

  it("shows a parse error and previews nothing for an invalid query", async () => {
    await render(<FilterScreen filterId="new" />, { wrapper: withApp(seed()) });

    await fireEvent.changeText(screen.getByLabelText("Filter query"), "p1 &");

    expect(screen.getByText("Enter a valid query to preview")).toBeTruthy();
    expect(screen.queryByText("Urgent thing")).toBeNull();
  });

  it("creates a new filter from the composer", async () => {
    const store = seed();
    await render(<FilterScreen filterId="new" onSaved={() => {}} />, { wrapper: withApp(store) });

    await fireEvent.changeText(screen.getByLabelText("Filter name"), "Hot");
    await fireEvent.changeText(screen.getByLabelText("Filter query"), "p1");
    await fireEvent.press(screen.getByLabelText("Create"));

    const saved = store.list("saved_filter");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.fields.name).toBe("Hot");
    expect(saved[0]!.fields.query).toBe("p1");
  });

  it("keeps each filter's query its own when the screen moves to another filter", async () => {
    const store = seed();
    store.set("saved_filter", "fa", "name", "A");
    store.set("saved_filter", "fa", "query", "p1");
    store.set("saved_filter", "fb", "name", "B");
    store.set("saved_filter", "fb", "query", "p4");
    const { rerender } = await render(<FilterScreen filterId="fa" />, { wrapper: withApp(store) });

    await fireEvent.changeText(screen.getByLabelText("Filter query"), "p2");
    // The route is reused: the same screen instance now shows filter B.
    await rerender(<FilterScreen filterId="fb" />);

    const field = screen.getByLabelText("Filter query");
    expect(field.props.value).toBe("p4");
    await fireEvent(field, "blur");
    expect(store.get("saved_filter", "fb")?.query).toBe("p4");
  });

  it("shows a saved filter's query that arrives after the screen opened", async () => {
    const store = seed();
    await render(<FilterScreen filterId="late" />, { wrapper: withApp(store) });
    await act(() => {
      store.set("saved_filter", "late", "name", "Late");
      store.set("saved_filter", "late", "query", "p1");
    });

    expect(screen.getByLabelText("Filter query").props.value).toBe("p1");
  });

  it("keeps Select and the filter's actions on one toolbar row with the match count", async () => {
    const store = seed();
    store.set("saved_filter", "fa", "name", "A");
    store.set("saved_filter", "fa", "query", "p1");
    await render(<FilterScreen filterId="fa" />, { wrapper: withApp(store) });

    // One Select, from the filter's own toolbar (the list's separate toolbar is off).
    expect(screen.getAllByLabelText("Select")).toHaveLength(1);
    expect(screen.getByText("1 matching")).toBeTruthy();
    expect(screen.getByLabelText("Delete filter")).toBeTruthy();
  });
});
