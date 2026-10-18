import { render, act } from "@testing-library/react-native";
import type { Task } from "@atlastodo/client-core";
import { SelectionProvider, useSelection, type SelectionApi } from "../data/SelectionProvider";
import { ScreenFocusContext } from "../data/ScreenFocusContext";
import { useSelectionSource } from "./useSelectionSource";

/**
 * The list-source prune: a background re-derive that blanks the list must not wipe a selection, a selected row in a
 * collapsed group must not be pruned, and an unfocused list must not prune the focused screen's selection.
 */

const task = (id: string): Task => ({ id }) as unknown as Task;

async function renderSource(initial: Task[], initialKnown?: Task[], initialFocused = true) {
  let api!: SelectionApi;
  function Inner({ tasks, known }: { tasks: Task[]; known?: Task[] }) {
    api = useSelection();
    useSelectionSource(tasks, known);
    return null;
  }
  const tree = (tasks: Task[], known: Task[] | undefined, focused: boolean) => (
    <SelectionProvider>
      <ScreenFocusContext.Provider value={focused}>
        <Inner tasks={tasks} known={known} />
      </ScreenFocusContext.Provider>
    </SelectionProvider>
  );
  const view = await render(tree(initial, initialKnown, initialFocused));
  return {
    api: () => api,
    setTasks: (tasks: Task[], known?: Task[]) => view.rerender(tree(tasks, known, true)),
    setFocused: (focused: boolean, tasks = initial, known = initialKnown) =>
      view.rerender(tree(tasks, known, focused)),
  };
}

describe("useSelectionSource", () => {
  it("keeps the selection when the visible list transiently empties", async () => {
    const s = await renderSource([task("a"), task("b")]);
    await act(() => s.api().beginWith("a"));
    expect(s.api().mode).toBe(true);
    expect([...s.api().selected]).toEqual(["a"]);

    // A re-derive momentarily yields an empty list (the reported "goes blank" frame).
    await act(() => s.setTasks([]));

    expect(s.api().mode).toBe(true);
    expect([...s.api().selected]).toEqual(["a"]);
  });

  it("prunes only the ids that left a non-empty list", async () => {
    const s = await renderSource([task("a"), task("b"), task("c")]);
    await act(() => {
      s.api().beginWith("a");
      s.api().add(["b"]);
    });
    expect([...s.api().selected].sort()).toEqual(["a", "b"]);

    // b leaves the list (completed/moved); a stays -> only b is pruned.
    await act(() => s.setTasks([task("a"), task("c")]));

    expect([...s.api().selected]).toEqual(["a"]);
    expect(s.api().mode).toBe(true);
  });

  it("stays in select mode even when every selected row leaves", async () => {
    const s = await renderSource([task("a"), task("b")]);
    await act(() => s.api().beginWith("a"));

    await act(() => s.setTasks([task("b"), task("c")]));

    expect([...s.api().selected]).toEqual([]);
    // The toolbar's Clear/Exit is the way out -- the prune must not silently drop select mode.
    expect(s.api().mode).toBe(true);
  });

  it("does not prune a selected row that is known but not shown (a collapsed group)", async () => {
    // shown = [a]; known = [a, b] -- b is in a collapsed group, still selected.
    const s = await renderSource([task("a")], [task("a"), task("b")]);
    await act(() => {
      s.api().beginWith("a");
      s.api().add(["b"]);
    });
    // A re-render keeps b out of `shown` but in `known`; it must survive.
    await act(() => s.setTasks([task("a")], [task("a"), task("b")]));
    expect([...s.api().selected].sort()).toEqual(["a", "b"]);
  });

  it("a list that is unfocused from the start never prunes the selection", async () => {
    // A backgrounded, still-mounted screen (never focused since this selection was made) holds a
    // different task set. Its prune must be inert -- it is not the screen the user is looking at, so
    // it must not touch the focused screen's selection. (It started unfocused, so no blur-clear.)
    const s = await renderSource([task("a"), task("b")], undefined, false);
    await act(() => {
      s.api().beginWith("a");
      s.api().add(["b"]);
    });
    await act(() => s.setFocused(false, [task("x")], [task("x")]));
    expect([...s.api().selected].sort()).toEqual(["a", "b"]);
  });

  it("clears the selection when the list loses focus (a selection is view-scoped)", async () => {
    const s = await renderSource([task("a"), task("b")]);
    await act(() => s.api().beginWith("a"));
    expect(s.api().mode).toBe(true);

    await act(() => s.setFocused(false));

    expect([...s.api().selected]).toEqual([]);
    expect(s.api().mode).toBe(false);
  });

  it("gives up select-all when its screen loses focus", async () => {
    // Cmd/Ctrl-A on another screen must not select this backgrounded list's rows.
    const s = await renderSource([task("a"), task("b")]);
    await act(() => s.setFocused(false));

    let handled = true;
    await act(() => {
      handled = s.api().selectAll();
    });
    expect(handled).toBe(false);
    expect(s.api().mode).toBe(false);
    expect(s.api().selected.size).toBe(0);
  });
});
