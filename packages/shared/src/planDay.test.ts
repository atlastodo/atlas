import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  PLAN_DAY_HORIZON_DAYS,
  planDayItems,
  planDayPostponeOptions,
  planDayUpcoming,
  planDayWrites,
} from "./planDay";
import { endOfDay } from "./zonedTime";

// A fixed reference "now": 2026-07-02 12:00 local; a Thursday.
const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();
const day = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).getTime();

function task(overrides: Partial<Task>): Task {
  return {
    id: crypto.randomUUID(),
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "t",
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
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe("planDayItems", () => {
  it("proposes overdue first, then today's, in list order", () => {
    const tasks = [
      task({ id: "today1", due_at: day(2026, 6, 2, 20) }),
      task({ id: "overdue1", due_at: day(2026, 6, 1) }),
      task({ id: "today2", due_at: day(2026, 6, 2, 14) }),
      task({ id: "overdue2", due_at: day(2026, 5, 20) }),
    ];
    expect(planDayItems(tasks, NOW).map((i) => i.task.id)).toEqual([
      "overdue1",
      "overdue2",
      "today1",
      "today2",
    ]);
    expect(planDayItems(tasks, NOW).map((i) => i.bucket)).toEqual([
      "overdue",
      "overdue",
      "today",
      "today",
    ]);
  });

  it("leaves out completed, future and undated tasks", () => {
    const tasks = [
      task({ id: "done", due_at: day(2026, 6, 1), is_completed: true }),
      task({ id: "future", due_at: day(2026, 6, 5) }),
      task({ id: "nodue" }),
    ];
    expect(planDayItems(tasks, NOW)).toEqual([]);
  });
});

describe("planDayUpcoming", () => {
  it("offers the next 7 days, excluding today and beyond the horizon, ascending", () => {
    const tasks = [
      task({ id: "beyond", due_at: day(2026, 6, 10) }), // 8 days out
      task({ id: "seventh", due_at: day(2026, 6, 9, 8) }), // 7 days out, on the horizon
      task({ id: "tomorrow", due_at: day(2026, 6, 3) }),
      task({ id: "today", due_at: day(2026, 6, 2, 20) }),
      task({ id: "overdue", due_at: day(2026, 6, 1) }),
      task({ id: "done", due_at: day(2026, 6, 3), is_completed: true }),
    ];
    expect(planDayUpcoming(tasks, NOW).map((t) => t.id)).toEqual(["tomorrow", "seventh"]);
  });

  it("follows the timezone when deciding which day a task falls on", () => {
    // 2026-07-16 02:00 UTC is tomorrow in UTC but still today (22:00) in New York.
    const now = Date.UTC(2026, 6, 15, 12, 0, 0);
    const t = task({ id: "edge", due_at: Date.UTC(2026, 6, 16, 2, 0, 0) });
    expect(planDayUpcoming([t], now, "UTC").map((x) => x.id)).toEqual(["edge"]);
    expect(planDayUpcoming([t], now, "America/New_York")).toEqual([]);
  });
});

describe("planDayPostponeOptions", () => {
  it("offers one target per day, tomorrow first at the default due time", () => {
    const options = planDayPostponeOptions(NOW);
    expect(options).toHaveLength(PLAN_DAY_HORIZON_DAYS);
    expect(options[0]).toEqual({ offset: 1, dueAt: endOfDay(day(2026, 6, 3), undefined) });
    expect(options[6]).toEqual({ offset: 7, dueAt: endOfDay(day(2026, 6, 9), undefined) });
    // Every target lands at the day's default due time, like a quick-reschedule would write.
    for (const opt of options) {
      expect(endOfDay(opt.dueAt)).toBe(opt.dueAt);
    }
  });
});

describe("planDayWrites", () => {
  const overdue = task({ id: "overdue", due_at: day(2026, 6, 1) });
  const today = task({ id: "today", due_at: day(2026, 6, 2, 20) });
  const brought = task({ id: "brought", due_at: day(2026, 7, 3) });
  const items = [
    { task: overdue, bucket: "overdue" as const },
    { task: today, bucket: "today" as const },
    { task: brought, bucket: "upcoming" as const },
  ];
  const TODAY_END = endOfDay(day(2026, 6, 2));

  it("writes a postpone to its chosen day", () => {
    const tomorrow = endOfDay(day(2026, 6, 3), undefined);
    expect(
      planDayWrites(items, { overdue: { kind: "postpone", dueAt: tomorrow } }, TODAY_END),
    ).toEqual([{ id: "overdue", dueAt: tomorrow }]);
  });

  it("keeping a task pulled in from upcoming moves it to today; keeping a listed task does not", () => {
    expect(
      planDayWrites(items, { brought: { kind: "keep" }, today: { kind: "keep" } }, TODAY_END),
    ).toEqual([{ id: "brought", dueAt: TODAY_END }]);
  });

  it("writes nothing for later or undecided tasks", () => {
    expect(
      planDayWrites(
        items,
        { overdue: { kind: "later" }, today: undefined, brought: { kind: "later" } },
        TODAY_END,
      ),
    ).toEqual([]);
  });

  it("skips a write that would not change the date", () => {
    // Already due at the target instant; rewriting it would only fake an undo.
    const moved = task({ id: "moved", due_at: TODAY_END });
    expect(
      planDayWrites([{ task: moved, bucket: "upcoming" }], { moved: { kind: "keep" } }, TODAY_END),
    ).toEqual([]);
  });
});
