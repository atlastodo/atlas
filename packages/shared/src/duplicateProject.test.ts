import { describe, expect, it } from "vitest";
import type { Project, Section, Task } from "@atlastodo/client-core";
import { planProjectDuplicate } from "./duplicateProject";

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    owner_id: "u1",
    name: "Launch",
    color: "#ff0000",
    icon: "rocket",
    sort_order: 1,
    is_favorite: false,
    parent_id: null,
    kind: "project",
    default_view: "list",
    archived_at: null,
    deleted_at: null,
    ...over,
  };
}

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
    ...over,
  };
}

/** A deterministic id generator so the plan is assertable. */
function seqIds(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

/** Collapse a plan's writes into `{ kind:id: { field: value } }` for readable assertions. */
function materialize(writes: { kind: string; id: string; field: string; value: unknown }[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const w of writes) {
    const key = `${w.kind}:${w.id}`;
    (out[key] ??= {})[w.field] = w.value;
  }
  return out;
}

describe("planProjectDuplicate", () => {
  it("copies the project with a (copy) name, carrying icon/color and a fresh id", () => {
    const plan = planProjectDuplicate(project(), [], [], { mkId: seqIds(), now: 5000 });
    expect(plan.newProjectId).toBe("new-1");
    const m = materialize(plan.writes);
    expect(m["project:new-1"]).toMatchObject({
      name: "Launch (copy)",
      kind: "project",
      color: "#ff0000",
      icon: "rocket",
      sort_order: 5000,
    });
  });

  it("carries a board default view", () => {
    const plan = planProjectDuplicate(project({ default_view: "board" }), [], [], {
      mkId: seqIds(),
      now: 5000,
    });
    expect(materialize(plan.writes)["project:new-1"]?.default_view).toBe("board");
  });

  it("remaps section ids and points tasks at the copied sections", () => {
    const sections = [section({ id: "s1", name: "Todo", sort_order: 1 })];
    const tasks = [task({ id: "t1", section_id: "s1", title: "A" })];
    const plan = planProjectDuplicate(project(), sections, tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    // ids: new-1 project, new-2 section, new-3 task
    expect(m["section:new-2"]).toMatchObject({ project_id: "new-1", name: "Todo", sort_order: 1 });
    expect(m["task:new-3"]).toMatchObject({ project_id: "new-1", section_id: "new-2", title: "A" });
  });

  it("drops completed tasks and starts copies open", () => {
    const tasks = [
      task({ id: "t1", title: "Open" }),
      task({ id: "t2", title: "Done", is_completed: true, completed_at: 99 }),
    ];
    const plan = planProjectDuplicate(project(), [], tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    const titles = Object.values(m)
      .map((f) => f.title)
      .filter(Boolean);
    expect(titles).toEqual(["Open"]);
    // The one copied task is open.
    const copied = Object.entries(m).find(([, f]) => f.title === "Open")![1];
    expect(copied.is_completed).toBe(false);
  });

  it("remaps a sub-task's parent link within the copy", () => {
    const tasks = [
      task({ id: "parent", title: "Parent" }),
      task({ id: "child", title: "Child", parent_id: "parent" }),
    ];
    const plan = planProjectDuplicate(project(), [], tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    const parentEntry = Object.entries(m).find(([, f]) => f.title === "Parent")!;
    const childEntry = Object.entries(m).find(([, f]) => f.title === "Child")!;
    const parentNewId = parentEntry[0].replace("task:", "");
    expect(childEntry[1].parent_id).toBe(parentNewId);
  });

  it("drops a section link that is not part of the copy", () => {
    const tasks = [task({ id: "t1", section_id: "gone", title: "Loose" })];
    const plan = planProjectDuplicate(project(), [], tasks, { mkId: seqIds(), now: 1 });
    const m = materialize(plan.writes);
    const copied = Object.values(m).find((f) => f.title === "Loose")!;
    expect(copied.section_id).toBeUndefined();
    expect(copied.project_id).toBe("new-1");
  });

  it("carries descriptive fields but drops assignee and completion", () => {
    const tasks = [
      task({
        id: "t1",
        title: "Rich",
        notes: "n",
        priority: 1,
        due_at: 123,
        estimate_min: 30,
        label_ids: ["l1"],
        assignee_id: "someone",
      }),
    ];
    const plan = planProjectDuplicate(project(), [], tasks, { mkId: seqIds(), now: 1 });
    const copied = Object.values(materialize(plan.writes)).find((f) => f.title === "Rich")!;
    expect(copied).toMatchObject({ notes: "n", priority: 1, due_at: 123, estimate_min: 30 });
    expect(copied.label_ids).toEqual(["l1"]);
    expect(copied.assignee_id).toBeUndefined();
    expect(copied.completed_at).toBeUndefined();
  });
});
