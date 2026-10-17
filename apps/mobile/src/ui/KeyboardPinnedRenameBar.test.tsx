import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Task } from "@atlastodo/client-core";
import { KeyboardPinnedRenameBar } from "./KeyboardPinnedRenameBar";

const mockTask: Task = {
  id: "t1",
  title: "Buy groceries",
  notes: "Milk, eggs, bread",
  project_id: "p1",
  section_id: null,
  due_at: Date.now() + 86400000,
  priority: 2,
  is_completed: false,
  completed_at: null,
  parent_id: null,
  sort_order: 1000,
  label_ids: [],
  recurrence: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  start_at: null,
  assignee_id: null,
  estimate_min: null,
  archived_at: null,
  deleted_at: null,
};

describe("KeyboardPinnedRenameBar", () => {
  it("calls onOpenDescription when description button is pressed", async () => {
    const onOpenDescription = jest.fn();
    await render(
      <KeyboardPinnedRenameBar
        task={mockTask}
        onOpenDescription={onOpenDescription}
        onOpenDue={jest.fn()}
        onCyclePriority={jest.fn()}
        onOpenMove={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Notes"));
    expect(onOpenDescription).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenDue when due date button is pressed", async () => {
    const onOpenDue = jest.fn();
    await render(
      <KeyboardPinnedRenameBar
        task={mockTask}
        onOpenDescription={jest.fn()}
        onOpenDue={onOpenDue}
        onCyclePriority={jest.fn()}
        onOpenMove={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Due date"));
    expect(onOpenDue).toHaveBeenCalledTimes(1);
  });

  it("calls onCyclePriority when priority button is pressed", async () => {
    const onCyclePriority = jest.fn();
    await render(
      <KeyboardPinnedRenameBar
        task={mockTask}
        onOpenDescription={jest.fn()}
        onOpenDue={jest.fn()}
        onCyclePriority={onCyclePriority}
        onOpenMove={jest.fn()}
        onDone={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Priority"));
    expect(onCyclePriority).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenMove when project button is pressed", async () => {
    const onOpenMove = jest.fn();
    await render(
      <KeyboardPinnedRenameBar
        task={mockTask}
        onOpenDescription={jest.fn()}
        onOpenDue={jest.fn()}
        onCyclePriority={jest.fn()}
        onOpenMove={onOpenMove}
        onDone={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Project"));
    expect(onOpenMove).toHaveBeenCalledTimes(1);
  });

  it("calls onDone when done button is pressed", async () => {
    const onDone = jest.fn();
    await render(
      <KeyboardPinnedRenameBar
        task={mockTask}
        onOpenDescription={jest.fn()}
        onOpenDue={jest.fn()}
        onCyclePriority={jest.fn()}
        onOpenMove={jest.fn()}
        onDone={onDone}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Done"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
