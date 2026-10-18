import { describe, expect, it } from "vitest";
import type { Section, Task } from "@atlastodo/client-core";
import { planSectionDuplicate } from "./duplicateSection";

function section(over: Partial<Section> = {}): Section {
  return {
    id: "s1",
    project_id: "p1",
    name: "Todo",
    sort_order: 1,
    deleted_at: null,
    archived_at: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    section_id: "s1",
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
    ...over,
  };
}

function seqIds(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

function materialize(writes: { kind: string; id: string; field: string; value: unknown }[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const w of writes) (out[`${w.kind}:${w.id}`] ??= {})[w.field] = w.value;
  return out;
}

describe("planSectionDuplicate", () => {
  it("copies the section with a (copy) name and a fresh id", () => {
    const plan = planSectionDuplicate(section(), [], { mkId: seqIds(), now: 5000 });
    expect(plan.newSectionId).toBe("new-1");
    expect(materialize(plan.writes)["section:new-1"]).toMatchObject({
      project_id: "p1",
      name: "Todo (copy)",
      sort_order: 5000,
    });
  });

  it("clones the section's open tasks into the new section, dropping completed and other sections", () => {
    const tasks = [
      task({ id: "t1", section_id: "s1", title: "Open" }),
      task({ id: "t2", section_id: "s1", title: "Done", is_completed: true }),
      task({ id: "t3", section_id: "s2", title: "Elsewhere" }),
    ];
    const plan = planSectionDuplicate(section(), tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    const titles = Object.values(m)
      .map((f) => f.title)
      .filter(Boolean);
    expect(titles).toEqual(["Open"]);
    // ids: new-1 section, new-2 task
    expect(m["task:new-2"]).toMatchObject({
      section_id: "new-1",
      project_id: "p1",
      is_completed: false,
    });
  });

  it("remaps a sub-task's parent link within the copy", () => {
    const tasks = [
      task({ id: "parent", title: "Parent" }),
      task({ id: "child", title: "Child", parent_id: "parent" }),
    ];
    const plan = planSectionDuplicate(section(), tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    const parentEntry = Object.entries(m).find(([, f]) => f.title === "Parent")!;
    const childEntry = Object.entries(m).find(([, f]) => f.title === "Child")!;
    expect(childEntry[1].parent_id).toBe(parentEntry[0].replace("task:", ""));
  });
});
