import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import {
  completedHistory,
  completedStreak,
  completionsByDay,
  completionsByProject,
  completionsByWeek,
  totalCompleted,
} from "./stats";

// 2026-07-06 is a Monday.
const at = (day: number, hour = 12) => new Date(2026, 6, day, hour).getTime();

function task(id: string, over: Partial<Task>): Task {
  return {
    id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: id,
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

const done = (id: string, day: number, project: string | null = null) =>
  task(id, { is_completed: true, completed_at: at(day), project_id: project });

describe("stats aggregates", () => {
  const tasks = [
    done("a", 6, "p1"),
    done("b", 6, "p1"),
    done("c", 7, "p2"),
    done("d", 10, null),
    task("open", { is_completed: false }), // not completed → ignored everywhere
  ];

  it("aggregates completions by day, zero-filling the range", () => {
    const days = completionsByDay(tasks, at(6, 0), at(8, 23));
    expect(days).toEqual([
      { date: "2026-07-06", count: 2 },
      { date: "2026-07-07", count: 1 },
      { date: "2026-07-08", count: 0 },
    ]);
  });

  it("aggregates completions by week (Monday start)", () => {
    // With a Monday start, the week beginning 07-06 spans Mon 06 .. Sun 12, so it holds a,b,c and d
    // (Fri 07-10) — one week, count 4. The following completion on 07-13 falls in the next week.
    const later = [...tasks, done("e", 13)];
    const weeks = completionsByWeek(later, at(6, 0), at(13, 23), 1);
    expect(weeks).toEqual([
      { weekStart: "2026-07-06", count: 4 },
      { weekStart: "2026-07-13", count: 1 },
    ]);
  });

  it("aggregates completions by project, most first", () => {
    const byProj = completionsByProject(tasks, at(6, 0), at(10, 23));
    expect(byProj).toEqual([
      { projectId: "p1", count: 2 },
      { projectId: "p2", count: 1 },
      { projectId: null, count: 1 },
    ]);
  });

  it("counts total completed in range and ignores open tasks", () => {
    expect(totalCompleted(tasks, at(6, 0), at(10, 23))).toBe(4);
    expect(totalCompleted(tasks, at(6, 0), at(6, 23))).toBe(2);
  });

  it("computes a karma streak with today grace", () => {
    // Completions on 07-06 and 07-07; today = 07-08 with none yet -> grace keeps it, but 07-08 has no
    // completion so the streak counts back through 07-07, 07-06 = 2.
    expect(completedStreak(tasks, at(8, 9))).toBe(2);
    // Today = 07-07 (has a completion) and 07-06 -> streak 2; a gap on 07-08..now breaks earlier days.
    expect(completedStreak(tasks, at(7, 9))).toBe(2);
    // Today = 07-10 (has d) but 07-08/07-09 empty -> only today counts.
    expect(completedStreak(tasks, at(10, 9))).toBe(1);
  });

  it("searches completed history newest-first", () => {
    const hist = completedHistory(tasks, "");
    expect(hist.map((t) => t.id)).toEqual(["d", "c", "a", "b"]); // a,b same day: stable-ish by ts
    expect(completedHistory(tasks, "C").map((t) => t.id)).toEqual(["c"]);
  });
});

describe("stats in the preferred time zone", () => {
  // Kiritimati is UTC+14: ahead of every device clock, so its calendar day differs from the
  // device's for these instants wherever the tests run.
  const TZ = "Pacific/Kiritimati";
  const doneAt = (id: string, ms: number) => task(id, { is_completed: true, completed_at: ms });

  it("buckets completions by the preferred zone's calendar day", () => {
    const tasks = [doneAt("a", Date.UTC(2026, 6, 6, 11))]; // 01:00 on 07-07 in Kiritimati
    const from = Date.UTC(2026, 6, 6, 10); // 07-07 00:00 there
    const to = Date.UTC(2026, 6, 7, 9, 59); // 07-07 23:59 there
    expect(completionsByDay(tasks, from, to, TZ)).toEqual([{ date: "2026-07-07", count: 1 }]);
    expect(completionsByWeek(tasks, from, to, 1, TZ)).toEqual([
      { weekStart: "2026-07-06", count: 1 },
    ]);
  });

  it("counts the streak in the preferred zone's days", () => {
    // 23:00 on 07-06 and 01:00 on 07-07 in Kiritimati: two days there, one day on any device clock.
    const tasks = [doneAt("a", Date.UTC(2026, 6, 6, 9)), doneAt("b", Date.UTC(2026, 6, 6, 11))];
    expect(completedStreak(tasks, Date.UTC(2026, 6, 7, 9), TZ)).toBe(2);
  });
});
