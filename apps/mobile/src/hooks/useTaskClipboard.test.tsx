import { renderHook, act } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask, toTask } from "@atlastodo/shared";
import { lastCopiedText, withApp } from "../testutil";
import { useTaskClipboard } from "./useTaskClipboard";

/**
 * This hook must resolve every id-based field to a name, so the same task copied from two screens pastes the same text.
 * Assertions read the text back through the `expo-clipboard` double.
 */

function seed() {
  const store = new LocalStore("test");
  const projectId = store.newEntityId();
  store.set("project", projectId, "name", "Home reno");
  store.set("project", projectId, "kind", "project");

  const sectionId = store.newEntityId();
  store.set("section", sectionId, "project_id", projectId);
  store.set("section", sectionId, "name", "Walls");

  const labelId = store.newEntityId();
  store.set("label", labelId, "name", "urgent");

  // The server authors `project_member` into each member's partition, so seeding the entity is
  // exactly what a shared project looks like on this device.
  const memberId = store.newEntityId();
  store.set("project_member", memberId, "project_id", projectId);
  store.set("project_member", memberId, "user_id", "user-2");
  store.set("project_member", memberId, "display_name", "Ada Lovelace");
  store.set("project_member", memberId, "email", "ada@example.com");
  store.set("project_member", memberId, "state", "active");
  store.set("project_member", memberId, "role", "editor");

  return { store, projectId, sectionId, labelId };
}

const taskNamed = (store: LocalStore, title: string) =>
  store
    .list("task")
    .map((e) => toTask(e.id, e.fields))
    .find((t) => t.title === title)!;

async function mount(store: LocalStore) {
  return await renderHook(() => useTaskClipboard(), { wrapper: withApp(store) });
}

describe("useTaskClipboard", () => {
  it("carries the project and section a task lives in", async () => {
    const { store, projectId, sectionId } = seed();
    createTask(store, { title: "Paint the hall", project_id: projectId, section_id: sectionId });
    const view = await mount(store);

    await act(() => view.result.current.copyTasks([taskNamed(store, "Paint the hall")]));

    expect(lastCopiedText()).toBe("- Paint the hall (#Home reno/Walls)");
  });

  it("names the project alone when a task is in no section", async () => {
    const { store, projectId } = seed();
    createTask(store, { title: "Order tiles", project_id: projectId });
    const view = await mount(store);

    await act(() => view.result.current.copyTasks([taskNamed(store, "Order tiles")]));

    expect(lastCopiedText()).toBe("- Order tiles (#Home reno)");
  });

  it("resolves labels and the assignee to names, not ids", async () => {
    const { store, projectId, labelId } = seed();
    createTask(store, { title: "Book the plumber", project_id: projectId });
    const task = taskNamed(store, "Book the plumber");
    store.set("task", task.id, "label_ids", [labelId]);
    store.set("task", task.id, "assignee_id", "user-2");
    const view = await mount(store);

    await act(() => view.result.current.copyTasks([taskNamed(store, "Book the plumber")]));

    const text = lastCopiedText()!;
    expect(text).toContain("@urgent");
    expect(text).toContain("assigned Ada Lovelace");
    // The raw ids would be meaningless once pasted.
    expect(text).not.toContain(labelId);
    expect(text).not.toContain("user-2");
  });

  it("adds no metadata to a bare inbox task", async () => {
    const { store } = seed();
    createTask(store, { title: "Think" });
    const view = await mount(store);

    await act(() => view.result.current.copyTasks([taskNamed(store, "Think")]));

    expect(lastCopiedText()).toBe("- Think");
  });

  it("copies nothing for an empty selection", async () => {
    const { store, projectId } = seed();
    createTask(store, { title: "Paint the hall", project_id: projectId });
    const view = await mount(store);
    await act(() => view.result.current.copyTasks([taskNamed(store, "Paint the hall")]));
    const before = lastCopiedText();

    await act(() => view.result.current.copyTasks([]));

    expect(lastCopiedText()).toBe(before);
  });
});
