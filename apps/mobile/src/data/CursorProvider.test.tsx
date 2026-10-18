import { act, render } from "@testing-library/react-native";
import { useEffect, useRef } from "react";
import { Text } from "react-native";
import type { Task } from "@atlastodo/client-core";
import {
  CursorProvider,
  useCursor,
  useCursorList,
  useQuickAddHotkeyTarget,
  type ActiveList,
  type CursorContextValue,
} from "./CursorProvider";
import { ScreenFocusContext } from "./ScreenFocusContext";

function task(id: string): Task {
  return {
    id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: id,
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  };
}

const TASKS = [task("a"), task("b"), task("c")];

/** Grabs the latest context value so a test can drive the cursor as the hotkey layer would. */
let ctx: CursorContextValue;

function Harness({ actions }: { actions: Partial<ActiveList> }) {
  const cursor = useCursor();
  ctx = cursor;
  const listRef = useRef<ActiveList>({
    getTasks: () => TASKS,
    open: () => {},
    toggle: () => {},
    reschedule: () => {},
    remove: () => {},
    ...actions,
  });
  const { setActiveList, clearActiveList } = cursor;
  useEffect(() => {
    const list = listRef.current;
    setActiveList(list);
    return () => clearActiveList(list);
  }, [setActiveList, clearActiveList]);
  return <Text>{cursor.cursorId ?? "none"}</Text>;
}

async function mount(actions: Partial<ActiveList> = {}) {
  await render(
    <CursorProvider>
      <Harness actions={actions} />
    </CursorProvider>,
  );
  // Flush the registration effect so the list is active before the test drives the cursor.
  await act(() => {});
}

describe("CursorProvider", () => {
  it("moves the cursor down and up over the registered list, clamping at the ends", async () => {
    await mount();
    expect(ctx.cursorId).toBeNull();
    await act(() => ctx.next());
    expect(ctx.cursorId).toBe("a");
    await act(() => ctx.next());
    expect(ctx.cursorId).toBe("b");
    await act(() => ctx.prev());
    expect(ctx.cursorId).toBe("a");
    await act(() => ctx.prev()); // already at the top -> clamps
    expect(ctx.cursorId).toBe("a");
  });

  it("runs open/complete/reschedule/delete against the focused row", async () => {
    const open = jest.fn();
    const toggle = jest.fn();
    const reschedule = jest.fn();
    const remove = jest.fn();
    await mount({ open, toggle, reschedule, remove });

    await act(() => ctx.next()); // focus "a"
    await act(() => ctx.openCursor());
    expect(open).toHaveBeenCalledWith(TASKS[0]);

    await act(() => ctx.next()); // focus "b"
    await act(() => ctx.completeCursor());
    expect(toggle).toHaveBeenCalledWith(TASKS[1]);
    await act(() => ctx.rescheduleCursor());
    expect(reschedule).toHaveBeenCalledWith(TASKS[1]);
    await act(() => ctx.deleteCursor());
    expect(remove).toHaveBeenCalledWith(TASKS[1]);
  });

  it("does nothing when no row is focused", async () => {
    const toggle = jest.fn();
    await mount({ toggle });
    await act(() => ctx.completeCursor()); // cursorId is null
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("useCursorList", () => {
  // The drawer keeps visited screens mounted and the task detail opens over its list. A list that
  // registered on mount went on taking x/# for rows nobody could see.
  function Screen({ name, remove }: { name: string; remove: (task: Task) => void }) {
    const cursorId = useCursorList({
      getTasks: () => TASKS,
      open: () => {},
      toggle: () => {},
      reschedule: () => {},
      remove,
    });
    return <Text>{`${name}:${cursorId ?? "none"}`}</Text>;
  }
  function Probe() {
    ctx = useCursor();
    return null;
  }
  function App({
    todayFocused,
    removeToday,
    removeProject,
  }: {
    todayFocused: boolean;
    removeToday: (task: Task) => void;
    removeProject?: (task: Task) => void;
  }) {
    return (
      <CursorProvider>
        <Probe />
        <ScreenFocusContext.Provider value={todayFocused}>
          <Screen name="today" remove={removeToday} />
        </ScreenFocusContext.Provider>
        {removeProject && (
          <ScreenFocusContext.Provider value={!todayFocused}>
            <Screen name="project" remove={removeProject} />
          </ScreenFocusContext.Provider>
        )}
      </CursorProvider>
    );
  }

  it("acts only on the focused screen's list", async () => {
    const removeToday = jest.fn();
    const removeProject = jest.fn();
    await render(
      <App todayFocused={false} removeToday={removeToday} removeProject={removeProject} />,
    );
    await act(() => ctx.next());
    await act(() => ctx.deleteCursor());
    expect(removeToday).not.toHaveBeenCalled();
    expect(removeProject).toHaveBeenCalledWith(TASKS[0]);
  });

  it("lets go of the list and the cursor when its screen loses focus", async () => {
    const removeToday = jest.fn();
    const { rerender } = await render(<App todayFocused removeToday={removeToday} />);
    await act(() => ctx.next());
    expect(ctx.cursorId).toBe("a");

    // The task detail opens over the list: the screen behind it is no longer focused.
    await rerender(<App todayFocused={false} removeToday={removeToday} />);
    expect(ctx.cursorId).toBeNull();
    await act(() => ctx.next());
    await act(() => ctx.deleteCursor());
    expect(removeToday).not.toHaveBeenCalled();
  });
});

describe("useQuickAddHotkeyTarget", () => {
  // a / q was listed in the shortcut help but never wired.
  function QuickAddStub({ name, onFocus }: { name: string; onFocus: (name: string) => void }) {
    useQuickAddHotkeyTarget(() => onFocus(name));
    return null;
  }
  function Probe() {
    ctx = useCursor();
    return null;
  }

  it("focuses the focused screen's first quick-add, never a background one", async () => {
    const onFocus = jest.fn();
    await render(
      <CursorProvider>
        <Probe />
        <ScreenFocusContext.Provider value={false}>
          <QuickAddStub name="background" onFocus={onFocus} />
        </ScreenFocusContext.Provider>
        <QuickAddStub name="header" onFocus={onFocus} />
        <QuickAddStub name="section" onFocus={onFocus} />
      </CursorProvider>,
    );

    let handled = false;
    await act(() => {
      handled = ctx.focusQuickAdd();
    });
    expect(handled).toBe(true);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledWith("header");
  });

  it("declines when the screen has no quick-add", async () => {
    await render(
      <CursorProvider>
        <Probe />
      </CursorProvider>,
    );
    expect(ctx.focusQuickAdd()).toBe(false);
  });
});
