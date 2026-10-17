import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  isAllDayTask,
  isoWeek,
  monthGrid,
  partitionDayTasks,
  tasksByDay,
  weekDays,
  weekdayLabels,
} from "./calendar";
import { endOfDay, startOfDay } from "./zonedTime";

const NOW = 1_700_000_000_000;
function task(overrides: Partial<Task>): Task {
  return {
    id: "t",
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

describe("weekdayLabels", () => {
  it("starts on Sunday for weekStartsOn=0", () => {
    expect(weekdayLabels(0)[0]).toBe("Sun");
    expect(weekdayLabels(0)).toHaveLength(7);
  });
  it("starts on Monday for weekStartsOn=1", () => {
    expect(weekdayLabels(1)[0]).toBe("Mon");
    expect(weekdayLabels(1)[6]).toBe("Sun");
  });
});

describe("monthGrid", () => {
  it("covers exactly the days of the month, in 7-cell rows", () => {
    const weeks = monthGrid(2026, 0, 0); // January 2026
    for (const w of weeks) expect(w).toHaveLength(7);
    const inMonth = weeks.flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]!.day).toBe(1);
    expect(inMonth.at(-1)!.day).toBe(31);
  });

  it("aligns the first column to weekStartsOn", () => {
    const sunFirst = monthGrid(2026, 6, 0); // July 2026, Sunday-start
    const monFirst = monthGrid(2026, 6, 1); // July 2026, Monday-start
    expect(new Date(sunFirst[0]![0]!.date).getDay()).toBe(0);
    expect(new Date(monFirst[0]![0]!.date).getDay()).toBe(1);
  });

  it("uses local start-of-day for each in-month cell's date", () => {
    const weeks = monthGrid(2026, 6, 0);
    const firstOfMonth = weeks.flat().find((c) => c.inMonth && c.day === 1)!;
    expect(firstOfMonth.date).toBe(startOfDay(new Date(2026, 6, 1).getTime()));
  });
});

describe("tasksByDay", () => {
  it("buckets active tasks by their due day and skips completed/undated", () => {
    const day = startOfDay(new Date(2026, 6, 3, 9).getTime());
    const tasks = [
      task({ id: "a", due_at: new Date(2026, 6, 3, 9).getTime() }),
      task({ id: "b", due_at: new Date(2026, 6, 3, 20).getTime() }),
      task({ id: "c", due_at: new Date(2026, 6, 4, 9).getTime() }),
      task({ id: "d" }), // no due date
      task({ id: "e", due_at: day, is_completed: true }), // completed
    ];
    const map = tasksByDay(tasks);
    expect(
      map
        .get(day)!
        .map((t) => t.id)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(map.has(startOfDay(new Date(2026, 6, 4).getTime()))).toBe(true);
  });
});

describe("weekDays", () => {
  it("returns 7 days aligned to weekStartsOn, containing the anchor", () => {
    const anchor = new Date(2026, 6, 15, 12).getTime(); // Wed 15 Jul 2026
    const sun = weekDays(anchor, 0);
    expect(sun).toHaveLength(7);
    expect(new Date(sun[0]!.date).getDay()).toBe(0); // Sunday first
    const mon = weekDays(anchor, 1);
    expect(new Date(mon[0]!.date).getDay()).toBe(1); // Monday first
    // The anchor's own day is present in both alignments.
    const anchorStart = startOfDay(anchor);
    expect(sun.some((c) => c.date === anchorStart)).toBe(true);
    expect(mon.some((c) => c.date === anchorStart)).toBe(true);
  });
});

describe("isoWeek", () => {
  it("computes ISO 8601 week numbers, including year boundaries", () => {
    expect(isoWeek(Date.UTC(2024, 0, 1), "UTC")).toBe(1); // Mon 1 Jan 2024 -> W1
    expect(isoWeek(Date.UTC(2023, 0, 1), "UTC")).toBe(52); // Sun 1 Jan 2023 -> W52 of 2022
    expect(isoWeek(Date.UTC(2021, 0, 1), "UTC")).toBe(53); // Fri 1 Jan 2021 -> W53 of 2020
    expect(isoWeek(Date.UTC(2020, 11, 31), "UTC")).toBe(53); // Thu 31 Dec 2020 -> W53
    expect(isoWeek(Date.UTC(2026, 6, 2), "UTC")).toBe(27); // Thu 2 Jul 2026
  });
});

describe("endOfDay", () => {
  it("returns the same calendar day, near midnight", () => {
    const start = startOfDay(new Date(2026, 6, 3, 10).getTime());
    const end = endOfDay(start);
    expect(startOfDay(end)).toBe(start);
    expect(end).toBeGreaterThan(start);
  });
});

describe("isAllDayTask and partitionDayTasks", () => {
  it("identifies all-day tasks at 23:59 end-of-day", () => {
    const allDayTime = endOfDay(Date.UTC(2026, 6, 3), "UTC");
    const timedTime = Date.UTC(2026, 6, 3, 14, 30);
    expect(isAllDayTask(allDayTime, "UTC")).toBe(true);
    expect(isAllDayTask(timedTime, "UTC")).toBe(false);
  });

  it("partitions tasks into all-day and timed buckets", () => {
    const allDay = task({ id: "1", due_at: endOfDay(Date.UTC(2026, 6, 3), "UTC") });
    const timed1 = task({ id: "2", due_at: Date.UTC(2026, 6, 3, 9, 15), estimate_min: 45 });
    const timed2 = task({ id: "3", due_at: Date.UTC(2026, 6, 3, 14, 0) });

    const result = partitionDayTasks([allDay, timed2, timed1], "UTC");
    expect(result.allDay).toHaveLength(1);
    expect(result.allDay[0]!.id).toBe("1");
    expect(result.timed).toHaveLength(2);
    expect(result.timed[0]!.task.id).toBe("2");
    expect(result.timed[0]!.startHour).toBe(9);
    expect(result.timed[0]!.startMinute).toBe(15);
    expect(result.timed[0]!.durationMin).toBe(45);
    expect(result.timed[1]!.task.id).toBe("3");
    expect(result.timed[1]!.startHour).toBe(14);
    expect(result.timed[1]!.durationMin).toBe(30);
  });
});
