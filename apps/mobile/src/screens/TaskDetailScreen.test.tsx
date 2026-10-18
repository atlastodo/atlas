import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react-native";
import { Keyboard } from "react-native";
import type { ReactNode } from "react";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { FocusProvider } from "../data/FocusProvider";
import { TaskDetailScreen, mergeDueDate, pickedDueDate } from "./TaskDetailScreen";

// Every render needs the store provider (reminder section) and FocusProvider (focus section).
const render = (ui: React.ReactElement) => {
  const Wrapper = withApp(new LocalStore("test"));
  return rtlRender(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <Wrapper>
        <FocusProvider>{children}</FocusProvider>
      </Wrapper>
    ),
  });
};

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

describe("TaskDetailScreen", () => {
  it("buffers the title and saves it on blur, not per keystroke", async () => {
    const onUpdate = jest.fn();
    const t = task();
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

    const field = screen.getByLabelText("Title");
    await fireEvent.changeText(field, "Buy oat milk");
    // Typing must not emit an op per character -- that would be one sync push per keystroke.
    expect(onUpdate).not.toHaveBeenCalled();

    await fireEvent(field, "blur");
    expect(onUpdate).toHaveBeenCalledWith(t, { title: "Buy oat milk" });
  });

  // The blur can arrive before React has re-rendered with the last keystroke (a Tab or a click right
  // after typing); one `act` holds both events with no render in between.
  it.each(["Title", "Notes"])(
    "saves the last keystroke when %s blurs before a re-render",
    async (label) => {
      const onUpdate = jest.fn();
      const t = task();
      await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

      const field = screen.getByLabelText(label);
      await act(async () => {
        await fireEvent.changeText(field, "Buy oat milk");
        await fireEvent(field, "blur");
      });

      const key = label === "Title" ? "title" : "notes";
      expect(onUpdate).toHaveBeenCalledWith(t, { [key]: "Buy oat milk" });
    },
  );

  it("saves a buffered edit when the screen goes away", async () => {
    const onUpdate = jest.fn();
    const t = task();
    const view = await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

    await fireEvent.changeText(screen.getByLabelText("Notes"), "call first");
    // Navigating back unmounts without any blur, and that is the usual way out of this screen.
    await view.unmount();

    expect(onUpdate).toHaveBeenCalledWith(t, { notes: "call first" });
  });

  it("refuses to save an empty title, restoring the original", async () => {
    const onUpdate = jest.fn();
    await render(<TaskDetailScreen task={task()} onUpdate={onUpdate} />);

    const field = screen.getByLabelText("Title");
    await fireEvent.changeText(field, "   ");
    await fireEvent(field, "blur");

    // A task must keep a title; the field snaps back rather than saving nothing.
    expect(onUpdate).not.toHaveBeenCalled();
    expect(field.props.value).toBe("Buy milk");
  });

  it("refuses to save an empty title on the way out, too", async () => {
    const onUpdate = jest.fn();
    const view = await render(<TaskDetailScreen task={task()} onUpdate={onUpdate} />);

    await fireEvent.changeText(screen.getByLabelText("Title"), "   ");
    // The unmount flush calls commit() directly, so it does not get the blur handler's restore --
    // it needs its own guard, or navigating away mid-edit would wipe the title.
    await view.unmount();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not save a title that has not changed", async () => {
    const onUpdate = jest.fn();
    await render(<TaskDetailScreen task={task()} onUpdate={onUpdate} />);

    await fireEvent(screen.getByLabelText("Title"), "blur");

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("reports unsaved changes via onDirtyChange and does not save on unmount when discarded", async () => {
    const onUpdate = jest.fn();
    const onDirtyChange = jest.fn();
    let discardFn: () => void = () => {};
    const t = task();
    const view = await render(
      <TaskDetailScreen
        task={t}
        onUpdate={onUpdate}
        onDirtyChange={onDirtyChange}
        onRegisterDiscard={(fn) => {
          discardFn = fn;
        }}
      />,
    );

    expect(onDirtyChange).toHaveBeenCalledWith(false);

    await fireEvent.changeText(screen.getByLabelText("Title"), "New unsaved title");
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    // Call discard
    await act(() => {
      discardFn();
    });

    await view.unmount();
    // Because discard was called, the unmount commit must NOT save "New unsaved title"
    expect(onUpdate).not.toHaveBeenCalledWith(t, { title: "New unsaved title" });
  });

  it("skips the current occurrence via the Skip button only for a due recurring task", async () => {
    const onSkip = jest.fn();
    const view = await render(
      <TaskDetailScreen
        task={task({ recurrence: "FREQ=DAILY", due_at: 1_700_000_000_000 })}
        onUpdate={() => {}}
        onSkip={onSkip}
      />,
    );
    await fireEvent.press(screen.getByLabelText("Skip occurrence"));
    expect(onSkip).toHaveBeenCalled();
    await view.unmount();

    // No recurrence, no Skip affordance (a completed one is gated out in the op, not the button).
    await render(<TaskDetailScreen task={task()} onUpdate={() => {}} onSkip={onSkip} />);
    expect(screen.queryByLabelText("Skip occurrence")).toBeNull();
  });

  it("sets the priority when a level is pressed", async () => {
    const onUpdate = jest.fn();
    const t = task();
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

    await fireEvent.press(screen.getByLabelText("P1"));

    expect(onUpdate).toHaveBeenCalledWith(t, { priority: 1 });
  });

  it("clears the due date", async () => {
    const onUpdate = jest.fn();
    // Only the due date is set, so the single "No date" clear control belongs to the due row.
    const t = task({ due_at: 1_700_000_000_000 });
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} formatDue={() => "14 Nov 2023"} />);

    await fireEvent.press(screen.getByLabelText("No date"));

    expect(onUpdate).toHaveBeenCalledWith(t, { due_at: null });
  });

  it("shows and clears the start date", async () => {
    const onUpdate = jest.fn();
    const t = task({ start_at: 1_700_000_000_000 });
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} formatDue={() => "14 Nov 2023"} />);

    // The start-date row shows its formatted value; only the start row has a clear here.
    expect(screen.getByLabelText("Start date")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("No date"));

    expect(onUpdate).toHaveBeenCalledWith(t, { start_at: null });
  });

  it("adds a subtask under the current task via the composer", async () => {
    const onAddSubtask = jest.fn();
    await render(
      <TaskDetailScreen task={task()} onUpdate={() => {}} onAddSubtask={onAddSubtask} />,
    );

    // On phone, tap the Add a subtask button to open KeyboardPinnedTaskAdd
    await fireEvent.press(screen.getByRole("button", { name: "Add a subtask" }));

    const composer = screen.getByPlaceholderText("Add a subtask");
    await fireEvent.changeText(composer, "Book flights");
    await fireEvent(composer, "submitEditing");

    expect(onAddSubtask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Book flights",
        parent_id: "t1",
      }),
    );
  });

  it("does not add an empty subtask", async () => {
    const onAddSubtask = jest.fn();
    await render(
      <TaskDetailScreen task={task()} onUpdate={() => {}} onAddSubtask={onAddSubtask} />,
    );

    await fireEvent.press(screen.getByRole("button", { name: "Add a subtask" }));

    const composer = screen.getByPlaceholderText("Add a subtask");
    await fireEvent.changeText(composer, "   ");
    await fireEvent(composer, "submitEditing");

    expect(onAddSubtask).not.toHaveBeenCalled();
  });

  it("allows creating multiple subtasks consecutively via inline QuickAdd on wide screens", async () => {
    const onAddSubtask = jest.fn();
    await render(
      <TaskDetailScreen
        task={task()}
        onUpdate={() => {}}
        onAddSubtask={onAddSubtask}
        isWide={true}
      />,
    );

    const composer = screen.getByLabelText("Add a subtask");
    await fireEvent.changeText(composer, "First subtask");
    await fireEvent(composer, "submitEditing");

    expect(onAddSubtask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "First subtask", parent_id: "t1" }),
    );

    // After submitting, input clears and immediately accepts next subtask without reopening
    await fireEvent.changeText(composer, "Second subtask");
    await fireEvent(composer, "submitEditing");

    expect(onAddSubtask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Second subtask", parent_id: "t1" }),
    );
    expect(onAddSubtask).toHaveBeenCalledTimes(2);
  });

  it("prevents notes and title from stealing focus when subtask modal closes", async () => {
    const keyboardDismissSpy = jest.spyOn(Keyboard, "dismiss");
    const onAddSubtask = jest.fn();
    const { rerender } = await render(
      <TaskDetailScreen
        task={task()}
        onUpdate={() => {}}
        onAddSubtask={onAddSubtask}
        isSubtaskModalOpen={true}
      />,
    );

    const notesInput = screen.getByLabelText("Notes");
    const titleInput = screen.getByLabelText("Title");

    // Modal closes
    await rerender(
      <TaskDetailScreen
        task={task()}
        onUpdate={() => {}}
        onAddSubtask={onAddSubtask}
        isSubtaskModalOpen={false}
      />,
    );

    // On close, inputs are temporarily blocked from focus
    expect(notesInput.props.editable).toBe(false);
    expect(titleInput.props.editable).toBe(false);
    expect(keyboardDismissSpy).toHaveBeenCalled();

    // Trying to focus notes right after close blurs and dismisses keyboard
    await fireEvent(notesInput, "focus");
    expect(keyboardDismissSpy).toHaveBeenCalled();

    keyboardDismissSpy.mockRestore();
  });

  it("lists subtasks with a progress count, and opens/toggles them", async () => {
    const onOpenSubtask = jest.fn();
    const onToggleSubtask = jest.fn();
    const child1 = task({ id: "c1", title: "Book flights" });
    const child2 = task({ id: "c2", title: "Book hotel", is_completed: true });
    await render(
      <TaskDetailScreen
        task={task()}
        onUpdate={() => {}}
        onAddSubtask={() => {}}
        subtasks={[child1, child2]}
        onOpenSubtask={onOpenSubtask}
        onToggleSubtask={onToggleSubtask}
      />,
    );

    // One done of two.
    expect(screen.getByText("1/2")).toBeTruthy();

    // Clicking subtask begins inline rename mode
    await fireEvent.press(screen.getByLabelText("Book flights"));
    // Info button opens the subtask details
    await fireEvent.press(screen.getByLabelText("Task details"));
    expect(onOpenSubtask).toHaveBeenCalledWith(child1);

    // The done child's toggle reads "Reopen task"; pressing it toggles that subtask.
    await fireEvent.press(screen.getByLabelText("Reopen task"));
    expect(onToggleSubtask).toHaveBeenCalledWith(child2);
  });

  it("renames subtasks inline and saves on blur", async () => {
    const onUpdate = jest.fn();
    const child1 = task({ id: "c1", title: "Book flights" });
    await render(
      <TaskDetailScreen
        task={task()}
        onUpdate={onUpdate}
        onAddSubtask={() => {}}
        subtasks={[child1]}
      />,
    );

    await fireEvent.press(screen.getByLabelText("Book flights"));
    const input = screen.getByLabelText("Task title");
    await fireEvent.changeText(input, "Book train");
    await fireEvent(input, "blur");

    expect(onUpdate).toHaveBeenCalledWith(child1, { title: "Book train" });
  });

  it("prompts with RecurringEditModal when editing a recurring task", async () => {
    const onUpdate = jest.fn();
    const onUpdateRecurring = jest.fn();
    const recurringTask = task({
      recurrence: "FREQ=WEEKLY",
      due_at: 1_700_000_000_000,
      priority: 4,
    });

    await render(
      <TaskDetailScreen
        task={recurringTask}
        onUpdate={onUpdate}
        onUpdateRecurring={onUpdateRecurring}
      />,
    );

    // Change priority
    await fireEvent.press(screen.getByLabelText("P1"));

    // Modal should be visible
    expect(screen.getByText("Edit recurring task")).toBeTruthy();
    expect(
      screen.getByText("Do you want to edit just this task, or this and all future tasks?"),
    ).toBeTruthy();

    // Select "Just this task"
    await fireEvent.press(screen.getByLabelText("Just this task"));

    expect(onUpdateRecurring).toHaveBeenCalledWith(
      recurringTask,
      { priority: 1 },
      "this_occurrence",
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("applies a recurrence rule edit to the whole series without prompting", async () => {
    const onUpdate = jest.fn();
    const onUpdateRecurring = jest.fn();
    const recurringTask = task({
      recurrence: "FREQ=DAILY;INTERVAL=3",
      due_at: 1_700_000_000_000,
    });

    await render(
      <TaskDetailScreen
        task={recurringTask}
        onUpdate={onUpdate}
        onUpdateRecurring={onUpdateRecurring}
      />,
    );

    // Switch the series to recompute its next date from the completion time.
    await fireEvent.press(screen.getByLabelText("Schedule next from completion date"));

    expect(screen.queryByText("Edit recurring task")).toBeNull();
    expect(onUpdate).toHaveBeenCalledWith(recurringTask, {
      recurrence: "FREQ=DAILY;INTERVAL=3;MODE=COMPLETION",
    });
    expect(onUpdateRecurring).not.toHaveBeenCalled();
  });

  it("trims a title before saving", async () => {
    const onUpdate = jest.fn();
    const t = task();
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

    await fireEvent.changeText(screen.getByLabelText("Title"), "  Buy oat milk  ");
    await fireEvent(screen.getByLabelText("Title"), "blur");

    expect(onUpdate).toHaveBeenCalledWith(t, { title: "Buy oat milk" });
  });

  it("applies edit to all occurrences when selected in modal", async () => {
    const onUpdateRecurring = jest.fn();
    const recurringTask = task({
      recurrence: "FREQ=DAILY",
      due_at: 1_700_000_000_000,
      priority: 4,
    });

    await render(
      <TaskDetailScreen
        task={recurringTask}
        onUpdate={() => {}}
        onUpdateRecurring={onUpdateRecurring}
      />,
    );

    await fireEvent.press(screen.getByLabelText("P2"));
    await fireEvent.press(screen.getByLabelText("This and future tasks"));

    expect(onUpdateRecurring).toHaveBeenCalledWith(
      recurringTask,
      { priority: 2 },
      "all_occurrences",
    );
  });

  it("cycles priority when the quick priority pill is pressed", async () => {
    const onUpdate = jest.fn();
    const t = task({ priority: 4 });
    await render(<TaskDetailScreen task={t} onUpdate={onUpdate} />);

    const quickPrio = screen.getByLabelText("Priority: None");
    await fireEvent.press(quickPrio);
    expect(onUpdate).toHaveBeenCalledWith(t, { priority: 1 });
  });
});

describe("mergeDueDate", () => {
  it("keeps the existing time of day when the date moves", async () => {
    // A 17:30 deadline moved to another day is still a 17:30 deadline; dragging it to midnight
    // would silently make the task overdue much earlier than the user set.
    const existing = new Date(2024, 2, 5, 17, 30, 0, 0).getTime();
    const merged = new Date(mergeDueDate(existing, new Date(2024, 2, 7)));

    expect(merged.getFullYear()).toBe(2024);
    expect(merged.getMonth()).toBe(2);
    expect(merged.getDate()).toBe(7);
    expect(merged.getHours()).toBe(17);
    expect(merged.getMinutes()).toBe(30);
  });

  it("starts a task with no due date at end of day (23:59) of the chosen day", async () => {
    const merged = new Date(mergeDueDate(null, new Date(2024, 2, 7, 13, 45)));

    expect(merged.getDate()).toBe(7);
    expect(merged.getHours()).toBe(23);
    expect(merged.getMinutes()).toBe(59);
    expect(merged.getSeconds()).toBe(0);
  });

  it("carries the date across a month boundary", async () => {
    const existing = new Date(2024, 0, 31, 9, 0).getTime();
    const merged = new Date(mergeDueDate(existing, new Date(2024, 1, 29)));

    // Feb 29 2024 exists; setFullYear with all three parts must not roll over into March.
    expect(merged.getMonth()).toBe(1);
    expect(merged.getDate()).toBe(29);
    expect(merged.getHours()).toBe(9);
  });
});

describe("pickedDueDate", () => {
  it("writes the merged date when the user picks one", async () => {
    const existing = new Date(2024, 2, 5, 17, 30).getTime();
    expect(pickedDueDate(existing, "set", new Date(2024, 2, 7))).toBe(
      mergeDueDate(existing, new Date(2024, 2, 7)),
    );
  });

  it("writes nothing when the user dismisses the picker", async () => {
    // v8 reports a dismissal through the same callback as a pick, and still hands back a date --
    // so without the event-type guard, cancelling would set the very date the user backed out of.
    expect(pickedDueDate(null, "dismissed", new Date(2024, 2, 7))).toBeNull();
  });

  it("writes nothing when no date comes back", async () => {
    expect(pickedDueDate(null, "set", undefined)).toBeNull();
  });
});

describe("TaskDetailScreen writes only the fields the user edited", () => {
  it("does not revert a title changed elsewhere while the detail was open", async () => {
    const onUpdate = jest.fn();
    const view = await render(
      <TaskDetailScreen task={task({ title: "Old" })} onUpdate={onUpdate} />,
    );

    // Another device renames the task; this screen never touched the title.
    await view.rerender(
      <TaskDetailScreen task={task({ title: "Renamed elsewhere" })} onUpdate={onUpdate} />,
    );
    expect(screen.getByLabelText("Title").props.value).toBe("Renamed elsewhere");
    await view.unmount();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not wipe the notes of a task that became readable while open", async () => {
    const onUpdate = jest.fn();
    const view = await render(
      <TaskDetailScreen task={task({ title: "", locked: true })} onUpdate={onUpdate} />,
    );
    // The project key arrives: the task decrypts in place.
    await view.rerender(
      <TaskDetailScreen
        task={task({ title: "Plan", notes: "the real notes" })}
        onUpdate={onUpdate}
      />,
    );
    expect(screen.getByLabelText("Notes").props.value).toBe("the real notes");
    await view.unmount();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("writes an edited field on the way out without touching the other", async () => {
    const onUpdate = jest.fn();
    const view = await render(
      <TaskDetailScreen task={task({ notes: "old" })} onUpdate={onUpdate} />,
    );

    await fireEvent.changeText(screen.getByLabelText("Title"), "Mine");
    await view.rerender(<TaskDetailScreen task={task({ notes: "theirs" })} onUpdate={onUpdate} />);
    await view.unmount();

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ notes: "theirs" }), {
      title: "Mine",
    });
  });
});

describe("TaskDetailScreen on a recurring task", () => {
  const recurring = () => task({ recurrence: "FREQ=DAILY", due_at: 1_700_000_000_000 });

  it("saves a title edit on the way out, without asking which occurrences", async () => {
    // The this/all prompt cannot show from an unmount, so asking would lose the edit.
    const onUpdate = jest.fn();
    const onUpdateRecurring = jest.fn();
    const t = recurring();
    const view = await render(
      <TaskDetailScreen task={t} onUpdate={onUpdate} onUpdateRecurring={onUpdateRecurring} />,
    );

    await fireEvent.changeText(screen.getByLabelText("Title"), "Stretch longer");
    await view.unmount();

    expect(onUpdate).toHaveBeenCalledWith(t, { title: "Stretch longer" });
    expect(onUpdateRecurring).not.toHaveBeenCalled();
  });

  it("saves notes on Save & Close", async () => {
    const onUpdate = jest.fn();
    let saveAndClose: () => void = () => {};
    const t = recurring();
    await render(
      <TaskDetailScreen
        task={t}
        onUpdate={onUpdate}
        onUpdateRecurring={jest.fn()}
        onRegisterSaveAndClose={(fn) => {
          saveAndClose = fn;
        }}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText("Notes"), "use the mat");
    await act(() => saveAndClose());

    expect(onUpdate).toHaveBeenCalledWith(t, { notes: "use the mat" });
    expect(screen.queryByText("Edit recurring task")).toBeNull();
  });
});

describe("TaskDetailScreen unsaved-changes baseline", () => {
  it("is clean again after a save, so Discard cannot undo what was saved", async () => {
    const onUpdate = jest.fn();
    const onDirtyChange = jest.fn();
    let discard: () => void = () => {};
    const t = task();
    const view = await render(
      <TaskDetailScreen
        task={t}
        onUpdate={onUpdate}
        onDirtyChange={onDirtyChange}
        onRegisterDiscard={(fn) => {
          discard = fn;
        }}
      />,
    );

    await fireEvent.changeText(screen.getByLabelText("Title"), "Buy oat milk");
    await fireEvent(screen.getByLabelText("Title"), "blur");
    expect(onUpdate).toHaveBeenCalledWith(t, { title: "Buy oat milk" });
    // The store now holds the saved title.
    await view.rerender(
      <TaskDetailScreen
        task={task({ title: "Buy oat milk" })}
        onUpdate={onUpdate}
        onDirtyChange={onDirtyChange}
        onRegisterDiscard={(fn) => {
          discard = fn;
        }}
      />,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await act(() => discard());
    await view.unmount();
    // Discard must not write the title the screen opened with back over the saved one.
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("TaskDetailScreen on a task this device cannot decrypt (locked)", () => {
  const LOCKED_TITLE = "Encrypted task — key not available";

  it("shows the placeholder in place of an editable title", async () => {
    await render(
      <TaskDetailScreen task={task({ title: "", locked: true })} onUpdate={jest.fn()} />,
    );

    expect(screen.getByText(LOCKED_TITLE)).toBeTruthy();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("does not write over the unreadable notes on the way out", async () => {
    const onUpdate = jest.fn();
    const view = await render(
      <TaskDetailScreen task={task({ title: "", locked: true })} onUpdate={onUpdate} />,
    );

    // The notes would show "" only because the real ones are still ciphertext; a save would
    // replace them for every member. So there is no field to type into.
    expect(screen.queryByLabelText("Notes")).toBeNull();
    await view.unmount();

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers no editor at all: every value would be a placeholder", async () => {
    // The pickers wrote placeholder-derived values (labels [] + one, a recurrence, an estimate)
    // over the real ones, and duplicate/move/subtask/comment acted on a task nobody here can read.
    await render(
      <TaskDetailScreen
        task={task({ title: "", locked: true })}
        onUpdate={jest.fn()}
        onUpdateRecurring={jest.fn()}
        onAddSubtask={jest.fn()}
        onDuplicate={jest.fn()}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onSkip={jest.fn()}
      />,
    );

    expect(screen.getByText(/can be read and edited once the key arrives/)).toBeTruthy();
    for (const label of [
      "Add a subtask",
      "Duplicate",
      "Archive",
      "Delete",
      "Move to",
      "Daily",
      "Add label",
      "P1",
      "Pick a date",
      "Estimate in minutes",
    ]) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    expect(screen.queryByPlaceholderText("Write a comment…")).toBeNull();
  });

  it("shows a locked subtask as the placeholder, with no rename", async () => {
    const onToggleSubtask = jest.fn();
    await render(
      <TaskDetailScreen
        task={task()}
        onUpdate={jest.fn()}
        subtasks={[task({ id: "sub", parent_id: "t1", title: "", locked: true })]}
        onAddSubtask={jest.fn()}
        onToggleSubtask={onToggleSubtask}
      />,
    );

    await fireEvent.press(screen.getByText(LOCKED_TITLE));
    expect(screen.queryByLabelText("Task title")).toBeNull();
    expect(screen.queryByLabelText("Complete task")).toBeNull();
    expect(onToggleSubtask).not.toHaveBeenCalled();
  });
});

describe("Option A Modern Card & Quick-Pills redesign", () => {
  it("toggles the main task completion via the hero completion button", async () => {
    const onToggle = jest.fn();
    const t = task({ is_completed: false });
    await render(<TaskDetailScreen task={t} onUpdate={jest.fn()} onToggle={onToggle} />);

    const completeBtn = screen.getByLabelText("Complete task");
    expect(completeBtn).toBeTruthy();
    await fireEvent.press(completeBtn);
    expect(onToggle).toHaveBeenCalledWith(t);
  });
});
