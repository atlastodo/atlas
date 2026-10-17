import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { serializeTasksForClipboard } from "./taskClipboard";

function makeTask(patch: Partial<Task>): Task {
  return {
    id: "t",
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
    ...patch,
  };
}

describe("serializeTasksForClipboard", () => {
  it("emits a bare bullet for a title-only task", () => {
    const out = serializeTasksForClipboard([makeTask({ title: "Buy milk" })]);
    expect(out).toBe("- Buy milk");
  });

  it("indents the description under the title", () => {
    const out = serializeTasksForClipboard([
      makeTask({ title: "Buy milk", notes: "Get the oat kind" }),
    ]);
    expect(out).toBe("- Buy milk\n  Get the oat kind");
  });

  it("indents every line of a multi-line description and trims trailing blank lines", () => {
    const out = serializeTasksForClipboard([makeTask({ title: "Plan", notes: "one\ntwo\n\n" })]);
    expect(out).toBe("- Plan\n  one\n  two");
  });

  it("includes due, priority and project/section metadata", () => {
    const out = serializeTasksForClipboard(
      [
        makeTask({
          title: "Report",
          priority: 2,
          due_at: 1_700_000_000_000,
          project_id: "p",
          section_id: "s",
        }),
      ],
      {
        formatDue: () => "Jul 12",
        originOf: () => ({ project: "Work", section: "Todo" }),
      },
    );
    expect(out).toBe("- Report (due Jul 12, p2, #Work/Todo)");
  });

  it("omits priority 4 (none) and renders project-only origin", () => {
    const out = serializeTasksForClipboard(
      [makeTask({ title: "Call", priority: 4, project_id: "p" })],
      {
        originOf: () => ({ project: "Health" }),
      },
    );
    expect(out).toBe("- Call (#Health)");
  });

  it("carries all metadata: start, recurrence, estimate, labels and assignee", () => {
    const out = serializeTasksForClipboard(
      [
        makeTask({
          title: "Report",
          priority: 1,
          start_at: 1,
          due_at: 2,
          recurrence: "FREQ=WEEKLY;INTERVAL=2",
          estimate_min: 45,
          label_ids: ["l1", "l2"],
          assignee_id: "u9",
        }),
      ],
      {
        formatDue: () => "Jul 12",
        formatStart: () => "Jul 10",
        formatRecurrence: () => "every 2 weeks",
        labelsOf: () => ["work", "urgent"],
        assigneeOf: () => "Alex",
      },
    );
    expect(out).toBe(
      "- Report (due Jul 12, start Jul 10, p1, every 2 weeks, ~45m, @work, @urgent, assigned Alex)",
    );
  });

  it("falls back to the raw recurrence rule and omits id fields without resolvers", () => {
    const out = serializeTasksForClipboard([
      makeTask({ title: "R", recurrence: "FREQ=DAILY", label_ids: ["l1"], assignee_id: "u1" }),
    ]);
    // No resolvers: labels/assignee are omitted (raw ids are meaningless), recurrence shows raw.
    expect(out).toBe("- R (FREQ=DAILY)");
  });

  it("joins multiple tasks one per line, descriptions inline", () => {
    const out = serializeTasksForClipboard([
      makeTask({ title: "A", notes: "note a" }),
      makeTask({ title: "B" }),
    ]);
    expect(out).toBe("- A\n  note a\n- B");
  });
});
