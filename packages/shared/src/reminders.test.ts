import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  MORNING_OF_OFFSET_MIN,
  REMINDER_STALE_AFTER_MS,
  dueReminders,
  morningReminderOffset,
  reminderFireAt,
  splitDueReminders,
  toReminder,
  type Reminder,
} from "./reminders";
import { makeInstant } from "./zonedTime";

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

describe("reminderFireAt", () => {
  it("uses the absolute time when set", () => {
    expect(reminderFireAt(reminder({ at: NOW }), task())).toBe(NOW);
  });

  it("computes an offset before the task's due date", () => {
    const t = task({ due_at: NOW });
    expect(reminderFireAt(reminder({ offset_min_before_due: 30 }), t)).toBe(NOW - 30 * 60_000);
  });

  it("returns null for a relative reminder on a task with no due date", () => {
    expect(
      reminderFireAt(reminder({ offset_min_before_due: 30 }), task({ due_at: null })),
    ).toBeNull();
  });

  it("computes 9:00 AM on the preceding day/week for all-day tasks", () => {
    // Friday 2026-09-11 at 23:59 UTC.
    const fridayDue = Date.UTC(2026, 8, 11, 23, 59, 0);
    const t = task({ due_at: fridayDue });

    // 1 day before -> Thursday at 09:00 UTC.
    const oneDayBefore = reminder({ offset_min_before_due: 24 * 60 });
    expect(reminderFireAt(oneDayBefore, t, "UTC")).toBe(Date.UTC(2026, 8, 10, 9, 0, 0));

    // 1 week before -> Friday a week earlier at 09:00 UTC.
    const oneWeekBefore = reminder({ offset_min_before_due: 7 * 24 * 60 });
    expect(reminderFireAt(oneWeekBefore, t, "UTC")).toBe(Date.UTC(2026, 8, 4, 9, 0, 0));

    // Sub-day offsets ignore the calendar and fire offset minutes before the stored instant.
    const tenMinBefore = reminder({ offset_min_before_due: 10 });
    expect(reminderFireAt(tenMinBefore, t, "UTC")).toBe(fridayDue - 10 * 60_000);
  });

  it("resolves the all-day 09:00 anchor in the given timezone, not the device's", () => {
    // An all-day task on 2026-07-15 in New York: 23:59 EDT = 2026-07-16T03:59Z.
    const due = makeInstant(2026, 6, 15, 23, 59, 0, "America/New_York");
    const t = task({ due_at: due });

    // One day before -> 09:00 EDT on July 14 = 13:00 UTC.
    expect(reminderFireAt(reminder({ offset_min_before_due: 1440 }), t, "America/New_York")).toBe(
      Date.UTC(2026, 6, 14, 13, 0, 0),
    );

    // Read from a zone where the stored instant is NOT 23:59, it's not an all-day anchor:
    // the plain instant math applies.
    expect(reminderFireAt(reminder({ offset_min_before_due: 1440 }), t, "Asia/Tokyo")).toBe(
      due - 1440 * 60_000,
    );
  });

  it("keeps the 09:00 wall clock across a DST transition", () => {
    // All-day 2026-03-15 in New York (already EDT since Mar 8); one day before is 09:00 EDT.
    const due = makeInstant(2026, 2, 15, 23, 59, 0, "America/New_York");
    const t = task({ due_at: due });
    expect(reminderFireAt(reminder({ offset_min_before_due: 1440 }), t, "America/New_York")).toBe(
      Date.UTC(2026, 2, 14, 13, 0, 0),
    );
  });
});

describe("morningReminderOffset", () => {
  // Friday 2026-09-11 all-day (23:59 UTC); `now` is Thursday noon UTC.
  const FRIDAY = Date.UTC(2026, 8, 11, 23, 59, 0);
  const THURSDAY_NOON = Date.UTC(2026, 8, 10, 12, 0, 0);

  it("attaches to an all-day due as the day-based offset that fires 09:00 of the due day", () => {
    expect(morningReminderOffset(FRIDAY, THURSDAY_NOON, "UTC")).toBe(MORNING_OF_OFFSET_MIN);
    // Round-tripped through the scheduler's resolver, the attached offset is 09:00 that Friday.
    expect(
      reminderFireAt(
        reminder({ offset_min_before_due: MORNING_OF_OFFSET_MIN }),
        task({ due_at: FRIDAY }),
        "UTC",
      ),
    ).toBe(Date.UTC(2026, 8, 11, 9, 0, 0));
  });

  it("skips a due with an explicit time", () => {
    expect(morningReminderOffset(Date.UTC(2026, 8, 11, 14, 0, 0), THURSDAY_NOON, "UTC")).toBeNull();
  });

  it("skips a task without a due date", () => {
    expect(morningReminderOffset(null, THURSDAY_NOON, "UTC")).toBeNull();
  });

  it("skips when 09:00 that morning is already past", () => {
    // Friday 10:00: the morning-of instant is gone; a reminder would fire on creation, not at 09:00.
    expect(morningReminderOffset(FRIDAY, Date.UTC(2026, 8, 11, 10, 0, 0), "UTC")).toBeNull();
  });

  it("attaches while 09:00 is still ahead, even on the due day itself", () => {
    expect(morningReminderOffset(FRIDAY, Date.UTC(2026, 8, 11, 8, 0, 0), "UTC")).toBe(
      MORNING_OF_OFFSET_MIN,
    );
  });

  it("resolves the 09:00 anchor in the given zone across a DST transition", () => {
    // All-day Monday 2026-03-09 in New York: DST began the day before, so 09:00 EDT = 13:00 UTC.
    const due = makeInstant(2026, 2, 9, 23, 59, 0, "America/New_York");
    const now = makeInstant(2026, 2, 8, 12, 0, 0, "America/New_York");
    const offset = morningReminderOffset(due, now, "America/New_York");
    expect(offset).toBe(MORNING_OF_OFFSET_MIN);
    expect(
      reminderFireAt(
        reminder({ offset_min_before_due: offset! }),
        task({ due_at: due }),
        "America/New_York",
      ),
    ).toBe(Date.UTC(2026, 2, 9, 13, 0, 0));
  });
});

describe("dueReminders", () => {
  it("returns reminders whose time has passed", () => {
    const t = task({ due_at: NOW });
    const r = reminder({ offset_min_before_due: 0 });
    expect(dueReminders([r], [t], NOW)).toEqual([r]);
    expect(dueReminders([r], [t], NOW - 1)).toEqual([]);
  });

  it("excludes already-fired reminders (no duplicates)", () => {
    const r = reminder({ at: NOW - 1000, fired_at: NOW - 500 });
    expect(dueReminders([r], [task()], NOW)).toEqual([]);
  });

  it("is due again once its fire instant moved past the fired stamp", () => {
    // Fired, then the task was rescheduled: the stamp is for the old instant, not this one.
    const r = reminder({ at: NOW - 1000, fired_at: NOW - 3_600_000 });
    expect(dueReminders([r], [task()], NOW)).toEqual([r]);
  });

  it("stays fired for the instant it fired at, however late it was stamped", () => {
    const onTime = reminder({ id: "on-time", at: NOW - 1000, fired_at: NOW - 1000 });
    const late = reminder({ id: "late", at: NOW - 1000, fired_at: NOW });
    expect(dueReminders([onTime, late], [task()], NOW)).toEqual([]);
  });

  it("excludes reminders for completed or missing tasks", () => {
    const done = reminder({ id: "r-done", at: NOW - 1 });
    const orphan = reminder({ id: "r-orphan", task_id: "gone", at: NOW - 1 });
    expect(dueReminders([done, orphan], [task({ is_completed: true })], NOW)).toEqual([]);
  });
});

describe("splitDueReminders", () => {
  it("announces a reminder that just came due", () => {
    const r = reminder({ at: NOW - 60_000 });
    expect(splitDueReminders([r], [task()], NOW)).toEqual({ fire: [r], stale: [] });
  });

  it("only stamps one more than 15 minutes late, which another device already delivered", () => {
    const late = reminder({ id: "late", at: NOW - REMINDER_STALE_AFTER_MS - 1 });
    const edge = reminder({ id: "edge", at: NOW - REMINDER_STALE_AFTER_MS });
    expect(REMINDER_STALE_AFTER_MS).toBe(15 * 60_000);
    expect(splitDueReminders([late, edge], [task()], NOW)).toEqual({ fire: [edge], stale: [late] });
  });

  it("leaves out what is not due at all", () => {
    const future = reminder({ at: NOW + 1 });
    const fired = reminder({ id: "fired", at: NOW - 1000, fired_at: NOW - 500 });
    expect(splitDueReminders([future, fired], [task()], NOW)).toEqual({ fire: [], stale: [] });
  });
});

describe("splitDueReminders in the user's timezone", () => {
  it("announces a morning-of reminder at 09:00 there, not at the 23:59 due", () => {
    const zone = "Pacific/Auckland";
    const due = makeInstant(2031, 3, 14, 23, 59, 0, zone);
    const now = makeInstant(2031, 3, 14, 9, 5, 0, zone);
    const r = reminder({ offset_min_before_due: 0 });
    expect(splitDueReminders([r], [task({ due_at: due })], now, zone).fire).toEqual([r]);
  });
});

describe("toReminder", () => {
  it("maps the store bag with defaults", () => {
    expect(toReminder("r1", { task_id: "t1", at: 5 })).toEqual({
      id: "r1",
      task_id: "t1",
      at: 5,
      offset_min_before_due: null,
      fired_at: null,
      created_at: 0,
    });
  });
});
