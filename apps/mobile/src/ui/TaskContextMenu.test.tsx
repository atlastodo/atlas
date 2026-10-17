import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Task } from "@atlastodo/client-core";
import { TaskContextMenu } from "./TaskContextMenu";

/** A minimal open task; each test only cares about a couple of fields. */
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

const NOW = Date.parse("2026-07-17T12:00:00Z");

async function renderMenu(overrides: Partial<React.ComponentProps<typeof TaskContextMenu>> = {}) {
  const props = {
    task: task(),
    x: 10,
    y: 10,
    now: NOW,
    onClose: jest.fn(),
    onToggle: jest.fn(),
    onSetPriority: jest.fn(),
    onSetDue: jest.fn(),
    onCopy: jest.fn(),
    onDuplicate: jest.fn(),
    onDelete: jest.fn(),
    onSelect: jest.fn(),
    ...overrides,
  };
  await render(<TaskContextMenu {...props} />);
  return props;
}

describe("TaskContextMenu", () => {
  it("marks the due preset matching the task's due day as current", async () => {
    await renderMenu({
      task: task({ due_at: Date.parse("2026-07-18T15:00:00Z") }),
      timeZone: "UTC",
    });
    expect(screen.getByLabelText("Tomorrow").props.accessibilityState?.selected).toBe(true);
    expect(screen.getByLabelText("Today").props.accessibilityState?.selected).toBeFalsy();
    expect(screen.getByLabelText("No date").props.accessibilityState?.selected).toBeFalsy();
  });

  it("marks No date as current for an undated task", async () => {
    await renderMenu();
    expect(screen.getByLabelText("No date").props.accessibilityState?.selected).toBe(true);
  });

  it("completes the task and closes", async () => {
    const props = await renderMenu();
    await fireEvent.press(screen.getByLabelText("Complete task"));
    expect(props.onToggle).toHaveBeenCalledWith(props.task);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("skips a recurring task's occurrence when onSkip is wired", async () => {
    const props = await renderMenu({
      task: task({ recurrence: "FREQ=DAILY", due_at: NOW }),
      onSkip: jest.fn(),
    });
    await fireEvent.press(screen.getByLabelText("Skip occurrence"));
    expect(props.onSkip).toHaveBeenCalledWith(props.task);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("offers no Skip for non-recurring, completed, or undated tasks", async () => {
    await renderMenu({ task: task({ due_at: NOW }), onSkip: jest.fn() });
    expect(screen.queryByLabelText("Skip occurrence")).toBeNull();

    await renderMenu({
      task: task({ recurrence: "FREQ=DAILY", due_at: NOW, is_completed: true }),
      onSkip: jest.fn(),
    });
    expect(screen.queryByLabelText("Skip occurrence")).toBeNull();

    await renderMenu({ task: task({ recurrence: "FREQ=DAILY" }), onSkip: jest.fn() });
    expect(screen.queryByLabelText("Skip occurrence")).toBeNull();
  });

  it("labels each priority and marks the current one", async () => {
    const props = await renderMenu({ task: task({ priority: 2 }) });
    for (const text of ["P1", "P2", "P3", "None"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByLabelText("Priority 2").props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText("No priority").props.accessibilityState.selected).toBe(false);

    await fireEvent.press(screen.getByLabelText("No priority"));
    expect(props.onSetPriority).toHaveBeenCalledWith(props.task, 4);
  });

  it("schedules to a preset and clears the date", async () => {
    const props = await renderMenu();
    await fireEvent.press(screen.getByLabelText("Today"));
    expect(props.onSetDue).toHaveBeenCalledWith(props.task, expect.any(Number));

    await fireEvent.press(screen.getByLabelText("No date"));
    expect(props.onSetDue).toHaveBeenCalledWith(props.task, null);
  });

  it("offers Outdent only for a subtask (canOutdent)", async () => {
    const onOutdent = jest.fn();
    // A top-level task cannot outdent -> no item.
    await renderMenu({ onOutdent, canOutdent: false });
    expect(screen.queryByLabelText("Outdent")).toBeNull();

    // A subtask can.
    const props = await renderMenu({ onOutdent, canOutdent: true, task: task({ parent_id: "p" }) });
    await fireEvent.press(screen.getByLabelText("Outdent"));
    expect(onOutdent).toHaveBeenCalledWith(props.task);
  });

  it("offers Indent only when there is a sibling to nest under (canIndent)", async () => {
    await renderMenu({ onIndent: jest.fn(), canIndent: false });
    expect(screen.queryByLabelText("Indent (make subtask)")).toBeNull();
  });

  it("shows no Indent/Outdent when the list does not support nesting", async () => {
    await renderMenu();
    expect(screen.queryByLabelText("Indent (make subtask)")).toBeNull();
    expect(screen.queryByLabelText("Outdent")).toBeNull();
  });

  it("offers only Select on a task this device cannot decrypt", async () => {
    // Complete, priority, due, copy, duplicate, indent and delete all wrote (or copied) a task
    // whose fields are placeholders here.
    const props = await renderMenu({
      task: task({ title: "", locked: true }),
      onIndent: jest.fn(),
      onOutdent: jest.fn(),
      canOutdent: true,
    });
    expect(screen.getByText("Encrypted task — key not available")).toBeTruthy();
    for (const label of [
      "Complete task",
      "Copy",
      "Duplicate",
      "Delete",
      "Today",
      "Indent (make subtask)",
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    await fireEvent.press(screen.getByRole("menuitem", { name: "Select" }));
    expect(props.onSelect).toHaveBeenCalledWith(props.task);
  });

  describe("on a multi-task selection", () => {
    function bulk(tasks: Task[]) {
      return {
        tasks,
        onToggle: jest.fn(),
        onSetPriority: jest.fn(),
        onSetDue: jest.fn(),
        onCopy: jest.fn(),
        onDuplicate: jest.fn(),
        onDelete: jest.fn(),
        onMove: jest.fn(),
        onLabels: jest.fn(),
      };
    }

    it("applies every action to the whole selection", async () => {
      const b = bulk([task(), task({ id: "t2" })]);
      const props = await renderMenu({ bulk: b });
      expect(screen.getByText("2 selected")).toBeTruthy();

      await fireEvent.press(screen.getByLabelText("Complete task"));
      expect(b.onToggle).toHaveBeenCalledTimes(1);
      expect(props.onToggle).not.toHaveBeenCalled();

      await fireEvent.press(screen.getByLabelText("Priority 1"));
      expect(b.onSetPriority).toHaveBeenCalledWith(1);
      await fireEvent.press(screen.getByLabelText("No date"));
      expect(b.onSetDue).toHaveBeenCalledWith(null);
      await fireEvent.press(screen.getByLabelText("Move to"));
      expect(b.onMove).toHaveBeenCalledTimes(1);
      await fireEvent.press(screen.getByLabelText("Labels"));
      expect(b.onLabels).toHaveBeenCalledTimes(1);
      await fireEvent.press(screen.getByLabelText("Delete"));
      expect(b.onDelete).toHaveBeenCalledTimes(1);
      expect(props.onDelete).not.toHaveBeenCalled();
    });

    it("hides the single-task items", async () => {
      await renderMenu({
        bulk: bulk([task(), task({ id: "t2" })]),
        canIndent: true,
        onIndent: jest.fn(),
      });
      expect(screen.queryByLabelText("Select")).toBeNull();
      expect(screen.queryByText(/Indent/)).toBeNull();
    });

    it("offers Reopen when all are done and marks only shared values", async () => {
      await renderMenu({
        bulk: bulk([
          task({ is_completed: true, priority: 1 }),
          task({ id: "t2", is_completed: true, priority: 2 }),
        ]),
      });
      expect(screen.getByLabelText("Reopen task")).toBeTruthy();
      expect(screen.getByLabelText("Priority 1").props.accessibilityState?.selected).toBeFalsy();
      // Both undated: No date is shared, so it is marked.
      expect(screen.getByLabelText("No date").props.accessibilityState?.selected).toBe(true);
    });
  });
});
