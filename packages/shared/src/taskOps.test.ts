import { describe, it, expect, vi } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import {
  allTasks,
  archivedTasks,
  createTask,
  discardTask,
  duplicateTask,
  isTaskLocked,
  moveTask,
  moveTaskToProject,
  reparentTask,
  restoreTask,
  setTaskArchived,
  skipTask,
  softDeleteTask,
  toggleTask,
  updateRecurringTask,
  updateTask,
  visibleTasks,
} from "./taskOps";

/**
 * The task rules, tested against a real in-memory store and no React; these moved out of the web's
 * `useLocalTasks.test.tsx` when the rules were hoisted here, because they were never about
 * the hook: every frontend now applies them.
 */

/** A store plus a helper to read back the single task, since ids are minted inside. */
function setup() {
  const store = new LocalStore("test");
  return { store, only: () => visibleTasks(store)[0]! };
}

describe("createTask / allTasks", () => {
  it("creates a task and lists it", () => {
    const { store } = setup();
    const id = createTask(store, { title: "Buy milk" });
    const tasks = allTasks(store);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(id);
    expect(tasks[0]!.title).toBe("Buy milk");
  });

  it("orders by sort_order, then by creation time", () => {
    const { store } = setup();
    createTask(store, { title: "second", sort_order: 2 });
    createTask(store, { title: "first", sort_order: 1 });
    expect(allTasks(store).map((t) => t.title)).toEqual(["first", "second"]);
  });

  it("mints ids through the store's generator, not the global crypto", () => {
    // The RN app injects expo-crypto's UUID generator because Hermes has no global `crypto`; going
    // through the store is what makes that reach every caller. A non-UUID id 422s the sync batch.
    let calls = 0;
    const store = new LocalStore("test", {
      newId: () => `00000000-0000-4000-8000-${String(++calls).padStart(12, "0")}`,
    });
    const id = createTask(store, { title: "t" });
    expect(id).toBe("00000000-0000-4000-8000-000000000001");
  });
});

describe("task list derivation is shared by every reader of one change", () => {
  it("derives the lists once per change, however many views ask", () => {
    const store = new LocalStore("00000000-0000-0000-0000-0000000000a1");
    createTask(store, { title: "one" });
    const list = vi.spyOn(store, "list");

    // What eleven mounted `useLocalTasks` hooks ask for on one store change.
    for (let i = 0; i < 11; i++) {
      const all = allTasks(store);
      visibleTasks(store, all);
      archivedTasks(store, all);
    }
    expect(list.mock.calls.filter(([kind]) => kind === "task")).toHaveLength(1);
    expect(list.mock.calls.filter(([kind]) => kind === "project")).toHaveLength(1);

    // A change to a task derives them again, once.
    createTask(store, { title: "two" });
    for (let i = 0; i < 11; i++) visibleTasks(store, allTasks(store));
    expect(list.mock.calls.filter(([kind]) => kind === "task")).toHaveLength(2);
    expect(
      visibleTasks(store, allTasks(store))
        .map((t) => t.title)
        .sort(),
    ).toEqual(["one", "two"]);
  });
});

describe("toggleTask", () => {
  it("marks a task completed, and reopens it", () => {
    const { store, only } = setup();
    createTask(store, { title: "t" });

    toggleTask(store, only());
    expect(only().is_completed).toBe(true);
    expect(only().completed_at).not.toBeNull();

    toggleTask(store, only());
    expect(only().is_completed).toBe(false);
    expect(only().completed_at).toBeNull();
  });

  it("completes a recurring task and spawns its next occurrence", () => {
    const { store } = setup();
    const due = 1_672_531_200_000; // 2023-01-01T00:00Z
    const id = createTask(store, {
      title: "water plants",
      due_at: due,
      recurrence: "FREQ=DAILY;INTERVAL=2",
    });

    const spawnedId = toggleTask(store, allTasks(store)[0]!);

    // This instance is really completed; it counts in stats and shows in Completed history.
    const original = allTasks(store).find((t) => t.id === id)!;
    expect(original.is_completed).toBe(true);
    expect(original.completed_at).not.toBeNull();

    // The series continues as a fresh open task with the next occurrence.
    const spawned = allTasks(store).find((t) => t.id === spawnedId)!;
    expect(spawned.is_completed).toBe(false);
    expect(spawned.title).toBe("water plants");
    expect(spawned.recurrence).toBe("FREQ=DAILY;INTERVAL=2");
    expect(spawned.due_at).toBe(due + 2 * 86_400_000);
  });

  it("spawns the next instance with the start window preserved", () => {
    const { store } = setup();
    const due = 1_672_531_200_000;
    const start = due - 3_600_000; // an hour before it is due
    createTask(store, { title: "t", due_at: due, start_at: start, recurrence: "FREQ=DAILY" });

    const spawnedId = toggleTask(store, allTasks(store)[0]!);

    const spawned = allTasks(store).find((t) => t.id === spawnedId)!;
    // The window between start and due is preserved, not collapsed.
    expect(spawned.due_at! - spawned.start_at!).toBe(3_600_000);
  });

  it("carries reminders onto the spawned instance, fire state reset", () => {
    const { store } = setup();
    const due = 1_672_531_200_000;
    createTask(store, { title: "t", due_at: due, recurrence: "FREQ=DAILY" });
    const task = allTasks(store)[0]!;
    store.set("reminder", "r1", "task_id", task.id);
    store.set("reminder", "r1", "offset_min_before_due", 60);
    store.set("reminder", "r1", "fired_at", due - 1);
    store.set("reminder", "r1", "created_at", due);
    store.set("reminder", "r2", "task_id", task.id);
    store.set("reminder", "r2", "at", due - 86_400_000);
    store.set("reminder", "r2", "created_at", due);

    const spawnedId = toggleTask(store, task, undefined, due);

    const copies = store.list("reminder").filter((e) => e.fields.task_id === spawnedId);
    expect(copies).toHaveLength(2);
    // The due-relative reminder rides along as-is; the absolute one shifts by the due delta...
    expect(copies.map((e) => e.fields.offset_min_before_due)).toContain(60);
    expect(copies.map((e) => e.fields.at)).toContain(due - 86_400_000 + 86_400_000);
    // ...and no copy has fired yet.
    expect(copies.every((e) => e.fields.fired_at == null)).toBe(true);
  });

  it("reopening a completed recurring task spawns nothing", () => {
    const { store } = setup();
    const due = 1_672_531_200_000;
    const id = createTask(store, { title: "t", due_at: due, recurrence: "FREQ=DAILY" });
    const spawnedId = toggleTask(store, allTasks(store)[0]!, undefined, due);
    expect(allTasks(store)).toHaveLength(2);

    const completed = allTasks(store).find((t) => t.id === id)!;
    toggleTask(store, { ...completed, is_completed: true });

    expect(allTasks(store)).toHaveLength(2);
    expect(allTasks(store).find((t) => t.id === id)!.is_completed).toBe(false);
    expect(allTasks(store).find((t) => t.id === spawnedId)).toBeDefined();
  });

  it("completes a recurring task that has no due date", () => {
    const { store, only } = setup();
    createTask(store, { title: "t", recurrence: "FREQ=DAILY" });
    toggleTask(store, only());
    // With no due date there is no next occurrence to spawn, so it behaves like any other task.
    expect(only().is_completed).toBe(true);
  });

  it("records a status activity when an actor is given", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t" });
    toggleTask(store, only(), "me");

    expect(store.list("activity").map((e) => e.fields)).toContainEqual(
      expect.objectContaining({ task_id: id, actor_id: "me", kind: "status", to: "completed" }),
    );
  });

  it("writes no activity without an actor", () => {
    const { store, only } = setup();
    createTask(store, { title: "t" });
    toggleTask(store, only());
    expect(store.list("activity")).toHaveLength(0);
  });
});

describe("recurring tasks in the user's time zone", () => {
  // Copenhagen springs forward on Sun 2026-03-29; all-day dues sit at 23:59 local.
  const CPH = "Europe/Copenhagen";
  const SAT_2359 = 1_774_738_740_000; // Sat 2026-03-28 23:59 CET
  const SUN_2359 = 1_774_821_540_000; // Sun 2026-03-29 23:59 CEST
  const NY = "America/New_York";

  it("toggleTask spawns the next local day, still all-day, across a DST change", () => {
    const { store } = setup();
    createTask(store, { title: "t", due_at: SAT_2359, recurrence: "FREQ=DAILY" });
    const spawnedId = toggleTask(store, allTasks(store)[0]!, undefined, SAT_2359, CPH);
    expect(allTasks(store).find((t) => t.id === spawnedId)!.due_at).toBe(SUN_2359);
  });

  it("toggleTask measures an after-completion rule from the local completion day", () => {
    const { store } = setup();
    const due = 1_768_107_540_000; // Sat 2026-01-10 23:59 New York
    const completed = 1_768_143_600_000; // Sun 2026-01-11 10:00 New York (already Jan 11 in UTC too)
    createTask(store, { title: "t", due_at: due, recurrence: "FREQ=DAILY;MODE=COMPLETION" });
    const spawnedId = toggleTask(store, allTasks(store)[0]!, undefined, completed, NY);
    // Mon 2026-01-12 23:59 New York; not Sunday, the completion day itself.
    expect(allTasks(store).find((t) => t.id === spawnedId)!.due_at).toBe(1_768_280_340_000);
  });

  it("skipTask steps BYDAY by the local weekday", () => {
    const { store } = setup();
    const monday = 1_767_675_540_000; // Mon 2026-01-05 23:59 New York (Tuesday in UTC)
    createTask(store, { title: "t", due_at: monday, recurrence: "FREQ=WEEKLY;BYDAY=MO,WE" });
    expect(skipTask(store, allTasks(store)[0]!, undefined, monday, NY)).toBe(true);
    expect(allTasks(store)[0]!.due_at).toBe(1_767_848_340_000); // Wed 2026-01-07 23:59
  });

  it("updateRecurringTask rolls the series to the next local occurrence", () => {
    const { store } = setup();
    const apr30 = 1_777_607_940_000; // Thu 2026-04-30 23:59 New York
    createTask(store, { title: "rent", due_at: apr30, recurrence: "FREQ=MONTHLY" }, NY);
    const task = allTasks(store)[0]!;
    updateRecurringTask(
      store,
      task,
      { title: "rent (paid early)" },
      "this_occurrence",
      undefined,
      apr30,
      NY,
    );
    const series = allTasks(store).find((t) => t.id !== task.id)!;
    expect(series.due_at).toBe(1_780_199_940_000); // Sat 2026-05-30 23:59, not May 31
  });

  it("keeps start_at and absolute reminders at their wall-clock time across a DST change", () => {
    const { store } = setup();
    const start = 1_774_684_800_000; // Sat 2026-03-28 09:00 CET, before the change
    createTask(store, { title: "t", due_at: SUN_2359, start_at: start, recurrence: "FREQ=DAILY" });
    const task = allTasks(store)[0]!;
    store.set("reminder", "r1", "task_id", task.id);
    store.set("reminder", "r1", "at", start);

    const spawnedId = toggleTask(store, task, undefined, SUN_2359, CPH);

    const sun0900 = 1_774_767_600_000; // Sun 2026-03-29 09:00 CEST
    expect(allTasks(store).find((t) => t.id === spawnedId)!.start_at).toBe(sun0900);
    const copy = store.list("reminder").find((e) => e.fields.task_id === spawnedId)!;
    expect(copy.fields.at).toBe(sun0900);
  });
});

describe("monthly rules keep their day of month", () => {
  const at = (iso: string) => Date.parse(`${iso}T09:00:00Z`);
  const iso = (ms: number | null) => new Date(ms!).toISOString().slice(0, 10);

  /** Complete the open task `id` and return its spawned successor. */
  function complete(store: LocalStore, id: string) {
    const task = allTasks(store).find((t) => t.id === id)!;
    const spawnedId = toggleTask(store, task, undefined, task.due_at!, "UTC")!;
    return allTasks(store).find((t) => t.id === spawnedId)!;
  }

  it("createTask records the due date's day, read in the user's zone", () => {
    const { store, only } = setup();
    // Jan 31 23:59 in New York is already Feb 1 in UTC.
    createTask(
      store,
      { title: "rent", due_at: 1_769_921_940_000, recurrence: "FREQ=MONTHLY" },
      "America/New_York",
    );
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
  });

  it("completing a series on the 31st goes through February and back to the 31st", () => {
    const { store } = setup();
    const id = createTask(
      store,
      { title: "rent", due_at: at("2023-01-31"), recurrence: "FREQ=MONTHLY" },
      "UTC",
    );
    const feb = complete(store, id);
    expect(iso(feb.due_at)).toBe("2023-02-28");
    const mar = complete(store, feb.id);
    expect(iso(mar.due_at)).toBe("2023-03-31");
    expect(mar.recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
  });

  it("a rule stored without its day gets the current due date's day on completion", () => {
    const { store } = setup();
    const id = createTask(store, { title: "rent", due_at: at("2023-01-31") });
    store.set("task", id, "recurrence", "FREQ=MONTHLY"); // as a pre-BYMONTHDAY client wrote it
    const feb = complete(store, id);
    expect(iso(feb.due_at)).toBe("2023-02-28");
    expect(feb.recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
    expect(iso(complete(store, feb.id).due_at)).toBe("2023-03-31");
  });

  it("an old series a February already shortened stays on its day, as before", () => {
    const { store } = setup();
    const id = createTask(store, { title: "rent", due_at: at("2023-02-28") });
    store.set("task", id, "recurrence", "FREQ=MONTHLY");
    const mar = complete(store, id);
    expect(iso(mar.due_at)).toBe("2023-03-28");
    expect(mar.recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=28");
  });

  it("skipTask pins an old rule's day too", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "rent", due_at: at("2023-01-31") });
    store.set("task", id, "recurrence", "FREQ=MONTHLY");
    expect(skipTask(store, only(), undefined, at("2023-01-31"), "UTC")).toBe(true);
    expect(iso(only().due_at)).toBe("2023-02-28");
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
    expect(skipTask(store, only(), undefined, at("2023-02-28"), "UTC")).toBe(true);
    expect(iso(only().due_at)).toBe("2023-03-31");
  });

  it("editing the rule takes the day from the due date, keeping 31 on Feb 28", () => {
    const { store, only } = setup();
    createTask(
      store,
      { title: "rent", due_at: at("2023-02-28"), recurrence: "FREQ=MONTHLY;BYMONTHDAY=31" },
      "UTC",
    );
    updateTask(
      store,
      only(),
      { recurrence: "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31" },
      undefined,
      0,
      "UTC",
    );
    expect(only().recurrence).toBe("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31");
    // A rule chosen without a day (the editor's "Monthly") gets the due date's.
    updateTask(store, only(), { recurrence: "FREQ=MONTHLY" }, undefined, 0, "UTC");
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=28");
  });

  it("setting a rule and a due date together anchors on the new date", () => {
    const { store, only } = setup();
    createTask(store, { title: "rent" });
    updateTask(
      store,
      only(),
      { due_at: at("2023-05-17"), recurrence: "FREQ=MONTHLY" },
      undefined,
      0,
      "UTC",
    );
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=17");
  });

  it("moving only this occurrence keeps the series' day", () => {
    const { store, only } = setup();
    createTask(
      store,
      { title: "rent", due_at: at("2023-01-31"), recurrence: "FREQ=MONTHLY" },
      "UTC",
    );
    updateTask(store, only(), { due_at: at("2023-02-02") }, undefined, 0, "UTC");
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
    // Postponed into February, it is February's occurrence: the next one is March's.
    expect(iso(complete(store, only().id).due_at)).toBe("2023-03-31");
  });

  it("moving the series (this and future tasks) moves its day", () => {
    const { store, only } = setup();
    createTask(
      store,
      { title: "rent", due_at: at("2023-01-31"), recurrence: "FREQ=MONTHLY" },
      "UTC",
    );
    updateRecurringTask(
      store,
      only(),
      { due_at: at("2023-01-15") },
      "all_occurrences",
      undefined,
      0,
      "UTC",
    );
    expect(only().recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
  });

  it("detaching one occurrence leaves the series on its day", () => {
    const { store } = setup();
    const id = createTask(store, { title: "rent", due_at: at("2023-01-31") });
    store.set("task", id, "recurrence", "FREQ=MONTHLY");
    const task = allTasks(store)[0]!;
    updateRecurringTask(
      store,
      task,
      { due_at: at("2023-01-20") },
      "this_occurrence",
      undefined,
      0,
      "UTC",
    );
    const series = allTasks(store).find((t) => t.id !== id)!;
    expect(iso(series.due_at)).toBe("2023-02-28");
    expect(series.recurrence).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
  });
});

describe("updateTask", () => {
  it("writes the changed fields and reports the change", () => {
    const { store, only } = setup();
    createTask(store, { title: "old" });

    expect(updateTask(store, only(), { title: "new" })).toBe(true);
    expect(only().title).toBe("new");
    expect(only().notes).toBe("");
  });

  it("skips fields already equal to the current value", () => {
    const { store, only } = setup();
    createTask(store, { title: "same" });
    const before = only().updated_at;

    // Reported as no change, so the caller can skip a pointless sync round-trip.
    expect(updateTask(store, only(), { title: "same" })).toBe(false);
    expect(only().updated_at).toBe(before);
  });

  it("records a due activity with the old and new values", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t", due_at: 1000 });
    updateTask(store, only(), { due_at: 2000 }, "me");

    expect(store.list("activity").map((e) => e.fields)).toContainEqual(
      expect.objectContaining({ task_id: id, kind: "due", from: "1000", to: "2000" }),
    );
  });

  it("records an assignee activity", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t" });
    updateTask(store, only(), { assignee_id: "u2" }, "me");

    expect(store.list("activity").map((e) => e.fields)).toContainEqual(
      expect.objectContaining({ task_id: id, kind: "assignee", to: "u2" }),
    );
  });
});

describe("moveTask", () => {
  it("updates section and order", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t", sort_order: 1 });

    expect(moveTask(store, id, { section_id: "s1", sort_order: 3 })).toBe(true);
    expect(only().section_id).toBe("s1");
    expect(only().sort_order).toBe(3);
  });

  it("ignores undefined fields but writes an explicit null", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t", due_at: 1000, section_id: "s1" });

    // `undefined` means "not part of this move"; `null` means "clear it"; they must not collapse.
    moveTask(store, id, { due_at: null });
    expect(only().due_at).toBeNull();
    expect(only().section_id).toBe("s1");
  });

  it("reports no change for an empty move", () => {
    const { store } = setup();
    const id = createTask(store, { title: "t" });
    expect(moveTask(store, id, {})).toBe(false);
  });

  it("writes parent_id (reparent) but never touches project_id", () => {
    const { store, only } = setup();
    const id = createTask(store, { title: "t", project_id: "p1", sort_order: 1 });
    expect(moveTask(store, id, { parent_id: "parent", sort_order: 5 })).toBe(true);
    expect(only().parent_id).toBe("parent");
    expect(only().sort_order).toBe(5);
    expect(only().project_id).toBe("p1"); // the drag contract: a move never re-homes a task
  });
});

describe("reparentTask", () => {
  it("makes a task a subtask, ranked among siblings", () => {
    const store = new LocalStore("test");
    const parent = createTask(store, { title: "parent" });
    const child = createTask(store, { title: "child" });
    expect(reparentTask(store, allTasks(store), child, parent, 7)).toBe(true);
    const c = allTasks(store).find((t) => t.id === child)!;
    expect(c.parent_id).toBe(parent);
    expect(c.sort_order).toBe(7);
  });

  it("rejects a cycle (nesting a task under its own descendant) with no write", () => {
    const store = new LocalStore("test");
    const a = createTask(store, { title: "a" });
    const a1 = createTask(store, { title: "a1", parent_id: a });
    // Try to nest a under a1 (its child) -> cycle -> rejected.
    expect(reparentTask(store, allTasks(store), a, a1, 1)).toBe(false);
    expect(allTasks(store).find((t) => t.id === a)!.parent_id).toBeNull();
  });
});

describe("visibleTasks", () => {
  it("hides trashed and archived tasks", () => {
    const { store } = setup();
    createTask(store, { title: "kept" });
    createTask(store, { title: "trashed" });
    createTask(store, { title: "archived" });
    const [, trashed, archived] = allTasks(store);

    softDeleteTask(store, trashed!);
    setTaskArchived(store, archived!, true);

    expect(visibleTasks(store).map((t) => t.title)).toEqual(["kept"]);
  });

  it("hides tasks whose project is trashed, without touching the tasks", () => {
    const { store } = setup();
    store.set("project", "p1", "name", "Work");
    createTask(store, { title: "in project", project_id: "p1" });

    store.set("project", "p1", "deleted_at", Date.now());
    expect(visibleTasks(store)).toHaveLength(0);

    // The cascade is resolved at read time, so restoring the project brings its tasks back;
    // nothing was written onto the task itself.
    store.set("project", "p1", "deleted_at", null);
    expect(visibleTasks(store).map((t) => t.title)).toEqual(["in project"]);
  });

  it("hides tasks whose project is archived", () => {
    const { store } = setup();
    store.set("project", "p1", "name", "Work");
    createTask(store, { title: "in project", project_id: "p1" });

    store.set("project", "p1", "archived_at", Date.now());
    expect(visibleTasks(store)).toHaveLength(0);
  });

  it("hides tasks whose section is trashed", () => {
    const { store } = setup();
    store.set("section", "s1", "name", "Doing");
    createTask(store, { title: "in section", section_id: "s1" });

    store.set("section", "s1", "deleted_at", Date.now());
    expect(visibleTasks(store)).toHaveLength(0);
  });

  it("hides tasks whose project sits in an archived folder, however deep", () => {
    const { store } = setup();
    store.set("project", "f1", "kind", "folder");
    store.set("project", "f2", "kind", "folder");
    store.set("project", "f2", "parent_id", "f1");
    store.set("project", "p1", "parent_id", "f2");
    createTask(store, { title: "buried", project_id: "p1" });

    store.set("project", "f1", "archived_at", Date.now());
    expect(visibleTasks(store)).toHaveLength(0);

    // Read-time again: restoring the folder brings the whole subtree; and its tasks; back.
    store.set("project", "f1", "archived_at", null);
    expect(visibleTasks(store).map((t) => t.title)).toEqual(["buried"]);
  });

  it("hides tasks whose project sits in a trashed folder", () => {
    const { store } = setup();
    store.set("project", "f1", "kind", "folder");
    store.set("project", "p1", "parent_id", "f1");
    createTask(store, { title: "buried", project_id: "p1" });
    createTask(store, { title: "loose" });

    store.set("project", "f1", "deleted_at", Date.now());
    expect(visibleTasks(store).map((t) => t.title)).toEqual(["loose"]);
  });
});

describe("archivedTasks", () => {
  it("lists individually-archived tasks only", () => {
    const { store } = setup();
    createTask(store, { title: "archived" });
    createTask(store, { title: "open" });
    setTaskArchived(store, allTasks(store)[0]!, true);

    expect(archivedTasks(store).map((t) => t.title)).toEqual(["archived"]);
  });

  it("excludes a trashed task, even when it is also archived", () => {
    const { store } = setup();
    createTask(store, { title: "t" });
    setTaskArchived(store, allTasks(store)[0]!, true);
    softDeleteTask(store, allTasks(store)[0]!);

    // It belongs to Trash now; showing it in Archive too would offer two competing restores.
    expect(archivedTasks(store)).toHaveLength(0);
  });

  it("omits tasks hidden only because their project is archived", () => {
    const { store } = setup();
    store.set("project", "p1", "name", "Work");
    createTask(store, { title: "in project", project_id: "p1" });
    store.set("project", "p1", "archived_at", Date.now());

    // They come back with the project, so listing them loose would offer a meaningless restore.
    expect(archivedTasks(store)).toHaveLength(0);
  });
});

describe("softDeleteTask / restoreTask / discardTask", () => {
  it("soft-delete hides the task but keeps it recoverable", () => {
    const { store } = setup();
    createTask(store, { title: "t" });
    softDeleteTask(store, allTasks(store)[0]!);

    expect(visibleTasks(store)).toHaveLength(0);
    // Still present in the store; Trash lists it, and it is not a tombstone.
    expect(allTasks(store)).toHaveLength(1);

    restoreTask(store, allTasks(store)[0]!);
    expect(visibleTasks(store)).toHaveLength(1);
  });

  it("discard tombstones the task outright", () => {
    const { store } = setup();
    const id = createTask(store, { title: "t" });
    discardTask(store, id);

    // No soft-delete: an undone duplicate must not linger in Trash the user never meant to fill.
    expect(allTasks(store)).toHaveLength(0);
  });

  it("discard refuses a task this device cannot decrypt", () => {
    const { store } = setup();
    // A synced-in task whose title stayed an encrypted envelope: its blank-looking title is not
    // the user's draft, and a tombstone here would delete it for every member of the project.
    store.set("task", "locked-1", "title", { __enc: 1, iv: "aXY=", ct: "Y3Q=" });
    const before = store.unsyncedOps().length;

    discardTask(store, "locked-1");

    expect(allTasks(store).map((t) => t.id)).toEqual(["locked-1"]);
    expect(store.unsyncedOps()).toHaveLength(before);
  });
});

describe("duplicateTask", () => {
  it("copies all metadata into a fresh open task", () => {
    const { store } = setup();
    createTask(store, {
      title: "Report",
      notes: "draft",
      priority: 2,
      due_at: 1_700_000_000_000,
      estimate_min: 30,
      project_id: "p1",
      section_id: "s1",
      label_ids: ["l1", "l2"],
    });
    const original = allTasks(store)[0]!;
    toggleTask(store, original);
    updateTask(store, allTasks(store)[0]!, { assignee_id: "u2" });

    duplicateTask(store, allTasks(store)[0]!);

    const copy = allTasks(store).find((t) => t.id !== original.id)!;
    expect(copy.title).toBe("Report (copy)");
    expect(copy.notes).toBe("draft");
    expect(copy.priority).toBe(2);
    expect(copy.due_at).toBe(1_700_000_000_000);
    expect(copy.estimate_min).toBe(30);
    // All metadata rides along, including project/section, labels and assignee.
    expect(copy.project_id).toBe("p1");
    expect(copy.section_id).toBe("s1");
    expect(copy.label_ids).toEqual(["l1", "l2"]);
    expect(copy.assignee_id).toBe("u2");
    // Only completion state resets; a copy is work still to do.
    expect(copy.is_completed).toBe(false);
  });
});

describe("moveTaskToProject", () => {
  it("rewrites project and section together, leaving order when unspecified", () => {
    const { store } = setup();
    createTask(store, { title: "t", project_id: "p1", section_id: "s1", sort_order: 5 });
    const task = allTasks(store)[0]!;

    moveTaskToProject(store, task.id, { project_id: "p2", section_id: "s2" });
    const moved = allTasks(store)[0]!;
    expect(moved.project_id).toBe("p2");
    expect(moved.section_id).toBe("s2");
    expect(moved.sort_order).toBe(5); // unchanged when no sort_order given
  });

  it("moves to the Inbox (no project) and can set an explicit rank", () => {
    const { store } = setup();
    createTask(store, { title: "t", project_id: "p1", section_id: "s1" });
    const task = allTasks(store)[0]!;

    moveTaskToProject(store, task.id, { project_id: null, section_id: null, sort_order: 99 });
    const moved = allTasks(store)[0]!;
    expect(moved.project_id).toBeNull();
    expect(moved.section_id).toBeNull();
    expect(moved.sort_order).toBe(99);
  });
});

describe("setTaskArchived", () => {
  it("archives and unarchives", () => {
    const { store } = setup();
    createTask(store, { title: "t" });

    setTaskArchived(store, allTasks(store)[0]!, true);
    expect(allTasks(store)[0]!.archived_at).not.toBeNull();

    setTaskArchived(store, allTasks(store)[0]!, false);
    expect(allTasks(store)[0]!.archived_at).toBeNull();
    expect(visibleTasks(store)).toHaveLength(1);
  });
});

describe("updateRecurringTask", () => {
  it("updates all occurrences when scope is 'all_occurrences'", () => {
    const { store } = setup();
    createTask(store, {
      title: "Weekly team sync",
      due_at: 100_000,
      recurrence: "FREQ=WEEKLY",
      priority: 2,
    });
    const task = allTasks(store)[0]!;

    const changed = updateRecurringTask(
      store,
      task,
      { title: "Weekly sprint sync", priority: 1 },
      "all_occurrences",
    );
    expect(changed).toBe(true);

    const tasks = allTasks(store);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe("Weekly sprint sync");
    expect(tasks[0]!.priority).toBe(1);
    expect(tasks[0]!.recurrence).toBe("FREQ=WEEKLY");
  });

  it("detaches current task as one-off and advances series when scope is 'this_occurrence'", () => {
    const { store } = setup();
    const anchor = new Date("2026-05-10T10:00:00Z").getTime();
    createTask(store, {
      title: "Clean kitchen",
      due_at: anchor,
      recurrence: "FREQ=WEEKLY",
      priority: 3,
    });
    const task = allTasks(store)[0]!;

    const changed = updateRecurringTask(
      store,
      task,
      { title: "Clean kitchen deeply", due_at: anchor + 86_400_000, priority: 1 },
      "this_occurrence",
      undefined,
      anchor,
    );
    expect(changed).toBe(true);

    const tasks = allTasks(store);
    expect(tasks).toHaveLength(2);

    // The current task (same id) is now a standalone one-off task with recurrence: null
    const detached = tasks.find((t) => t.id === task.id)!;
    expect(detached.title).toBe("Clean kitchen deeply");
    expect(detached.due_at).toBe(anchor + 86_400_000);
    expect(detached.priority).toBe(1);
    expect(detached.recurrence).toBeNull();

    // The next instance was spawned for the recurring series
    const nextSeries = tasks.find((t) => t.id !== task.id)!;
    expect(nextSeries.title).toBe("Clean kitchen");
    expect(nextSeries.priority).toBe(3);
    expect(nextSeries.recurrence).toBe("FREQ=WEEKLY");
    expect(nextSeries.due_at).toBe(anchor + 7 * 86_400_000);
  });

  it("treats a rule change as a series edit even at 'this_occurrence' scope — no fork", () => {
    const { store } = setup();
    const anchor = new Date("2026-05-10T10:00:00Z").getTime();
    createTask(store, {
      title: "Water plants",
      due_at: anchor,
      recurrence: "FREQ=DAILY;INTERVAL=3",
    });
    const task = allTasks(store)[0]!;

    const changed = updateRecurringTask(
      store,
      task,
      { recurrence: "FREQ=DAILY;INTERVAL=3;MODE=COMPLETION" },
      "this_occurrence",
      undefined,
      anchor,
    );
    expect(changed).toBe(true);

    // One task, still one series: the rule was replaced in place, nothing spawned. The old
    // behavior forked it — a successor on the old rule plus this task recurring on the new one.
    const tasks = allTasks(store);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.recurrence).toBe("FREQ=DAILY;INTERVAL=3;MODE=COMPLETION");
    expect(tasks[0]!.due_at).toBe(anchor);
  });

  it("ends the series on a rule removal instead of spawning a successor", () => {
    const { store } = setup();
    const anchor = new Date("2026-05-10T10:00:00Z").getTime();
    createTask(store, { title: "Water plants", due_at: anchor, recurrence: "FREQ=WEEKLY" });
    const task = allTasks(store)[0]!;

    const changed = updateRecurringTask(
      store,
      task,
      { recurrence: null },
      "this_occurrence",
      undefined,
      anchor,
    );
    expect(changed).toBe(true);

    // "Stop repeating" must not spawn a replacement: the task stays, the series just ends.
    const tasks = allTasks(store);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.recurrence).toBeNull();
    expect(tasks[0]!.due_at).toBe(anchor);
  });
});

describe("skipTask", () => {
  const due = 1_672_531_200_000; // 2023-01-01T00:00Z

  it("advances the due date without completing the task or spawning anything", () => {
    const { store } = setup();
    createTask(store, { title: "water plants", due_at: due, recurrence: "FREQ=DAILY;INTERVAL=2" });

    expect(skipTask(store, allTasks(store)[0]!, undefined, due)).toBe(true);

    expect(allTasks(store)).toHaveLength(1); // no next instance spawned
    const task = allTasks(store)[0]!;
    expect(task.due_at).toBe(due + 2 * 86_400_000);
    // The whole point of a skip: the task stays open, so no completion stat can see it.
    expect(task.is_completed).toBe(false);
    expect(task.completed_at).toBeNull();
  });

  it("shifts start_at by the same delta and moves absolute reminders with the due date", () => {
    const { store } = setup();
    const start = due - 3_600_000; // an hour before it is due
    createTask(store, { title: "t", due_at: due, start_at: start, recurrence: "FREQ=DAILY" });
    const task = allTasks(store)[0]!;
    store.set("reminder", "r1", "task_id", task.id);
    store.set("reminder", "r1", "at", due - 86_400_000);
    store.set("reminder", "r2", "task_id", task.id);
    store.set("reminder", "r2", "offset_min_before_due", 60);

    skipTask(store, task, undefined, due);

    const moved = allTasks(store)[0]!;
    expect(moved.start_at).toBe(start + 86_400_000);
    // The absolute reminder keeps its distance from the (moved) due date...
    expect(store.list("reminder").find((e) => e.id === "r1")!.fields.at).toBe(
      due - 86_400_000 + 86_400_000,
    );
    // ...and the due-relative one is untouched (it follows the due date on its own).
    expect(store.list("reminder").find((e) => e.id === "r2")!.fields.at).toBeUndefined();
  });

  it("records a due activity (like any reschedule) but no status activity", () => {
    const { store } = setup();
    createTask(store, { title: "t", due_at: due, recurrence: "FREQ=DAILY" });

    skipTask(store, allTasks(store)[0]!, "me", due);

    const kinds = store.list("activity").map((e) => e.fields.kind);
    expect(kinds).toContain("due");
    expect(kinds).not.toContain("status");
  });

  it("measures an after-completion rule from the skip moment", () => {
    const { store } = setup();
    createTask(store, { title: "t", due_at: due, recurrence: "FREQ=DAILY;MODE=COMPLETION" });

    // Skipped ten days after the due date: the series continues from today, not the stale anchor.
    skipTask(store, allTasks(store)[0]!, undefined, due + 10 * 86_400_000);

    expect(allTasks(store)[0]!.due_at).toBe(due + 11 * 86_400_000);
  });

  it("never moves the due date backward", () => {
    const { store } = setup();
    const futureDue = 1_680_134_400_000; // 2023-03-30T00:00Z, pushed well past the skip moment
    createTask(store, { title: "t", due_at: futureDue, recurrence: "FREQ=DAILY;MODE=COMPLETION" });

    // An after-completion rule measured from now (2023-03-22) would land before the due date;
    // a skip advances, it does not rewind.
    expect(skipTask(store, allTasks(store)[0]!, undefined, 1_679_472_000_000)).toBe(false);
    expect(allTasks(store)[0]!.due_at).toBe(futureDue);
  });

  it("no-ops for completed tasks, non-recurring tasks, and tasks without a due date", () => {
    const { store, only } = setup();
    createTask(store, { title: "plain", due_at: due });
    expect(skipTask(store, only(), undefined, due)).toBe(false);

    createTask(store, { title: "undated", recurrence: "FREQ=DAILY" });
    expect(skipTask(store, allTasks(store)[1]!, undefined, due)).toBe(false);

    createTask(store, { title: "done", due_at: due, recurrence: "FREQ=DAILY" });
    const done = allTasks(store)[2]!;
    expect(skipTask(store, { ...done, is_completed: true }, undefined, due)).toBe(false);
  });
});

describe("a locked task is read-only", () => {
  // A task this device cannot decrypt: its title (and, here, labels) are still envelopes, so the
  // typed values are placeholders. A write built from them; labels "[] + one", a " (copy)" of a
  // blank title, a move out of its shared project; would overwrite what the members see.
  const ENVELOPE = { __enc: 1, iv: "aXY=", ct: "Y3Q=" };
  function lockedTask() {
    const store = new LocalStore("test");
    const id = createTask(store, {
      title: "t",
      project_id: "p1",
      due_at: 1_700_000_000_000,
      recurrence: "FREQ=DAILY",
    });
    store.set("task", id, "title", ENVELOPE);
    store.set("task", id, "label_ids", ENVELOPE);
    const task = allTasks(store)[0]!;
    return { store, id, task, ops: () => store.unsyncedOps().length };
  }

  it("is detected from the store, even through a stale snapshot", () => {
    const { store, id, task } = lockedTask();
    expect(isTaskLocked(store, id)).toBe(true);
    expect(task.locked).toBe(true);
    // A snapshot taken before the envelope arrived still hits the store's answer.
    expect(updateTask(store, { ...task, locked: undefined }, { priority: 1 })).toBe(false);
  });

  it("refuses every write and writes no op", () => {
    const { store, id, task, ops } = lockedTask();
    const before = ops();

    expect(updateTask(store, task, { label_ids: ["l1"] })).toBe(false);
    expect(updateRecurringTask(store, task, { priority: 1 }, "this_occurrence")).toBe(false);
    expect(toggleTask(store, task)).toBeNull();
    expect(skipTask(store, task)).toBe(false);
    expect(moveTask(store, id, { due_at: 1 })).toBe(false);
    expect(reparentTask(store, [task], id, null, 5)).toBe(false);
    expect(moveTaskToProject(store, id, { project_id: null, section_id: null })).toBe(false);
    expect(softDeleteTask(store, task)).toBe(false);
    expect(restoreTask(store, task)).toBe(false);
    expect(setTaskArchived(store, task, true)).toBe(false);
    expect(duplicateTask(store, task)).toBeNull();
    expect(discardTask(store, id)).toBe(false);

    expect(store.unsyncedOps()).toHaveLength(before);
    expect(allTasks(store)).toHaveLength(1);
    expect(allTasks(store)[0]!.project_id).toBe("p1");
  });

  it("writes again once the values open", () => {
    const { store, id, task } = lockedTask();
    store.set("task", id, "title", "Readable");
    store.set("task", id, "label_ids", []);
    expect(isTaskLocked(store, id)).toBe(false);
    expect(updateTask(store, { ...task, locked: undefined }, { priority: 1 })).toBe(true);
  });
});
