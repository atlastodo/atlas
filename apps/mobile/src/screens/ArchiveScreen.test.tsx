import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask, setTaskArchived, toTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { ArchiveScreen } from "./ArchiveScreen";

function archivedTask(store: LocalStore, title: string) {
  const id = createTask(store, { title });
  const task = toTask(id, store.list("task").find((e) => e.id === id)!.fields);
  setTaskArchived(store, task, true);
  return id;
}

describe("ArchiveScreen", () => {
  it("names an archived task this device cannot decrypt instead of showing a blank row", async () => {
    const store = new LocalStore("test");
    const id = archivedTask(store, "Secret");
    store.set("task", id, "title", { __enc: 1, iv: "aXY=", ct: "Y3Q=" });
    await render(<ArchiveScreen />, { wrapper: withApp(store) });

    expect(screen.getByText("Encrypted task — key not available")).toBeTruthy();
  });

  it("lists an archived habit group, but not the members it took with it", async () => {
    // A member has no `archived_at` of its own -- it hides through the group and comes back with
    // it -- so listing it loose here would offer a Restore that did nothing.
    const store = new LocalStore("test");
    store.set("habit", "g1", "name", "Skincare");
    store.set("habit", "g1", "kind", "group");
    store.set("habit", "g1", "archived_at", Date.now());
    store.set("habit", "m1", "name", "Morning");
    store.set("habit", "m1", "parent_id", "g1");
    await render(<ArchiveScreen />, { wrapper: withApp(store) });

    expect(screen.getByText("Skincare")).toBeTruthy();
    expect(screen.queryByText("Morning")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Restore"));
    expect(screen.getByText("Nothing archived")).toBeTruthy();
  });

  it("restores an archived task, removing it from the view", async () => {
    const store = new LocalStore("test");
    archivedTask(store, "Old task");
    await render(<ArchiveScreen />, { wrapper: withApp(store) });

    // Only the task section is present -> a single Restore control.
    await fireEvent.press(screen.getByLabelText("Restore"));
    expect(screen.queryByText("Old task")).toBeNull();
    expect(screen.getByText("Nothing archived")).toBeTruthy();
  });

  it("separates routines from habits, and names a habit's routine", async () => {
    const store = new LocalStore("test");
    store.set("habit", "g1", "name", "Skincare");
    store.set("habit", "g1", "kind", "group");
    store.set("habit", "g1", "archived_at", null);
    // An archived member of a live routine: on its own the name says nothing about where it lived.
    store.set("habit", "m1", "name", "Serum");
    store.set("habit", "m1", "parent_id", "g1");
    store.set("habit", "m1", "archived_at", Date.now());
    await render(<ArchiveScreen />, { wrapper: withApp(store) });

    expect(screen.getByText("Habits")).toBeTruthy();
    expect(screen.getByText("Serum")).toBeTruthy();
    expect(screen.getByText("Skincare")).toBeTruthy();
    // The live routine is not itself archived, so it gets no Routines section of its own.
    expect(screen.queryByText("Routines")).toBeNull();
  });
});
