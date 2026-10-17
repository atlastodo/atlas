import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { isTrashed, PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { FiltersScreen } from "./FiltersScreen";

/** Over a real in-memory `LocalStore` holding two `saved_filter` entities. */

function storeWithFilters() {
  const store = new LocalStore("test");
  const add = (name: string, query: string, pinned: boolean) => {
    const id = store.newEntityId();
    store.set("saved_filter", id, "name", name);
    store.set("saved_filter", id, "query", query);
    store.set("saved_filter", id, "pinned", pinned);
    store.set("saved_filter", id, "sort_order", name.charCodeAt(0));
    return id;
  };
  const hot = add("Hot", "p1", true);
  add("Later", "due:week", false);
  return { store, hot };
}

describe("FiltersScreen", () => {
  it("toggles a filter's favorite status", async () => {
    const { store, hot } = storeWithFilters();
    await render(<FiltersScreen />, { wrapper: withApp(store) });
    await fireEvent.press(screen.getAllByLabelText("Favorite")[0]!);
    const favs = store.get("preference", PREFERENCES_ID)?.favorites as
      Record<string, boolean> | undefined;
    expect(favs?.[`filter:${hot}`]).toBe(true);
  });

  it("soft-deletes a filter", async () => {
    const { store, hot } = storeWithFilters();
    await render(<FiltersScreen />, { wrapper: withApp(store) });
    // "Hot" sorts first (sort_order H < L), so its delete is the first one.
    await fireEvent.press(screen.getAllByLabelText("Delete filter")[0]!);
    expect(isTrashed(store.get("saved_filter", hot)!)).toBe(true);
  });

  it("offers New filter inside the empty state", async () => {
    const onNew = jest.fn();
    await render(<FiltersScreen onNew={onNew} />, { wrapper: withApp(new LocalStore("test")) });
    expect(screen.getByText("No saved filters yet")).toBeTruthy();
    await fireEvent.press(screen.getByText("New filter"));
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
