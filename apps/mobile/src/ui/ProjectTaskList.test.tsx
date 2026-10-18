import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Section, type Task } from "@atlastodo/client-core";
import { allTasks, createTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { useCursor, type CursorContextValue } from "../data/CursorProvider";
import { ProjectScreen } from "../screens/ProjectScreen";
import { ProjectTaskList } from "./ProjectTaskList";

/**
 * The project list's half of the blank-row rule (see GroupedTaskList.test): only the row this list
 * is editing may be discarded, and only while it is still blank. A shared project is where a wrong
 * discard hurts most -- the tombstone fans out to every member.
 */

const NOW = Date.parse("2026-09-23T12:00:00Z");
const LOCKED_TITLE = "Encrypted task — key not available";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
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
  sections = [],
  now = NOW,
  onDiscardTask,
  onToggle = noop,
  doneTasks = [],
  showDone = false,
}: {
  tasks: Task[];
  sections?: Section[];
  now?: number;
  onDiscardTask: (id: string) => void;
  onToggle?: (task: Task) => void;
  doneTasks?: Task[];
  showDone?: boolean;
}) {
  return (
    <ProjectTaskList
      projectId="p1"
      tasks={tasks}
      sections={sections}
      now={now}
      onToggle={onToggle}
      onReorder={noop}
      onMoveToSection={noop}
      onBulkSetPriority={noop}
      onBulkSetDue={noop}
      onBulkSetLabels={noop}
      onBulkClearLabels={noop}
      onBulkDuplicate={noop}
      onBulkDelete={noop}
      onBulkMove={noop}
      onAddSection={noop}
      onRenameSection={noop}
      onDuplicateSection={noop}
      onDeleteSection={noop}
      onArchiveSection={noop}
      onMoveSection={noop}
      onReorderSection={noop}
      onSelectSectionTasks={noop}
      onAddTask={noop}
      onUpdateTask={noop}
      onCreateTask={() => "new-id"}
      onDiscardTask={onDiscardTask}
      doneTasks={showDone ? doneTasks : []}
      showDone={showDone}
    />
  );
}

const SECTION: Section = {
  id: "s1",
  project_id: "p1",
  name: "Doing",
  sort_order: 0,
  deleted_at: null,
  archived_at: null,
};

describe("ProjectTaskList never sweeps blank rows it did not create", () => {
  const remoteBlank = task({ id: "remote-blank", title: "", sort_order: 1 });
  const locked = task({ id: "remote-locked", title: "", locked: true, sort_order: 2 });
  const plain = task({ id: "plain", title: "Buy milk", sort_order: 3 });

  it.each([
    ["flat", [] as Section[]],
    ["sectioned", [SECTION]],
  ])(
    "leaves a remote blank task and a locked task alone across re-renders (%s)",
    async (_, sections) => {
      const onDiscardTask = jest.fn();
      const { rerender } = await render(
        <List
          tasks={[remoteBlank, locked, plain]}
          sections={sections}
          onDiscardTask={onDiscardTask}
        />,
        { wrapper: withApp(new LocalStore("test")) },
      );
      await rerender(
        <List
          tasks={[remoteBlank, locked, plain]}
          sections={sections}
          onDiscardTask={onDiscardTask}
        />,
      );
      await rerender(
        <List
          tasks={[remoteBlank, locked, plain, task({ id: "arrival", title: "", sort_order: 4 })]}
          sections={sections}
          now={NOW + 60_000}
          onDiscardTask={onDiscardTask}
        />,
      );

      expect(onDiscardTask).not.toHaveBeenCalled();
    },
  );
});

describe("ProjectTaskList locked rows", () => {
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

describe("ProjectTaskList Done section", () => {
  const open = task({ id: "open", title: "Open thing" });
  const doneIn = task({
    id: "done-in",
    title: "Done in Doing",
    is_completed: true,
    completed_at: 2,
    section_id: "s1",
  });
  const doneHomeless = task({
    id: "done-homv",
    title: "Done homeless",
    is_completed: true,
    completed_at: 1,
  });

  it("auto-expands when the toggle first reveals completed tasks, then respects a manual collapse", async () => {
    const { rerender } = await render(
      <List tasks={[open]} doneTasks={[]} showDone={true} onDiscardTask={noop} />,
      { wrapper: withApp(new LocalStore("test")) },
    );
    // The row is hidden while the (just-mounted, empty) footer is collapsed...
    expect(screen.queryByText("Done in Doing")).toBeNull();

    // ...the toggle then populates it: the empty -> non-empty flip expands it once.
    await rerender(
      <List
        tasks={[open]}
        doneTasks={[doneIn, doneHomeless]}
        showDone={true}
        onDiscardTask={noop}
      />,
    );
    expect(screen.getByText("Done in Doing")).toBeTruthy();

    // A manual collapse wins over the feed-forward.
    await fireEvent.press(screen.getByLabelText("Done (2)"));
    expect(screen.queryByText("Done in Doing")).toBeNull();
  });

  it("stays collapsed when it mounts with tasks already there (toggle was on earlier)", async () => {
    await render(
      <List
        tasks={[open]}
        doneTasks={[doneIn, doneHomeless]}
        showDone={true}
        onDiscardTask={noop}
      />,
      { wrapper: withApp(new LocalStore("test")) },
    );
    expect(screen.getByText("Done (2)")).toBeTruthy();
    expect(screen.queryByText("Done in Doing")).toBeNull();
  });

  it("groups expanded rows by their section, homeless ones last", async () => {
    await render(
      <List
        tasks={[open]}
        sections={[SECTION]}
        doneTasks={[doneIn, doneHomeless]}
        showDone={true}
        onDiscardTask={noop}
      />,
      { wrapper: withApp(new LocalStore("test")) },
    );
    await fireEvent.press(screen.getByLabelText("Done (2)"));

    // The section subtitle and its task plus the sectionless one are all present. The homeless
    // bucket deliberately renders no extra header ("No section" comes from the main list here).
    expect(screen.getAllByText("Doing").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Done in Doing")).toBeTruthy();
    expect(screen.getByText("Done homeless")).toBeTruthy();
  });
});

describe("ProjectTaskList drafts (over a real store)", () => {
  function projectStore() {
    const s = new LocalStore("test");
    const id = s.newEntityId();
    s.set("project", id, "name", "Home reno");
    s.set("project", id, "kind", "project");
    createTask(s, { title: "Existing", project_id: id });
    return { s, id };
  }
  async function openDraftBelow(title: string) {
    await fireEvent.press(screen.getByText(title));
    await fireEvent(screen.getByLabelText("Task title"), "submitEditing");
  }
  const blankIds = (s: LocalStore) =>
    allTasks(s)
      .filter((t) => t.title === "")
      .map((t) => t.id);

  it("removes a freshly created blank row when its rename is cancelled", async () => {
    const { s, id } = projectStore();
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await openDraftBelow("Existing");
    expect(blankIds(s)).toHaveLength(1);

    await fireEvent(screen.getByLabelText("Task title"), "keyPress", {
      nativeEvent: { key: "Escape" },
    });

    expect(blankIds(s)).toHaveLength(0);
    expect(allTasks(s).map((t) => t.title)).toEqual(["Existing"]);
  });

  it("removes the blank draft it was editing when the list goes away", async () => {
    const { s, id } = projectStore();
    const { unmount } = await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await openDraftBelow("Existing");
    expect(blankIds(s)).toHaveLength(1);
    await act(async () => await unmount());

    expect(blankIds(s)).toHaveLength(0);
  });
});

describe("ProjectTaskList keyboard cursor", () => {
  // A project registered nothing, so the cursor kept driving the last smart list -- invisible
  // behind the project -- and x completed one of its tasks.
  let cursor: CursorContextValue;
  function Probe() {
    cursor = useCursor();
    return null;
  }

  it.each([
    ["flat", [] as Section[]],
    ["sectioned", [SECTION]],
  ])("walks and completes the project's own rows (%s)", async (_, sections) => {
    const onToggle = jest.fn();
    await render(
      <>
        <Probe />
        <List
          tasks={[task({ id: "a", title: "First", sort_order: 1 })]}
          sections={sections}
          onDiscardTask={noop}
          onToggle={onToggle}
        />
      </>,
      { wrapper: withApp(new LocalStore("test")) },
    );
    await act(() => cursor.next());
    await act(() => cursor.completeCursor());
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
});

describe("ProjectTaskList reminder marker", () => {
  it("shows the bell on a row whose task has a reminder still to come", async () => {
    const store = new LocalStore("test");
    store.set("reminder", "r1", "task_id", "with");
    store.set("reminder", "r1", "at", NOW + 3_600_000);
    await render(
      <List
        tasks={[
          task({ id: "with", title: "Call mum", sort_order: 1 }),
          task({ id: "none", title: "Plain", sort_order: 2 }),
        ]}
        onDiscardTask={noop}
      />,
      { wrapper: withApp(store) },
    );

    expect(screen.getAllByLabelText("Has reminder")).toHaveLength(1);
  });
});
