import { renderHook } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { useCommands } from "./useCommands";

/**
 * The command list is built from the nav model plus whatever projects/filters exist in the store, so
 * this seeds a real `LocalStore` and asserts the dynamic commands (a board and a filter) appear
 * alongside the always-present view commands.
 */

describe("useCommands", () => {
  it("includes the smart views", async () => {
    const { result } = await renderHook(() => useCommands(), {
      wrapper: withApp(new LocalStore("test")),
    });
    expect(result.current.some((c) => c.href === "/today")).toBe(true);
    expect(result.current.some((c) => c.href === "/settings")).toBe(true);
  });

  it("adds a command for each project board and saved filter", async () => {
    const store = new LocalStore("test");
    const projectId = store.newEntityId();
    store.set("project", projectId, "name", "Home reno");
    store.set("project", projectId, "kind", "project");
    const filterId = store.newEntityId();
    store.set("saved_filter", filterId, "name", "Hot");
    store.set("saved_filter", filterId, "query", "p1");

    const { result } = await renderHook(() => useCommands(), { wrapper: withApp(store) });

    expect(result.current.some((c) => c.href === `/project/${projectId}`)).toBe(true);
    expect(result.current.some((c) => c.href === `/filter/${filterId}`)).toBe(true);
  });

  it("reaches a habit group as well as a habit, both on the habit route", async () => {
    const store = new LocalStore("test");
    const groupId = store.newEntityId();
    store.set("habit", groupId, "name", "Skincare");
    store.set("habit", groupId, "kind", "group");
    const habitId = store.newEntityId();
    store.set("habit", habitId, "name", "Morning");

    const { result } = await renderHook(() => useCommands(), { wrapper: withApp(store) });

    expect(result.current.some((c) => c.label === "Open group: Skincare")).toBe(true);
    expect(result.current.some((c) => c.label === "Open habit: Morning")).toBe(true);
    expect(result.current.filter((c) => c.href === `/habit/${groupId}`)).toHaveLength(1);
  });
});
