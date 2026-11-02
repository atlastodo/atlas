import { describe, expect, it } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import {
  listActivities,
  pruneOwnActivity,
  toActivity,
  writeProjectActivity,
  type Activity,
} from "./activity";
import { buildActivityFeed, canUndoActivity, undoActivity } from "./activityFeed";
import { allTasks, createTask, moveTaskToProject, toggleTask, updateTask } from "./taskOps";
import { restoreFromTrash, softDelete } from "./trash";
import { setSectionArchived } from "./sectionOps";
import type { Comment } from "./comments";

const T0 = 1_800_000_000_000;
const ME = "u1";
const BO = "u2";

function setup() {
  const store = new LocalStore("test");
  const task = (id: string) => allTasks(store).find((t) => t.id === id)!;
  const entries = () => listActivities(store);
  return { store, task, entries };
}

describe("toActivity", () => {
  it("leaves out kinds it does not know", () => {
    expect(toActivity("a", { kind: "teleported", task_id: "t" })).toBeNull();
    expect(toActivity("a", { kind: "due", task_id: "t", actor_id: ME })?.kind).toBe("due");
  });
});

describe("recording", () => {
  it("records create, field changes, moves and the trash with the actor", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "Plan" }, "UTC", ME, T0);
    updateTask(store, task(id), { priority: 2, label_ids: ["b", "a"] }, ME, T0 + 1);
    moveTaskToProject(store, id, { project_id: "p1", section_id: null }, T0 + 2, ME);
    softDelete(store, () => {}, "task", id, ME);
    const kinds = entries().map((a) => a.kind);
    expect(new Set(kinds)).toEqual(new Set(["created", "priority", "labels", "move", "deleted"]));
    expect(entries().every((a) => a.actor_id === ME)).toBe(true);
  });

  it("a toast undo of a delete takes the deleted entry back", () => {
    const { store, entries } = setup();
    const id = createTask(store, { title: "Oops" }, "UTC");
    const undo = softDelete(store, () => {}, "task", id, ME);
    expect(entries().map((a) => a.kind)).toEqual(["deleted"]);
    undo();
    expect(entries()).toEqual([]);
    restoreFromTrash(store, () => {}, "task", id, ME);
    expect(entries().map((a) => a.kind)).toEqual(["restored"]);
  });

  it("merges typing into one title entry", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "D" }, "UTC");
    updateTask(store, task(id), { title: "Do" }, ME, T0);
    updateTask(store, task(id), { title: "Dog" }, ME, T0 + 1000);
    const titles = entries().filter((a) => a.kind === "title");
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatchObject({ from: "D", to: "Dog", created_at: T0 + 1000 });
  });

  it("records section archive and project entries scoped by project", () => {
    const { store, entries } = setup();
    store.set("section", "s1", "project_id", "p1");
    store.set("section", "s1", "name", "Later");
    setSectionArchived(store, "s1", true, T0, ME);
    expect(entries()[0]).toMatchObject({
      kind: "section_archived",
      project_id: "p1",
      section_id: "s1",
      to: "Later",
      task_id: "",
    });
  });
});

describe("buildActivityFeed", () => {
  const a = (id: string, at: number, extra: Partial<Activity> = {}): Activity => ({
    id,
    task_id: "t1",
    project_id: null,
    section_id: null,
    actor_id: ME,
    kind: "due",
    from: null,
    to: null,
    created_at: at,
    reverts: null,
    ...extra,
  });
  const comment: Comment = {
    id: "c1",
    task_id: "t1",
    author_id: BO,
    body: "hi",
    created_at: 15,
    edited_at: null,
  };
  const activities = [
    a("a1", 10),
    a("a2", 20, { task_id: "t2", actor_id: BO, kind: "status", to: "completed" }),
    a("a3", 30, { task_id: "", project_id: "p1", kind: "project_renamed" }),
    a("a4", 40, { kind: "title", from: "x", to: "x" }),
  ];

  it("merges comments, sorts newest first and hides edits that came back", () => {
    const { items } = buildActivityFeed({ activities, comments: [comment] });
    expect(items.map((i) => i.id)).toEqual(["a3", "a2", "c1", "a1"]);
  });

  it("scopes to a view's tasks and projects", () => {
    const scope = { taskIds: new Set(["t1"]), projectIds: new Set(["p1"]) };
    const { items } = buildActivityFeed({ activities, comments: [comment], scope });
    expect(items.map((i) => i.id)).toEqual(["a3", "c1", "a1"]);
  });

  it("filters by person and group, and pages", () => {
    expect(
      buildActivityFeed({ activities, comments: [comment], people: new Set([BO]) }).items.map(
        (i) => i.id,
      ),
    ).toEqual(["a2", "c1"]);
    expect(
      buildActivityFeed({ activities, comments: [comment], groups: new Set(["comments"]) }).items,
    ).toHaveLength(1);
    const page = buildActivityFeed({ activities, comments: [comment], limit: 2 });
    expect(page).toMatchObject({ hasMore: true });
    const next = buildActivityFeed({ activities, comments: [comment], before: page.items[1]!.at });
    expect(next.items.map((i) => i.id)).toEqual(["c1", "a1"]);
  });
});

describe("undo", () => {
  it("undoes only the latest change to a field, and records the revert", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "Ship" }, "UTC");
    updateTask(store, task(id), { due_at: T0 }, ME, T0);
    updateTask(store, task(id), { due_at: T0 + 86_400_000 }, BO, T0 + 1);
    const [latest, older] = entries();
    expect(canUndoActivity(store, older!, entries(), "editor")).toBe(false);
    expect(canUndoActivity(store, latest!, entries(), "commenter")).toBe(false);
    expect(canUndoActivity(store, latest!, entries(), "editor")).toBe(true);
    expect(undoActivity(store, ME, latest!, entries(), T0 + 2)).toBe(true);
    expect(task(id).due_at).toBe(T0);
    const revert = entries()[0]!;
    expect(revert).toMatchObject({
      kind: "due",
      reverts: latest!.id,
      actor_id: ME,
      to: String(T0),
    });
    // The revert is now the latest: it can be undone in turn, the original no longer.
    expect(canUndoActivity(store, latest!, entries(), "editor")).toBe(false);
    expect(canUndoActivity(store, revert, entries(), "editor")).toBe(true);
  });

  it("refuses when the field changed without an entry", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "Ship" }, "UTC");
    updateTask(store, task(id), { priority: 1 }, ME, T0);
    updateTask(store, task(id), { priority: 3 }); // no actor: no entry
    expect(canUndoActivity(store, entries()[0]!, entries(), "owner")).toBe(false);
  });

  it("undoes a title edit without merging into it", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "Old" }, "UTC");
    updateTask(store, task(id), { title: "New" }, ME, T0);
    undoActivity(store, ME, entries()[0]!, entries(), T0 + 1000);
    expect(task(id).title).toBe("Old");
    expect(entries().map((a) => [a.kind, a.from, a.to])).toEqual([
      ["title", "New", "Old"],
      ["title", "Old", "New"],
    ]);
  });

  it("undoes a move only while the old place exists", () => {
    const { store, entries } = setup();
    store.set("project", "p1", "name", "One");
    store.set("project", "p2", "name", "Two");
    const id = createTask(store, { title: "T", project_id: "p1" }, "UTC");
    moveTaskToProject(store, id, { project_id: "p2", section_id: null }, T0, ME);
    const move = entries()[0]!;
    store.set("project", "p1", "deleted_at", T0);
    expect(canUndoActivity(store, move, entries(), "owner")).toBe(false);
    store.set("project", "p1", "deleted_at", null);
    expect(undoActivity(store, ME, move, entries(), T0 + 1)).toBe(true);
    expect(allTasks(store)[0]!.project_id).toBe("p1");
  });

  it("undoes create and delete through the trash", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "T" }, "UTC", ME, T0);
    expect(undoActivity(store, ME, entries()[0]!, entries(), T0 + 1)).toBe(true);
    expect(task(id).deleted_at).toBe(T0 + 1);
    const deleted = entries()[0]!;
    expect(deleted).toMatchObject({ kind: "deleted" });
    expect(undoActivity(store, ME, deleted, entries(), T0 + 2)).toBe(true);
    expect(task(id).deleted_at).toBeNull();
  });

  it("does not undo a recurring completion", () => {
    const { store, task, entries } = setup();
    const id = createTask(store, { title: "Daily", due_at: T0, recurrence: "FREQ=DAILY" }, "UTC");
    toggleTask(store, task(id), ME, T0, "UTC");
    const done = entries().find((a) => a.kind === "status")!;
    expect(canUndoActivity(store, done, entries(), "owner")).toBe(false);
  });

  it("project events are the owner's to undo", () => {
    const { store, entries } = setup();
    store.set("project", "p1", "name", "New");
    writeProjectActivity(store, ME, { projectId: "p1" }, "project_renamed", "Old", "New", T0);
    const entry = entries()[0]!;
    expect(canUndoActivity(store, entry, entries(), "editor")).toBe(false);
    expect(canUndoActivity(store, entry, entries(), "owner")).toBe(true);
    undoActivity(store, ME, entry, entries(), T0 + 1);
    expect(store.get("project", "p1")!.name).toBe("Old");
  });

  it("member entries are never undoable", () => {
    const { store, entries } = setup();
    writeProjectActivity(store, ME, { projectId: "p1" }, "member_invited", null, "a@b.c", T0);
    expect(canUndoActivity(store, entries()[0]!, entries(), "owner")).toBe(false);
  });
});

describe("pruneOwnActivity", () => {
  it("deletes only the actor's entries older than the cutoff", () => {
    const { store, entries } = setup();
    writeProjectActivity(store, ME, { projectId: "p" }, "project_renamed", "a", "b", T0 - 100);
    writeProjectActivity(store, BO, { projectId: "p" }, "project_renamed", "b", "c", T0 - 100);
    writeProjectActivity(store, ME, { projectId: "p" }, "project_renamed", "c", "d", T0);
    expect(pruneOwnActivity(store, ME, 50, T0)).toBe(1);
    expect(entries().map((a) => a.to)).toEqual(["d", "c"]);
  });
});
