import { fireEvent, render, screen, act } from "@testing-library/react-native";
import type { Task } from "@atlas/client-core";
import { createRef } from "react";
import { Platform } from "react-native";
import { TaskRow, type TaskRowHandle } from "./TaskRow";

/** A task with every field set, so each test only states what it actually cares about. */
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

describe("TaskRow", () => {
  it("completes an open task when the toggle is pressed", async () => {
    const onToggle = jest.fn();
    const t = task();
    await render(<TaskRow task={t} now={NOW} onToggle={onToggle} />);

    await fireEvent.press(screen.getByLabelText("Complete task"));

    expect(onToggle).toHaveBeenCalledWith(t);
  });

  it("opens the task from anywhere on the row, not just the title", async () => {
    const onOpen = jest.fn();
    const t = task({ due_at: NOW });
    await render(
      <TaskRow task={t} now={NOW} onToggle={() => {}} onOpen={onOpen} formatDue={() => "soon"} />,
    );

    // The whole row is the open target; a tap on the due date (not the title) must open it too.
    await fireEvent.press(screen.getByText("soon"));

    expect(onOpen).toHaveBeenCalledWith(t);
  });

  it("does not open a task when there is nowhere to open it", async () => {
    const onToggle = jest.fn();
    await render(<TaskRow task={task()} now={NOW} onToggle={onToggle} />);

    // No onOpen: pressing the title must not fall through to completing the task.
    await fireEvent.press(screen.getByText("Buy milk"));

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("shows the first line of the notes, marked when more follow", async () => {
    await render(
      <TaskRow task={task({ notes: "call the shop\nthen pay" })} now={NOW} onToggle={() => {}} />,
    );
    expect(screen.getByText(/call the shop/)).toBeTruthy();
    expect(screen.getByText(/\.\.\./)).toBeTruthy();
  });

  it("shows a priority flag only below P4", async () => {
    await render(<TaskRow task={task({ priority: 1 })} now={NOW} onToggle={() => {}} />);
    expect(screen.getByLabelText("Priority 1")).toBeTruthy();

    await screen.rerender(<TaskRow task={task({ priority: 4 })} now={NOW} onToggle={() => {}} />);
    // P4 is the default "no priority" -- flagging every task would make the marker meaningless.
    expect(screen.queryByLabelText(/^Priority/)).toBeNull();
  });

  it("orders the markers recurrence, reminder, priority, then the date last", async () => {
    await render(
      <TaskRow
        task={task({ priority: 1, recurrence: "FREQ=DAILY", due_at: NOW })}
        now={NOW}
        onToggle={() => {}}
        hasReminder
        formatDue={() => "soon"}
      />,
    );
    const order: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") {
        if (node === "soon") order.push("date");
        return;
      }
      if (Array.isArray(node)) return node.forEach(walk);
      const { props, children } = node as {
        props?: { accessibilityLabel?: string };
        children?: unknown[];
      };
      const label = props?.accessibilityLabel;
      if (label && /^(Recurring|Has reminder|Priority 1)$/i.test(label)) order.push(label);
      (children ?? []).forEach(walk);
    };
    walk(screen.toJSON());

    // The date stays rightmost and the markers pack against it, so a lone bell sits by the date.
    expect(order).toEqual(["Recurring", "Has reminder", "Priority 1", "date"]);
  });

  it("renders a text input and info icon when isEditing is true", async () => {
    const onOpen = jest.fn();
    const onSaveRename = jest.fn();
    const t = task();
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onOpen={onOpen}
        onSaveRename={onSaveRename}
      />,
    );

    const input = screen.getByLabelText("Task title");
    expect(input.props.value).toBe("Buy milk");

    // Info icon is present when editing
    const infoButton = screen.getByLabelText("Task details");
    expect(infoButton).toBeTruthy();
    await fireEvent.press(infoButton);
    expect(onOpen).toHaveBeenCalledWith(t);
  });

  it("saves updated title and opens details when clicking the info icon while editing", async () => {
    const onOpen = jest.fn();
    const onSaveRename = jest.fn();
    const t = task();
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onOpen={onOpen}
        onSaveRename={onSaveRename}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "Buy almond milk");

    const infoButton = screen.getByLabelText("Task details");
    await fireEvent.press(infoButton);

    expect(onSaveRename).toHaveBeenCalledWith(t, "Buy almond milk");
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id, title: "Buy almond milk" }),
    );
  });

  it("saves updated title on blur when editing", async () => {
    const onSaveRename = jest.fn();
    const t = task();
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onSaveRename={onSaveRename}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "Buy oat milk");
    await fireEvent(input, "blur");

    expect(onSaveRename).toHaveBeenCalledWith(t, "Buy oat milk");
  });

  it("reverts to original title if blurred with empty text", async () => {
    const onSaveRename = jest.fn();
    const t = task({ title: "Keep original" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onSaveRename={onSaveRename}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "   ");
    await fireEvent(input, "blur");

    expect(onSaveRename).toHaveBeenCalledWith(t, "Keep original");
  });

  it("calls onSubmitRenameAndAddBelow when pressing enter on an existing task without changing its name", async () => {
    const onSaveRename = jest.fn();
    const onSubmitRenameAndAddBelow = jest.fn();
    const t = task({ title: "Existing task" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onSaveRename={onSaveRename}
        onSubmitRenameAndAddBelow={onSubmitRenameAndAddBelow}
      />,
    );

    const input = screen.getByLabelText("Task title");
    // User does not change text, just hits enter
    await fireEvent(input, "submitEditing");

    expect(onSubmitRenameAndAddBelow).toHaveBeenCalledWith(t, "Existing task");
  });

  it("calls onSubmitRenameAndAddBelow when submitting a newly created empty task with text", async () => {
    const onSubmitRenameAndAddBelow = jest.fn();
    const t = task({ title: "" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onSubmitRenameAndAddBelow={onSubmitRenameAndAddBelow}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "Buy eggs");
    await fireEvent(input, "submitEditing");

    expect(onSubmitRenameAndAddBelow).toHaveBeenCalledWith(t, "Buy eggs");
  });

  it("cancels when submitting a newly created empty task without text", async () => {
    const onCancelRename = jest.fn();
    const t = task({ title: "" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onCancelRename={onCancelRename}
        onSubmitRenameAndAddBelow={jest.fn()}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "   ");
    await fireEvent(input, "submitEditing");

    expect(onCancelRename).toHaveBeenCalledWith(t);
  });

  it("passes empty string when saving or submitting a task that was initially empty", async () => {
    const onSaveRename = jest.fn();
    const t = task({ title: "" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        isEditing={true}
        onSaveRename={onSaveRename}
      />,
    );

    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "   ");
    await fireEvent(input, "blur");

    expect(onSaveRename).toHaveBeenCalledWith(t, "");
  });

  it("configures indent swipe for top-level task when onIndent is provided and canIndent is true", async () => {
    const onIndent = jest.fn();
    const t = task({ parent_id: null });
    const { toJSON } = await render(
      <TaskRow task={t} now={NOW} onToggle={() => {}} onIndent={onIndent} canIndent={true} />,
    );
    expect(toJSON()).toBeTruthy();
  });

  it("configures outdent swipe for subtask when onOutdent is provided and canOutdent is true", async () => {
    const onOutdent = jest.fn();
    const t = task({ parent_id: "parent-1" });
    const { toJSON } = await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        onOutdent={onOutdent}
        canOutdent={true}
        depth={1}
      />,
    );
    expect(toJSON()).toBeTruthy();
  });

  it("supports configurable swipe actions from the list's preferences", async () => {
    const onDelete = jest.fn();
    const onToggle = jest.fn();
    const t = task();

    const { toJSON } = await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={onToggle}
        onDelete={onDelete}
        swipeRightAction="delete"
        swipeLeftAction="complete"
      />,
    );
    expect(toJSON()).toBeTruthy();
  });

  it("does not start rename or open task if pointer was dragged before releasing", async () => {
    const onStartRename = jest.fn();
    const onOpen = jest.fn();
    const t = task();
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        onStartRename={onStartRename}
        onOpen={onOpen}
      />,
    );

    const pressable = screen.getByText("Buy milk");
    await fireEvent(pressable, "pressIn", { nativeEvent: { pageX: 10, pageY: 10 } });
    await fireEvent(pressable, "pointerMove", { nativeEvent: { pageX: 80, pageY: 10 } });
    await fireEvent.press(pressable);

    expect(onStartRename).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders collapsible icon on the right and calls onToggleExpand when pressed", async () => {
    const onToggleExpand = jest.fn();
    const t = task({ id: "parent-task" });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        onToggleExpand={onToggleExpand}
        expanded={true}
      />,
    );

    const collapseButton = screen.getByLabelText("Hide subtasks");
    expect(collapseButton).toBeTruthy();
    await fireEvent.press(collapseButton);
    expect(onToggleExpand).toHaveBeenCalledWith(t);
  });

  describe("commitRename (the keyboard toolbar's Done)", () => {
    it("saves the current draft and leaves rename mode", async () => {
      const onSaveRename = jest.fn();
      const t = task();
      const ref = createRef<TaskRowHandle>();
      await render(
        <TaskRow
          ref={ref}
          task={t}
          now={NOW}
          onToggle={() => {}}
          isEditing={true}
          onSaveRename={onSaveRename}
        />,
      );

      await fireEvent.changeText(screen.getByLabelText("Task title"), "Buy oat milk");
      await act(() => {
        ref.current?.commitRename();
      });

      expect(onSaveRename).toHaveBeenCalledWith(t, "Buy oat milk");
    });

    it("does not save again on the keyboard dismissal that follows", async () => {
      const onSaveRename = jest.fn();
      const t = task();
      const ref = createRef<TaskRowHandle>();
      await render(
        <TaskRow
          ref={ref}
          task={t}
          now={NOW}
          onToggle={() => {}}
          isEditing={true}
          onSaveRename={onSaveRename}
        />,
      );

      await fireEvent.changeText(screen.getByLabelText("Task title"), "Buy oat milk");
      await act(() => {
        ref.current?.commitRename();
      });
      // The commit happens while the input still holds focus (the caller dismisses the keyboard
      // right after); that trailing blur must not save a second time.
      await fireEvent(screen.getByLabelText("Task title"), "blur");

      expect(onSaveRename).toHaveBeenCalledTimes(1);
    });

    it("falls back to the old title when the draft is blank", async () => {
      const onSaveRename = jest.fn();
      const t = task({ title: "Keep original" });
      const ref = createRef<TaskRowHandle>();
      await render(
        <TaskRow
          ref={ref}
          task={t}
          now={NOW}
          onToggle={() => {}}
          isEditing={true}
          onSaveRename={onSaveRename}
        />,
      );

      await fireEvent.changeText(screen.getByLabelText("Task title"), "   ");
      await act(() => {
        ref.current?.commitRename();
      });

      expect(onSaveRename).toHaveBeenCalledWith(t, "Keep original");
    });
  });

  describe("a task this device cannot decrypt (locked)", () => {
    const LOCKED_TITLE = "Encrypted task — key not available";
    const locked = () => task({ title: "", locked: true });

    it("shows the placeholder instead of the (empty) title", async () => {
      await render(<TaskRow task={locked()} now={NOW} onToggle={() => {}} />);
      expect(screen.getByText(LOCKED_TITLE)).toBeTruthy();
    });

    it("offers no rename: a tap opens the task instead", async () => {
      const onStartRename = jest.fn();
      const onOpen = jest.fn();
      const t = locked();
      await render(
        <TaskRow
          task={t}
          now={NOW}
          onToggle={() => {}}
          onStartRename={onStartRename}
          onOpen={onOpen}
        />,
      );

      await fireEvent.press(screen.getByText(LOCKED_TITLE));

      expect(onStartRename).not.toHaveBeenCalled();
      expect(onOpen).toHaveBeenCalledWith(t);
    });

    it("cannot be completed or dragged", async () => {
      const onToggle = jest.fn();
      const onLongPress = jest.fn();
      await render(
        <TaskRow task={locked()} now={NOW} onToggle={onToggle} onLongPress={onLongPress} />,
      );

      expect(screen.queryByLabelText("Complete task")).toBeNull();
      await fireEvent(screen.getByText(LOCKED_TITLE), "longPress");

      expect(onToggle).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
    });
  });

  it("shows when a task was completed instead of its due date on Completed", async () => {
    const t = task({ is_completed: true, completed_at: 2, due_at: 1 });
    await render(
      <TaskRow
        task={t}
        now={NOW}
        onToggle={() => {}}
        showCompletedAt
        formatDue={(ms) => (ms === 2 ? "done-day" : "due-day")}
      />,
    );

    expect(screen.getByLabelText("Completed done-day")).toBeTruthy();
    expect(screen.queryByText("due-day")).toBeNull();
  });

  describe("web hover actions", () => {
    const os = Platform.OS;
    const matchMedia = (globalThis as { matchMedia?: unknown }).matchMedia;
    const pointer = (canHover: boolean) => {
      (globalThis as { matchMedia?: unknown }).matchMedia = () => ({
        matches: canHover,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    };
    beforeEach(() => {
      (Platform as { OS: string }).OS = "web";
    });
    afterEach(() => {
      (Platform as { OS: string }).OS = os;
      (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
    });

    it("offers info and reschedule for a pointer that can hover", async () => {
      pointer(true);
      await render(
        <TaskRow
          task={task()}
          now={NOW}
          onToggle={() => {}}
          onOpen={() => {}}
          onSchedule={() => {}}
        />,
      );

      expect(screen.getByLabelText("Task details")).toBeTruthy();
      expect(screen.getByLabelText("Reschedule")).toBeTruthy();
    });

    // On touch they would stick after a tap and take room from the title.
    it("renders no hover actions on a touch screen", async () => {
      pointer(false);
      await render(
        <TaskRow
          task={task()}
          now={NOW}
          onToggle={() => {}}
          onOpen={() => {}}
          onSchedule={() => {}}
        />,
      );

      expect(screen.queryByLabelText("Task details")).toBeNull();
      expect(screen.queryByLabelText("Reschedule")).toBeNull();
    });
  });
});
