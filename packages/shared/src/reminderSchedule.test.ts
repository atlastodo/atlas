import { describe, it, expect, vi } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  adoptBooked,
  futureReminders,
  reconcileNotifications,
  reconcileSchedule,
  reminderBody,
  reminderTitle,
} from "./reminderSchedule";
import type { Reminder } from "./reminders";
import { makeInstant } from "./zonedTime";

const NOW = 1_000_000_000_000; // arbitrary fixed instant (Unix ms)

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: `Task ${id}`,
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

function reminder(id: string, over: Partial<Reminder> = {}): Reminder {
  return {
    id,
    task_id: "t1",
    at: null,
    offset_min_before_due: null,
    fired_at: null,
    created_at: 0,
    ...over,
  };
}

describe("futureReminders", () => {
  it("includes an unfired absolute reminder in the future", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    expect(futureReminders(rs, [task("t1")], NOW)).toEqual([
      { reminderId: "r1", fireAt: NOW + 60_000, title: "Task t1" },
    ]);
  });

  it("excludes past-due, already-fired, and no-anchor reminders", () => {
    const rs = [
      reminder("past", { at: NOW - 1 }),
      // Stamped when it went out (by a device whose clock runs ahead): fired for this instant.
      reminder("fired", { at: NOW + 60_000, fired_at: NOW + 60_000 }),
      reminder("noanchor", { at: null, offset_min_before_due: null }),
      reminder("ok", { at: NOW + 120_000 }),
    ];
    expect(futureReminders(rs, [task("t1")], NOW).map((s) => s.reminderId)).toEqual(["ok"]);
  });

  it("books a fired reminder again once its fire instant moves past the stamp", () => {
    // Fired an hour ago, then rescheduled (or its recurring task skipped ahead): due again.
    const rs = [reminder("moved", { at: NOW + 60_000, fired_at: NOW - 3_600_000 })];
    expect(futureReminders(rs, [task("t1")], NOW).map((s) => s.reminderId)).toEqual(["moved"]);
  });

  it("books a due-relative reminder again when its task's due date moves on", () => {
    const oldDue = NOW - 3_600_000;
    const rs = [reminder("r1", { offset_min_before_due: 0, fired_at: oldDue })];
    const tasks = [task("t1", { due_at: NOW + 86_400_000 })];
    expect(futureReminders(rs, tasks, NOW).map((s) => s.fireAt)).toEqual([NOW + 86_400_000]);
  });

  it("excludes reminders whose task is missing or completed", () => {
    const rs = [
      reminder("gone", { task_id: "missing", at: NOW + 60_000 }),
      reminder("done", { task_id: "t2", at: NOW + 60_000 }),
    ];
    const tasks = [task("t1"), task("t2", { is_completed: true })];
    expect(futureReminders(rs, tasks, NOW)).toEqual([]);
  });

  it("resolves a relative offset against the task due date (DST-agnostic absolute ms)", () => {
    const due = NOW + 3_600_000; // due in an hour
    const rs = [reminder("r1", { offset_min_before_due: 15 })];
    const [s] = futureReminders(rs, [task("t1", { due_at: due })], NOW);
    expect(s).toEqual({ reminderId: "r1", fireAt: due - 15 * 60_000, title: "Task t1" });
  });
});

describe("in the user's timezone", () => {
  // An all-day due in Auckland: 23:59 there, which is no all-day time in the device's zone.
  const ZONE = "Pacific/Auckland";
  const due = makeInstant(2031, 3, 14, 23, 59, 0, ZONE);
  const morning = makeInstant(2031, 3, 14, 9, 0, 0, ZONE);
  const before = makeInstant(2031, 3, 10, 12, 0, 0, ZONE);

  it("resolves a morning-of reminder at 09:00 in that zone, not at the 23:59 due", () => {
    const rs = [reminder("r1", { offset_min_before_due: 0 })];
    const tasks = [task("t1", { due_at: due })];
    expect(futureReminders(rs, tasks, before, { timeZone: ZONE })[0]?.fireAt).toBe(morning);
  });

  it("books it there through the reconcile too", () => {
    const rs = [reminder("r1", { offset_min_before_due: 0 })];
    const sink = { schedule: vi.fn(), cancel: vi.fn() };
    reconcileNotifications(rs, [task("t1", { due_at: due })], before, new Map(), "R", sink, {
      timeZone: ZONE,
    });
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "R", morning, "r1");
  });
});

describe("locked tasks", () => {
  it("titles a task this device cannot decrypt with the placeholder, not its blank title", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const tasks = [task("t1", { title: "", locked: true })];
    const [s] = futureReminders(rs, tasks, NOW, { lockedTitle: "Encrypted task" });
    expect(s?.title).toBe("Encrypted task");
  });

  it("names the title the same way for the in-app path", () => {
    const opts = { lockedTitle: "Encrypted task", fallbackTitle: "Reminder" };
    expect(reminderTitle(task("t1", { title: "", locked: true }), opts)).toBe("Encrypted task");
    expect(reminderTitle(task("t1", { title: "" }), opts)).toBe("Reminder");
    expect(reminderTitle(undefined, opts)).toBe("Reminder");
    expect(reminderTitle(task("t1"), opts)).toBe("Task t1");
  });
});

describe("reminder notification body", () => {
  it("extracts the first non-empty line of task notes", () => {
    expect(reminderBody(task("t1", { notes: "buy groceries\nand water" }))).toBe("buy groceries");
    expect(reminderBody(task("t1", { notes: "\n\n  pick up dry cleaning  \nsecond line" }))).toBe(
      "pick up dry cleaning",
    );
  });

  it("returns empty string when there are no notes or notes are blank", () => {
    expect(reminderBody(task("t1", { notes: "" }))).toBe("");
    expect(reminderBody(task("t1", { notes: "   \n\t  " }))).toBe("");
    expect(reminderBody(undefined)).toBe("");
  });

  it("returns empty string for a locked task", () => {
    expect(reminderBody(task("t1", { notes: "secret notes", locked: true }))).toBe("");
  });

  it("includes note body in futureReminders and passes it to io.schedule", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const tasks = [task("t1", { notes: "first line\nsecond line" })];
    const [s] = futureReminders(rs, tasks, NOW);
    expect(s?.body).toBe("first line");

    const sink = { schedule: vi.fn(), cancel: vi.fn() };
    reconcileNotifications(rs, tasks, NOW, new Map(), "fallback", sink);
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "first line", NOW + 60_000, "r1");
  });
});

describe("reconcileSchedule", () => {
  const tasks = [task("t1")];

  it("schedules everything new when nothing is scheduled yet", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const diff = reconcileSchedule(rs, tasks, NOW, new Map());
    expect(diff.toSchedule.map((s) => s.reminderId)).toEqual(["r1"]);
    expect(diff.toCancel).toEqual([]);
  });

  it("is a no-op when the scheduled set already matches (idempotent)", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const scheduled = new Map([["r1", NOW + 60_000]]);
    expect(reconcileSchedule(rs, tasks, NOW, scheduled)).toEqual({ toSchedule: [], toCancel: [] });
  });

  it("cancels a reminder that is no longer desired (deleted/fired/completed)", () => {
    const rs = [reminder("r1", { at: NOW + 60_000, fired_at: NOW + 60_000 })];
    const scheduled = new Map([["r1", NOW + 60_000]]);
    expect(reconcileSchedule(rs, tasks, NOW, scheduled)).toEqual({
      toSchedule: [],
      toCancel: ["r1"],
    });
  });

  it("reschedules (cancel + schedule) when the fire instant moves", () => {
    const rs = [reminder("r1", { at: NOW + 120_000 })];
    const scheduled = new Map([["r1", NOW + 60_000]]);
    const diff = reconcileSchedule(rs, tasks, NOW, scheduled);
    expect(diff.toCancel).toEqual(["r1"]);
    expect(diff.toSchedule).toEqual([
      { reminderId: "r1", fireAt: NOW + 120_000, title: "Task t1" },
    ]);
  });
});

describe("reconcileNotifications", () => {
  const tasks = [task("t1")];
  const io = () => ({ schedule: vi.fn(), cancel: vi.fn() });

  it("schedules a future reminder through the io and records it as scheduled", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const scheduled = new Map<string, number>();
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Reminder", sink);
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "Reminder", NOW + 60_000, "r1");
    expect(sink.cancel).not.toHaveBeenCalled();
    expect(scheduled.get("r1")).toBe(NOW + 60_000);
  });

  it("is a no-op the second time with the same inputs (idempotent)", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const scheduled = new Map<string, number>();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Reminder", io());
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Reminder", sink);
    expect(sink.schedule).not.toHaveBeenCalled();
    expect(sink.cancel).not.toHaveBeenCalled();
  });

  it("cancels and forgets a reminder that is no longer desired", () => {
    const rs = [reminder("r1", { at: NOW + 60_000, fired_at: NOW + 60_000 })];
    const scheduled = new Map([["r1", NOW + 60_000]]);
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Reminder", sink);
    expect(sink.cancel).toHaveBeenCalledWith("r1");
    expect(sink.schedule).not.toHaveBeenCalled();
    expect(scheduled.has("r1")).toBe(false);
  });

  it("cancels the stale schedule and schedules the new time when a due date moves", () => {
    const rs = [reminder("r1", { at: NOW + 120_000 })];
    const scheduled = new Map([["r1", NOW + 60_000]]);
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Reminder", sink);
    expect(sink.cancel).toHaveBeenCalledWith("r1");
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "Reminder", NOW + 120_000, "r1");
    expect(scheduled.get("r1")).toBe(NOW + 120_000);
  });

  it("books everything again in place when the text changed but no time did (rebook)", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const scheduled = new Map([
      ["r1", NOW + 60_000],
      ["gone", NOW + 90_000],
    ]);
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, scheduled, "Påmindelse", sink, { rebook: true });
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "Påmindelse", NOW + 60_000, "r1");
    // Replaced under its own id, never cancelled: a cancel could land after the new booking.
    expect(sink.cancel).not.toHaveBeenCalledWith("r1");
    expect(sink.cancel).toHaveBeenCalledWith("gone");
    expect([...scheduled.entries()]).toEqual([["r1", NOW + 60_000]]);
  });
});

describe("left over from an earlier launch", () => {
  const tasks = [task("t1")];
  const io = () => ({ schedule: vi.fn(), cancel: vi.fn() });

  it("cancels a booked notification whose reminder went away while the app was closed", () => {
    const rs = [reminder("r1", { at: NOW + 60_000 })];
    const sink = io();
    reconcileNotifications(rs, tasks, NOW, new Map(), "Reminder", sink, { booked: ["gone", "r1"] });
    expect(sink.cancel).toHaveBeenCalledWith("gone");
    // Still wanted: booked again under the same id, which replaces the OS copy. No cancel, which
    // could land after the new booking and take it out.
    expect(sink.cancel).not.toHaveBeenCalledWith("r1");
    expect(sink.schedule).toHaveBeenCalledWith("Task t1", "Reminder", NOW + 60_000, "r1");
  });

  it("adopts only what is not desired and not already tracked", () => {
    const scheduled = new Map([["tracked", NOW + 5]]);
    adoptBooked(
      ["tracked", "wanted", "orphan"],
      [{ reminderId: "wanted", fireAt: 1, title: "" }],
      scheduled,
    );
    expect([...scheduled.keys()].sort()).toEqual(["orphan", "tracked"]);
    expect(scheduled.get("tracked")).toBe(NOW + 5);
  });
});
