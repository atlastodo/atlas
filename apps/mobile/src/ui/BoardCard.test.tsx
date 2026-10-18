import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Task } from "@atlastodo/client-core";
import { BoardCard } from "./BoardCard";

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

describe("BoardCard", () => {
  it("shows the title and completes on the toggle", async () => {
    const onToggle = jest.fn();
    const t = task();
    await render(<BoardCard task={t} now={NOW} onToggle={onToggle} />);

    expect(screen.getByText("Buy milk")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Complete task"));
    expect(onToggle).toHaveBeenCalledWith(t);
  });

  describe("a task this device cannot decrypt (locked)", () => {
    it("shows the placeholder, and can be neither completed nor dragged", async () => {
      const onToggle = jest.fn();
      const drag = jest.fn();
      const onOpen = jest.fn();
      const t = task({ title: "", locked: true });
      await render(
        <BoardCard task={t} now={NOW} onToggle={onToggle} onOpen={onOpen} drag={drag} />,
      );

      expect(screen.getByText(LOCKED_TITLE)).toBeTruthy();
      expect(screen.queryByLabelText("Complete task")).toBeNull();
      await fireEvent(screen.getByText(LOCKED_TITLE), "longPress");
      expect(drag).not.toHaveBeenCalled();
      expect(onToggle).not.toHaveBeenCalled();

      // Opening stays available: the detail is where the task can still be moved or trashed.
      await fireEvent.press(screen.getByText(LOCKED_TITLE));
      expect(onOpen).toHaveBeenCalledWith(t);
    });
  });
});
