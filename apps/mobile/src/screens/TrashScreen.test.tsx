import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { TRASH_RETENTION_MS, createTask, toTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { TrashScreen } from "./TrashScreen";

// Over a real in-memory `LocalStore`; trash rules are tested in `@atlastodo/shared`.

const DAY = 86_400_000;

function trashedTask(store: LocalStore, title: string, deletedAt: number) {
  const id = createTask(store, { title });
  store.set("task", id, "deleted_at", deletedAt);
  return id;
}
const task = (store: LocalStore, id: string) => {
  const e = store.get("task", id);
  return e ? toTask(id, e) : undefined;
};

describe("TrashScreen", () => {
  it("restores an item, clearing its deleted_at", async () => {
    const store = new LocalStore("test");
    const id = trashedTask(store, "Deleted thing", Date.now());
    await render(<TrashScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Restore"));

    expect(task(store, id)?.deleted_at).toBeNull();
    // Gone from the trash list.
    expect(screen.queryByText("Deleted thing")).toBeNull();
  });

  it("permanently deletes an item only once confirmed, tombstoning it", async () => {
    const store = new LocalStore("test");
    const id = trashedTask(store, "Deleted thing", Date.now());
    await render(<TrashScreen />, { wrapper: withApp(store) });

    // Irreversible, and for every member of a shared project: it asks first.
    await fireEvent.press(screen.getByLabelText("Delete permanently"));
    expect(screen.getByText("Delete permanently?")).toBeTruthy();
    expect(store.get("task", id)).not.toBeNull();
    await fireEvent.press(screen.getByLabelText("Delete"));

    // A real tombstone: the entity is gone from the store, not just marked.
    expect(store.get("task", id)).toBeNull();
    expect(screen.queryByText("Deleted thing")).toBeNull();
  });

  it("keeps the item when the permanent delete is cancelled", async () => {
    const store = new LocalStore("test");
    const id = trashedTask(store, "Deleted thing", Date.now());
    await render(<TrashScreen />, { wrapper: withApp(store) });

    await fireEvent.press(screen.getByLabelText("Delete permanently"));
    await fireEvent.press(screen.getByLabelText("Cancel"));

    expect(store.get("task", id)).not.toBeNull();
    expect(screen.getByText("Deleted thing")).toBeTruthy();
  });

  it("hides items already past the 30-day window", async () => {
    const store = new LocalStore("test");
    // Deleted 31 days ago: past retention, so the sweep will purge it and it must not be listed.
    trashedTask(store, "Long gone", Date.now() - TRASH_RETENTION_MS - DAY);
    trashedTask(store, "Recent", Date.now());
    await render(<TrashScreen />, { wrapper: withApp(store) });

    expect(screen.getByText("Recent")).toBeTruthy();
    expect(screen.queryByText("Long gone")).toBeNull();
  });

  it("empties the trash after confirmation", async () => {
    const store = new LocalStore("test");
    const t1 = trashedTask(store, "Thing 1", Date.now());
    const t2 = trashedTask(store, "Thing 2", Date.now());
    await render(<TrashScreen />, { wrapper: withApp(store) });

    expect(screen.getByText("Empty trash")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Empty trash"));

    // Confirmation dialog appears
    expect(screen.getByText("Empty trash?")).toBeTruthy();
    await fireEvent.press(screen.getByText("Delete all"));

    expect(store.get("task", t1)).toBeNull();
    expect(store.get("task", t2)).toBeNull();
    expect(screen.getByText(/Recently deleted is empty/)).toBeTruthy();
  });
});
