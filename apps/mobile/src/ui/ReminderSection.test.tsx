import { fireEvent, render as render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { isTrashed, toReminder } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { ReminderSection } from "./ReminderSection";

/** Over a real in-memory `LocalStore`: the section writes and removes `reminder` entities. */

function baseTask(overrides: Partial<Task> = {}): Task {
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

const remindersFor = (s: LocalStore, taskId: string) =>
  s
    .list("reminder")
    .filter((e) => !isTrashed(e.fields))
    .map((e) => toReminder(e.id, e.fields))
    .filter((r) => r.task_id === taskId);

describe("ReminderSection", () => {
  it("adds a before-due reminder when the task has a due date", async () => {
    const s = new LocalStore("test");
    const task = baseTask({ due_at: Date.now() + 3_600_000 });
    await render(<ReminderSection task={task} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("1 week before"));

    const rs = remindersFor(s, task.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.offset_min_before_due).toBe(7 * 24 * 60);
  });

  it("offers no before-due offsets without a due date", async () => {
    const s = new LocalStore("test");
    await render(<ReminderSection task={baseTask({ due_at: null })} />, { wrapper: withApp(s) });
    // A "before due" offset is meaningless with no due date.
    expect(screen.queryByLabelText("1 week before")).toBeNull();
  });

  it("lists an existing reminder and removes it", async () => {
    const s = new LocalStore("test");
    const task = baseTask();
    const id = s.newEntityId();
    s.set("reminder", id, "task_id", task.id);
    s.set("reminder", id, "at", Date.now() + 3_600_000);
    s.set("reminder", id, "created_at", Date.now());
    await render(<ReminderSection task={task} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("Remove reminder"));
    // Soft-deleted (recoverable via Trash), so it drops out of the section.
    expect(remindersFor(s, task.id)).toHaveLength(0);
  });

  it("replaces existing reminder when changing offset or setting a new one", async () => {
    const s = new LocalStore("test");
    const task = baseTask({ due_at: Date.now() + 3_600_000 });
    await render(<ReminderSection task={task} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("1 week before"));
    let rs = remindersFor(s, task.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.offset_min_before_due).toBe(7 * 24 * 60);

    // Pressing a different offset updates the single reminder rather than adding a second one
    await fireEvent.press(screen.getByLabelText("10 mins before"));
    rs = remindersFor(s, task.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.offset_min_before_due).toBe(10);

    // Pressing 1 day before
    await fireEvent.press(screen.getByLabelText("1 day before"));
    rs = remindersFor(s, task.id);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.offset_min_before_due).toBe(24 * 60);
  });

  it("does not render an enable-notifications checkbox (that lives in Settings)", async () => {
    const s = new LocalStore("test");
    await render(<ReminderSection task={baseTask()} />, { wrapper: withApp(s) });

    expect(screen.queryByLabelText("Enable notifications (this device)")).toBeNull();
  });
});
