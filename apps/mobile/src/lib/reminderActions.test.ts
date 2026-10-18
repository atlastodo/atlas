import type { Task } from "@atlastodo/client-core";
import type { Reminder } from "@atlastodo/shared";
import {
  REMINDER_COMPLETE_ACTION,
  REMINDER_SNOOZE_ACTION,
  SNOOZE_INTERVAL_MS,
  planReminderResponse,
  type ReminderResponse,
} from "./reminderActions";

/**
 * The notification-action decision rules, pure: which store write a Complete / Snooze press asks
 * for, and the stale-tap cases (unknown reminder, completed or deleted task, a plain banner tap)
 * that must all be safe no-ops. The handler in `useReminderScheduler` applies what this returns.
 */

const NOW = 1_700_000_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Task",
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

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    task_id: "t1",
    at: null,
    offset_min_before_due: null,
    fired_at: null,
    created_at: 0,
    ...overrides,
  };
}

function press(
  actionIdentifier: string,
  reminderId = "r1",
  notificationDate = 1,
): ReminderResponse {
  return { actionIdentifier, reminderId, notificationDate };
}

function plan(response: ReminderResponse, tasks: Task[] = [task()], reminders = [reminder()]) {
  return planReminderResponse(response, { reminders, tasks, now: NOW });
}

describe("planReminderResponse", () => {
  it("plans a complete for an active task", () => {
    expect(plan(press(REMINDER_COMPLETE_ACTION))).toEqual({ kind: "complete", task: task() });
  });

  it("plans a snooze one hour out from the press, replacing the reminder's anchor", () => {
    expect(plan(press(REMINDER_SNOOZE_ACTION))).toEqual({
      kind: "snooze",
      reminderId: "r1",
      at: NOW + SNOOZE_INTERVAL_MS,
    });
  });

  it("ignores a plain tap on the banner (only the two action identifiers act)", () => {
    expect(plan(press("expo.modules.notifications.actions.DEFAULT"))).toEqual({ kind: "ignore" });
  });

  it("ignores a press on a reminder that no longer exists", () => {
    expect(plan(press(REMINDER_COMPLETE_ACTION, "ghost"))).toEqual({ kind: "ignore" });
    expect(plan(press(REMINDER_SNOOZE_ACTION, "ghost"))).toEqual({ kind: "ignore" });
  });

  it("ignores a press on an already-completed task -- completing again would reopen it", () => {
    expect(plan(press(REMINDER_COMPLETE_ACTION), [task({ is_completed: true })])).toEqual({
      kind: "ignore",
    });
    expect(plan(press(REMINDER_SNOOZE_ACTION), [task({ is_completed: true })])).toEqual({
      kind: "ignore",
    });
  });

  it("ignores a press on a deleted task (a trashed task is not in the visible set)", () => {
    expect(plan(press(REMINDER_COMPLETE_ACTION), [])).toEqual({ kind: "ignore" });
    expect(plan(press(REMINDER_SNOOZE_ACTION), [])).toEqual({ kind: "ignore" });
  });

  it("ignores a Complete on a locked task: its blank fields are placeholders, not its data", () => {
    const locked = task({ title: "", locked: true });
    expect(plan(press(REMINDER_COMPLETE_ACTION), [locked])).toEqual({ kind: "ignore" });
  });

  it("still snoozes a locked task's reminder, which touches only the reminder", () => {
    const locked = task({ title: "", locked: true });
    expect(plan(press(REMINDER_SNOOZE_ACTION), [locked]).kind).toBe("snooze");
  });
});
