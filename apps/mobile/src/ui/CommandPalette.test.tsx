import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Task } from "@atlastodo/client-core";
import type { Command } from "../hooks/useCommands";
import type { TaskSearchSource } from "../hooks/useTaskSearch";
import { CommandPalette } from "./CommandPalette";

/**
 * Presentational: the fuzzy ranking is `@atlastodo/shared`'s `filterActions` and the task matching is
 * its `searchTasks` (both tested there); these assert the palette filters as you type, falls through
 * to the task-results section when no destination matches, and hands the chosen row back -- the
 * navigation step is the container's, not this component's.
 */

const COMMANDS: Command[] = [
  { id: "view:today", label: "Today", href: "/today" },
  { id: "view:inbox", label: "Inbox", href: "/inbox" },
  { id: "view:upcoming", label: "Upcoming", href: "/upcoming" },
];

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "",
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
    ...over,
  };
}

const TASKS = [
  task({ id: "task-1", title: "Buy oat milk", notes: "also coffee" }),
  task({ id: "task-2", title: "Inbox cleanup" }),
];

// The context line is the container's injected formatter (the real one is `useTaskSearch`'s).
const SEARCH: TaskSearchSource = {
  tasks: TASKS,
  context: (t) => (t.notes === "" ? "Inbox" : "Work · Sep 24"),
};

async function mount(opts: { search?: TaskSearchSource; onSelectTask?: (t: Task) => void } = {}) {
  const onSelect = jest.fn();
  const onClose = jest.fn();
  await render(
    <CommandPalette visible commands={COMMANDS} onSelect={onSelect} onClose={onClose} {...opts} />,
  );
  return { onSelect, onClose };
}

describe("CommandPalette", () => {
  it("filters the command list as you type", async () => {
    await mount();
    await fireEvent.changeText(screen.getByLabelText("Command search"), "inb");
    expect(screen.getByLabelText("Inbox")).toBeTruthy();
    expect(screen.queryByLabelText("Today")).toBeNull();
  });

  it("selects the tapped command and closes", async () => {
    const { onSelect, onClose } = await mount();
    await fireEvent.changeText(screen.getByLabelText("Command search"), "upc");
    await fireEvent.press(screen.getByLabelText("Upcoming"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ href: "/upcoming" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("falls through to task results when no destination matches", async () => {
    await mount({ search: SEARCH });
    await fireEvent.changeText(screen.getByLabelText("Command search"), "oat");
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByLabelText("Buy oat milk")).toBeTruthy();
    expect(screen.getByText("Work · Sep 24")).toBeTruthy();
    // Destinations are out of the way while the task section shows.
    expect(screen.queryByLabelText("Today")).toBeNull();
  });

  it("keeps the palette navigation-only when a destination matches", async () => {
    // "inb" fuzzy-matches the Inbox command, so the task section must not appear -- even though a
    // task's title would also match.
    await mount({ search: SEARCH });
    await fireEvent.changeText(screen.getByLabelText("Command search"), "inb");
    expect(screen.getByLabelText("Inbox")).toBeTruthy();
    expect(screen.queryByText("Tasks")).toBeNull();
    expect(screen.queryByLabelText("Inbox cleanup")).toBeNull();
  });

  it("opens the tapped task and closes", async () => {
    const onSelectTask = jest.fn();
    const { onClose } = await mount({ search: SEARCH, onSelectTask });
    await fireEvent.changeText(screen.getByLabelText("Command search"), "oat");
    await fireEvent.press(screen.getByLabelText("Buy oat milk"));
    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("hides the task section entirely without a search source", async () => {
    // The old destinations-only contract: no tasks prop, task titles never match.
    await mount();
    await fireEvent.changeText(screen.getByLabelText("Command search"), "oat");
    expect(screen.queryByText("Tasks")).toBeNull();
    expect(screen.getByText("No matching commands or tasks")).toBeTruthy();
  });
});
