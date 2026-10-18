import { renderHook, act } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { useProjects } from "./useProjects";

/**
 * Over a real `LocalStore`. The rules themselves (the tree, the cycle guard, the ancestor cascade)
 * are `@atlastodo/shared`'s and tested there; what matters here is the wiring -- that the hook writes
 * the field names the web also reads, and that folders never leak into the `projects` list every
 * other screen consumes.
 */
async function mount(seed: (store: LocalStore) => void = () => {}) {
  const store = new LocalStore("test");
  seed(store);
  const view = await renderHook(() => useProjects(), { wrapper: withApp(store) });
  return { store, view };
}

const names = (projects: { name: string }[]) => projects.map((p) => p.name);

describe("listing", () => {
  it("keeps folders out of `projects` and puts them in `folders`", async () => {
    const { view } = await mount((s) => {
      s.set("project", "p1", "name", "Work");
      s.set("project", "f1", "name", "Clients");
      s.set("project", "f1", "kind", "folder");
    });
    expect(names(view.result.current.projects)).toEqual(["Work"]);
    expect(names(view.result.current.folders)).toEqual(["Clients"]);
  });

  it("hides a project whose folder is archived, and brings it back on restore", async () => {
    const { store, view } = await mount((s) => {
      s.set("project", "f1", "name", "Clients");
      s.set("project", "f1", "kind", "folder");
      s.set("project", "p1", "name", "Acme");
      s.set("project", "p1", "parent_id", "f1");
    });
    await act(async () => {
      store.set("project", "f1", "archived_at", Date.now());
      await view.rerender(undefined);
    });
    expect(names(view.result.current.projects)).toEqual([]);

    await act(async () => {
      store.set("project", "f1", "archived_at", null);
      await view.rerender(undefined);
    });
    expect(names(view.result.current.projects)).toEqual(["Acme"]);
  });
});

describe("creating", () => {
  it("creates a top-level project", async () => {
    const { store, view } = await mount();
    let id = "";
    await act(() => {
      id = view.result.current.createProject("Work");
    });
    const fields = store.get("project", id)!;
    expect(fields.kind).toBe("project");
    expect(fields.parent_id).toBeNull();
  });

  it("creates a folder, and a project inside one", async () => {
    const { store, view } = await mount();
    let folderId = "";
    await act(() => {
      folderId = view.result.current.createFolder("Clients");
    });
    expect(store.get("project", folderId)!.kind).toBe("folder");

    let childId = "";
    await act(() => {
      childId = view.result.current.createProject("Acme", { parentId: folderId });
    });
    expect(store.get("project", childId)!.parent_id).toBe(folderId);
  });
});

describe("moving into a folder", () => {
  const seed = (s: LocalStore) => {
    s.set("project", "f1", "name", "Work");
    s.set("project", "f1", "kind", "folder");
    s.set("project", "f2", "name", "Clients");
    s.set("project", "f2", "kind", "folder");
    s.set("project", "f2", "parent_id", "f1");
    s.set("project", "p1", "name", "Acme");
  };

  it("writes the new parent and undoes back to the old one", async () => {
    const { store, view } = await mount(seed);
    let undo: (() => void) | null = null;
    await act(() => {
      undo = view.result.current.setProjectParent("p1", "f1");
    });
    expect(store.get("project", "p1")!.parent_id).toBe("f1");

    await act(() => undo!());
    expect(store.get("project", "p1")!.parent_id).toBeNull();
  });

  it("refuses to move a folder into its own subtree, writing nothing", async () => {
    const { store, view } = await mount(seed);
    let result: (() => void) | null = null;
    await act(() => {
      result = view.result.current.setProjectParent("f1", "f2");
    });
    // The client is the only cycle enforcement there is -- the sync path never runs the server's
    // REST parent check.
    expect(result).toBeNull();
    expect(store.get("project", "f1")!.parent_id ?? null).toBeNull();
  });
});

describe("reordering", () => {
  it("moves a project past its sibling, leaving the others alone", async () => {
    const { store, view } = await mount((s) => {
      for (const [i, id] of ["a", "b", "c"].entries()) {
        s.set("project", id, "name", id.toUpperCase());
        s.set("project", id, "sort_order", i + 1);
      }
    });
    await act(() => view.result.current.reorderProject("c", "up"));
    await view.rerender(undefined);

    expect(names(view.result.current.projects)).toEqual(["A", "C", "B"]);
    // A fractional rank: one row is rewritten, not the whole list.
    expect(store.get("project", "a")!.sort_order).toBe(1);
    expect(store.get("project", "b")!.sort_order).toBe(2);
  });

  it("reorders only among its own siblings inside a folder", async () => {
    const { view } = await mount((s) => {
      s.set("project", "f1", "name", "Work");
      s.set("project", "f1", "kind", "folder");
      for (const [i, id] of ["a", "b"].entries()) {
        s.set("project", id, "name", id.toUpperCase());
        s.set("project", id, "sort_order", i + 1);
        s.set("project", id, "parent_id", "f1");
      }
      s.set("project", "loose", "name", "Loose");
      s.set("project", "loose", "sort_order", 0);
    });
    await act(() => view.result.current.reorderProject("b", "up"));
    await view.rerender(undefined);

    const inFolder = view.result.current.projects.filter((p) => p.parent_id === "f1");
    expect(names(inFolder)).toEqual(["B", "A"]);
  });
});
