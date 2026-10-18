import { renderHook } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { useTaskSearch } from "./useTaskSearch";

/**
 * Over a real `LocalStore` (the DI `withApp` provides, no mocks): the search source must expose the
 * store's visible tasks and a context line the palette rows can show. The matching itself lives in
 * `@atlastodo/shared`'s `searchTasks`; only the wiring is asserted here.
 */

function seed() {
  const store = new LocalStore("test");
  store.set("project", "p1", "name", "Work");
  store.set("project", "p1", "kind", "project");
  store.set("task", "t1", "title", "Write the report");
  store.set("task", "t1", "project_id", "p1");
  store.set("task", "t2", "title", "Water the plants");
  store.set("task", "t3", "title", "File receipts");
  store.set("task", "t3", "project_id", "p1");
  store.set("task", "t3", "due_at", 1758750000000); // a fixed instant; only its presence is asserted
  // Hidden from the search by the store's own visibility rules.
  store.set("task", "t4", "title", "Deleted plan");
  store.set("task", "t4", "deleted_at", Date.now());
  return store;
}

function byTitle(tasks: Task[], title: string): Task | undefined {
  return tasks.find((t) => t.title === title);
}

describe("useTaskSearch", () => {
  it("exposes the store's visible tasks", async () => {
    const store = seed();
    const { result } = await renderHook(() => useTaskSearch(), { wrapper: withApp(store) });
    const titles = result.current.tasks.map((t) => t.title);
    expect(titles).toContain("Write the report");
    expect(titles).toContain("Water the plants");
    expect(titles).not.toContain("Deleted plan");
  });

  it("names the task's project in the context line", async () => {
    const store = seed();
    const { result } = await renderHook(() => useTaskSearch(), { wrapper: withApp(store) });
    const report = byTitle(result.current.tasks, "Write the report");
    expect(report && result.current.context(report)).toBe("Work");
  });

  it("falls back to the inbox label for a task without a project", async () => {
    const store = seed();
    const { result } = await renderHook(() => useTaskSearch(), { wrapper: withApp(store) });
    const plants = byTitle(result.current.tasks, "Water the plants");
    expect(plants && result.current.context(plants)).toBe("Inbox");
  });

  it("appends the due date to the context line", async () => {
    const store = seed();
    const { result } = await renderHook(() => useTaskSearch(), { wrapper: withApp(store) });
    const receipts = byTitle(result.current.tasks, "File receipts");
    expect(receipts).toBeDefined();
    // The chip text itself is `useFormat`'s tested domain (locale + timezone dependent), so only
    // the "project · due" shape is asserted here.
    expect(receipts && result.current.context(receipts)).toMatch(/^Work · /);
  });
});
