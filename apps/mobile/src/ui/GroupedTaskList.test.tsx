import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { allTasks, createTask, type GroupBy } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { useCursor, type CursorContextValue } from "../data/CursorProvider";
import { ScreenFocusContext } from "../data/ScreenFocusContext";
import { InboxScreen } from "../screens/InboxScreen";
import { AllTasksScreen } from "../screens/AllTasksScreen";
import { GroupedTaskList } from "./GroupedTaskList";

/**
 * A blank title in a list is not proof of an abandoned draft: it is also a task another device
 * created blank, a task this device cannot decrypt (an undecryptable title maps to ""), or a draft
 * another mounted list is still typing into. The list may only discard the row *it* is editing, when
 * that row is left blank -- never sweep the tasks it merely shows.
 */

const NOW = Date.parse("2026-09-23T12:00:00Z");
const LOCKED_TITLE = "Encrypted task — key not available";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Buy milk",
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
    ...overrides,
  };
}

const noop = () => {};

function List({
  tasks,
  now = NOW,
  groupBy = "none",
  onDiscardTask,
  onToggle = noop,
}: {
  tasks: Task[];
  now?: number;
  groupBy?: GroupBy;
  onDiscardTask: (id: string) => void;
  onToggle?: (task: Task) => void;
}) {
  return (
    <GroupedTaskList
      tasks={tasks}
      allTasks={tasks}
      now={now}
      groupBy={groupBy}
      groupTitle={() => "Group"}
      sortBy="manual"
      onToggle={onToggle}
      onBulkSetPriority={noop}
      onBulkSetDue={noop}
      onBulkSetLabels={noop}
      onBulkClearLabels={noop}
      onBulkDuplicate={noop}
      onBulkDelete={noop}
      onBulkMove={noop}
      onReorder={noop}
      onUpdateTask={noop}
      onCreateTask={() => "new-id"}
      onDiscardTask={onDiscardTask}
    />
  );
}

describe("GroupedTaskList never sweeps blank rows it did not create", () => {
  const remoteBlank = task({ id: "remote-blank", title: "", sort_order: 1 });
  const locked = task({ id: "remote-locked", title: "", locked: true, sort_order: 2 });
  const plain = task({ id: "plain", title: "Buy milk", sort_order: 3 });

  it.each<GroupBy>(["none", "date"])(
    "leaves a remote blank task and a locked task alone across re-renders (group: %s)",
    async (groupBy) => {
      const onDiscardTask = jest.fn();
      const wrapper = withApp(new LocalStore("test"));
      const { rerender } = await render(
        <List
          tasks={[remoteBlank, locked, plain]}
          groupBy={groupBy}
          onDiscardTask={onDiscardTask}
        />,
        { wrapper },
      );
      // A sync frame (new array identity), a clock tick, and a new arrival: each re-derives the list.
      await rerender(
        <List
          tasks={[remoteBlank, locked, plain]}
          groupBy={groupBy}
          onDiscardTask={onDiscardTask}
        />,
      );
      await rerender(
        <List
          tasks={[remoteBlank, locked, plain]}
          now={NOW + 60_000}
          groupBy={groupBy}
          onDiscardTask={onDiscardTask}
        />,
      );
      await rerender(
        <List
          tasks={[remoteBlank, locked, plain, task({ id: "arrival", title: "", sort_order: 4 })]}
          now={NOW + 60_000}
          groupBy={groupBy}
          onDiscardTask={onDiscardTask}
        />,
      );

      expect(onDiscardTask).not.toHaveBeenCalled();
    },
  );
});

describe("GroupedTaskList locked rows", () => {
  it("shows the placeholder and offers no rename or completion", async () => {
    const onDiscardTask = jest.fn();
    const onToggle = jest.fn();
    await render(
      <List
        tasks={[task({ id: "remote-locked", title: "", locked: true })]}
        onDiscardTask={onDiscardTask}
        onToggle={onToggle}
      />,
      { wrapper: withApp(new LocalStore("test")) },
    );

    expect(screen.getByText(LOCKED_TITLE)).toBeTruthy();
    await fireEvent.press(screen.getByText(LOCKED_TITLE));
    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(screen.queryByLabelText("Complete task")).toBeNull();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onDiscardTask).not.toHaveBeenCalled();
  });
});

describe("GroupedTaskList drafts (over a real store)", () => {
  /** Start renaming the row titled `title`, then press Enter to open a blank draft below it. */
  async function openDraftBelow(title: string) {
    await fireEvent.press(screen.getAllByText(title)[0]!);
    await fireEvent(screen.getByLabelText("Task title"), "submitEditing");
  }
  const blankIds = (s: LocalStore) =>
    allTasks(s)
      .filter((t) => t.title === "")
      .map((t) => t.id);

  it("removes a freshly created blank row when its rename is cancelled", async () => {
    const s = new LocalStore("test");
    createTask(s, { title: "Existing" });
    await render(<InboxScreen />, { wrapper: withApp(s) });

    await openDraftBelow("Existing");
    expect(blankIds(s)).toHaveLength(1);

    await fireEvent(screen.getByLabelText("Task title"), "keyPress", {
      nativeEvent: { key: "Escape" },
    });

    expect(blankIds(s)).toHaveLength(0);
    expect(allTasks(s).map((t) => t.title)).toEqual(["Existing"]);
  });

  it("keeps a draft once it has been given a title", async () => {
    const s = new LocalStore("test");
    createTask(s, { title: "Existing" });
    await render(<InboxScreen />, { wrapper: withApp(s) });

    await openDraftBelow("Existing");
    await fireEvent.changeText(screen.getByLabelText("Task title"), "Second");
    await fireEvent(screen.getByLabelText("Task title"), "blur");

    expect(
      allTasks(s)
        .map((t) => t.title)
        .sort(),
    ).toEqual(["Existing", "Second"]);
  });

  it("removes the blank draft it was editing when the list goes away", async () => {
    const s = new LocalStore("test");
    createTask(s, { title: "Existing" });
    const { unmount } = await render(<InboxScreen />, { wrapper: withApp(s) });

    await openDraftBelow("Existing");
    expect(blankIds(s)).toHaveLength(1);
    await act(async () => await unmount());

    expect(blankIds(s)).toHaveLength(0);
  });

  it("does not delete a draft another mounted list is still typing into", async () => {
    const s = new LocalStore("test");
    createTask(s, { title: "Existing" });
    // Drawer screens stay mounted: Inbox and All both show inbox tasks at the same time.
    await render(
      <>
        <InboxScreen />
        <AllTasksScreen />
      </>,
      { wrapper: withApp(s) },
    );

    await openDraftBelow("Existing");

    expect(blankIds(s)).toHaveLength(1);
  });
});

describe("GroupedTaskList keyboard cursor", () => {
  let cursor: CursorContextValue;
  function Probe() {
    cursor = useCursor();
    return null;
  }

  it("does not act for a list whose screen is in the background", async () => {
    // Visited screens stay mounted: x on another screen must not complete this list's rows.
    const onToggle = jest.fn();
    await render(
      <>
        <Probe />
        <ScreenFocusContext.Provider value={false}>
          <List tasks={[task()]} onDiscardTask={noop} onToggle={onToggle} />
        </ScreenFocusContext.Provider>
      </>,
      { wrapper: withApp(new LocalStore("test")) },
    );
    await act(() => cursor.next());
    await act(() => cursor.completeCursor());
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("walks and completes the rows of the focused list", async () => {
    const onToggle = jest.fn();
    await render(
      <>
        <Probe />
        <List tasks={[task()]} onDiscardTask={noop} onToggle={onToggle} />
      </>,
      { wrapper: withApp(new LocalStore("test")) },
    );
    await act(() => cursor.next());
    await act(() => cursor.completeCursor());
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
  });
});

describe("GroupedTaskList menu Indent / Outdent", () => {
  // The menu indented against every task in the view, while the swipe used the row's own group: in
  // a grouped list the menu nested a task under the last row of a *different* group. It also
  // offered Indent where nothing could be nested under.
  const p1 = task({ id: "a", title: "Alpha", priority: 1, sort_order: 1 });
  const p2 = task({ id: "b", title: "Beta", priority: 2, sort_order: 2 });

  async function renderGrouped(onReparent: jest.Mock) {
    await render(
      <GroupedTaskList
        tasks={[p1, p2]}
        allTasks={[p1, p2]}
        now={NOW}
        groupBy="priority"
        groupTitle={(_, key) => key}
        sortBy="manual"
        onToggle={noop}
        onBulkSetPriority={noop}
        onBulkSetDue={noop}
        onBulkSetLabels={noop}
        onBulkClearLabels={noop}
        onBulkDuplicate={noop}
        onBulkDelete={noop}
        onBulkMove={noop}
        onReorder={noop}
        onReparent={onReparent}
      />,
      { wrapper: withApp(new LocalStore("test")) },
    );
  }

  it("offers no Indent for the first row of its group", async () => {
    const onReparent = jest.fn();
    await renderGrouped(onReparent);
    await fireEvent(screen.getByLabelText("Beta"), "longPress", {
      nativeEvent: { pageX: 1, pageY: 1 },
    });

    expect(screen.getByRole("menuitem", { name: "Complete task" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Indent (make subtask)" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Outdent" })).toBeNull();
    expect(onReparent).not.toHaveBeenCalled();
  });
});

describe("GroupedTaskList reminder marker", () => {
  it("shows the bell on a row whose task has a reminder still to come", async () => {
    // Only the unused TaskList passed `hasReminder`, so no live list ever showed the bell.
    const store = new LocalStore("test");
    store.set("reminder", "r1", "task_id", "with");
    store.set("reminder", "r1", "at", NOW + 3_600_000);
    store.set("reminder", "r2", "task_id", "fired");
    store.set("reminder", "r2", "at", NOW - 3_600_000);
    store.set("reminder", "r2", "fired_at", NOW - 3_600_000);
    await render(
      <List
        tasks={[
          task({ id: "with", title: "Call mum", sort_order: 1 }),
          task({ id: "fired", title: "Old ping", sort_order: 2 }),
          task({ id: "none", title: "Plain", sort_order: 3 }),
        ]}
        onDiscardTask={noop}
      />,
      { wrapper: withApp(store) },
    );

    expect(screen.getAllByLabelText("Has reminder")).toHaveLength(1);
  });
});
