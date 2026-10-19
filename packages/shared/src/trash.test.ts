import { describe, it, expect } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import {
  TRASH_RETENTION_MS,
  daysUntilPurge,
  listTrash,
  purge,
  purgeAllTrash,
  restoreFromTrash,
  softDelete,
  sweepExpiredTrash,
} from "./trash";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const noop = () => {};

describe("daysUntilPurge", () => {
  it("is the full 30 days the moment an item is deleted", () => {
    expect(daysUntilPurge(NOW, NOW)).toBe(30);
  });

  it("counts down (rounding a partial day up) as the window elapses", () => {
    expect(daysUntilPurge(NOW - 10 * DAY, NOW)).toBe(20);
    expect(daysUntilPurge(NOW - 29 * DAY, NOW)).toBe(1); // still within the last day
    expect(daysUntilPurge(NOW - 29.5 * DAY, NOW)).toBe(1); // partial day rounds up, never 0 while live
  });

  it("never goes below 0 once the window has passed", () => {
    expect(daysUntilPurge(NOW - 40 * DAY, NOW)).toBe(0);
  });
});

describe("softDelete / restore", () => {
  it("sets deleted_at, and the returned undo clears it", () => {
    const store = new LocalStore("test");
    store.set("saved_filter", "f1", "name", "Work");

    const undo = softDelete(store, noop, "saved_filter", "f1");
    expect(store.get("saved_filter", "f1")?.deleted_at).toEqual(expect.any(Number));

    undo();
    expect(store.get("saved_filter", "f1")?.deleted_at).toBeNull();
  });

  it("restoreFromTrash clears deleted_at", () => {
    const store = new LocalStore("test");
    store.set("habit", "h1", "name", "Read");
    store.set("habit", "h1", "deleted_at", NOW);

    restoreFromTrash(store, noop, "habit", "h1");
    expect(store.get("habit", "h1")?.deleted_at).toBeNull();
  });

  it("keeps a habit's check-ins through a soft delete, so restoring brings its history back", () => {
    const store = new LocalStore("test");
    store.set("habit", "h1", "name", "Read");
    store.set("habit_checkin", "c1", "habit_id", "h1");
    store.set("habit_checkin", "c1", "date", "2026-07-06");

    const undo = softDelete(store, noop, "habit", "h1");
    expect(store.get("habit_checkin", "c1")).not.toBeNull();

    undo();
    expect(store.get("habit", "h1")?.deleted_at).toBeNull();
    expect(store.get("habit_checkin", "c1")?.date).toBe("2026-07-06");
  });

  it("purging a habit takes its check-ins with it, leaving no orphans", () => {
    const store = new LocalStore("test");
    store.set("habit", "h1", "name", "Read");
    store.set("habit_checkin", "c1", "habit_id", "h1");
    store.set("habit_checkin", "c2", "habit_id", "h1");
    // Another habit's check-in must survive.
    store.set("habit_checkin", "c3", "habit_id", "h2");

    purge(store, noop, "habit", "h1");

    expect(store.get("habit", "h1")).toBeNull();
    expect(store.get("habit_checkin", "c1")).toBeNull();
    expect(store.get("habit_checkin", "c2")).toBeNull();
    expect(store.get("habit_checkin", "c3")).not.toBeNull();
  });

  it("purging a habit group takes its members and their check-ins with it", () => {
    const store = new LocalStore("test");
    store.set("habit", "g1", "kind", "group");
    store.set("habit", "m1", "parent_id", "g1");
    store.set("habit", "m2", "parent_id", "g1");
    store.set("habit_checkin", "c1", "habit_id", "m1");
    store.set("habit_checkin", "c2", "habit_id", "m2");
    // Another group's habit and check-in must survive.
    store.set("habit", "other", "parent_id", "g2");
    store.set("habit_checkin", "c3", "habit_id", "other");

    purge(store, noop, "habit", "g1");

    expect(store.get("habit", "g1")).toBeNull();
    expect(store.get("habit", "m1")).toBeNull();
    expect(store.get("habit", "m2")).toBeNull();
    expect(store.get("habit_checkin", "c1")).toBeNull();
    expect(store.get("habit_checkin", "c2")).toBeNull();
    expect(store.get("habit", "other")).not.toBeNull();
    expect(store.get("habit_checkin", "c3")).not.toBeNull();
  });

  it("keeps a group's members through a soft delete, so restoring brings the routine back whole", () => {
    const store = new LocalStore("test");
    store.set("habit", "g1", "kind", "group");
    store.set("habit", "m1", "parent_id", "g1");
    store.set("habit_checkin", "c1", "habit_id", "m1");

    const undo = softDelete(store, noop, "habit", "g1");
    expect(store.get("habit", "m1")).not.toBeNull();
    expect(store.get("habit_checkin", "c1")).not.toBeNull();

    undo();
    expect(store.get("habit", "g1")?.deleted_at).toBeNull();
    expect(store.get("habit", "m1")).not.toBeNull();
  });

  it("purging a member on its own leaves the rest of the group alone", () => {
    const store = new LocalStore("test");
    store.set("habit", "g1", "kind", "group");
    store.set("habit", "m1", "parent_id", "g1");
    store.set("habit", "m2", "parent_id", "g1");

    purge(store, noop, "habit", "m1");

    expect(store.get("habit", "m1")).toBeNull();
    expect(store.get("habit", "g1")).not.toBeNull();
    expect(store.get("habit", "m2")).not.toBeNull();
  });
});

describe("listTrash", () => {
  it("lists soft-deleted items within the window, newest first, and skips expired", () => {
    const store = new LocalStore("test");
    store.set("task", "t1", "title", "Recent");
    store.set("task", "t1", "deleted_at", NOW - 1000);
    store.set("project", "p1", "name", "Older");
    store.set("project", "p1", "deleted_at", NOW - 5000);
    store.set("task", "t2", "title", "Expired");
    store.set("task", "t2", "deleted_at", NOW - TRASH_RETENTION_MS - 1);
    store.set("task", "t3", "title", "Alive"); // not deleted

    const items = listTrash(store, NOW);
    expect(items.map((i) => i.id)).toEqual(["t1", "p1"]); // newest first, expired + alive excluded
    expect(items[0]).toMatchObject({ kind: "task", label: "Recent" });
    expect(items[1]).toMatchObject({ kind: "project", label: "Older" });
  });

  it("annotates each item with its days left before purge", () => {
    const store = new LocalStore("test");
    store.set("task", "fresh", "title", "Fresh");
    store.set("task", "fresh", "deleted_at", NOW - 1000); // ~just deleted -> 30
    store.set("task", "aging", "title", "Aging");
    store.set("task", "aging", "deleted_at", NOW - 25 * DAY); // 5 days left

    const byId = Object.fromEntries(listTrash(store, NOW).map((i) => [i.id, i.daysLeft]));
    expect(byId.fresh).toBe(30);
    expect(byId.aging).toBe(5);
  });
});

describe("purge", () => {
  it("hard-removes a project and cascades to its sections and tasks", () => {
    const store = new LocalStore("test");
    store.set("project", "p1", "name", "Doomed");
    store.set("project", "p1", "deleted_at", NOW);
    store.set("section", "s1", "project_id", "p1");
    store.set("task", "t1", "project_id", "p1");
    store.set("task", "keep", "project_id", "other");

    purge(store, noop, "project", "p1");

    expect(store.get("project", "p1")).toBeNull();
    expect(store.get("section", "s1")).toBeNull();
    expect(store.get("task", "t1")).toBeNull();
    expect(store.get("task", "keep")).not.toBeNull();
  });

  it.each(["task", "section", "project"] as const)(
    "purging a %s tombstones the attachments of the tasks it removes",
    (kind) => {
      const store = new LocalStore("test");
      store.set("project", "p1", "name", "Doomed");
      store.set("section", "s1", "project_id", "p1");
      store.set("task", "t1", "project_id", "p1");
      store.set("task", "t1", "section_id", "s1");
      store.set("task", "other", "title", "Keep");
      store.set("attachment", "a1", "task_id", "t1");
      store.set("attachment", "a2", "task_id", "other");
      const id = { task: "t1", section: "s1", project: "p1" }[kind];

      purge(store, noop, kind, id);

      expect(store.get("attachment", "a1")).toBeNull();
      expect(store.list("attachment").map((e) => e.id)).toEqual(["a2"]);
      expect(store.unsyncedOps().some((o) => o.op === "delete" && o.entityId === "a1")).toBe(true);
    },
  );

  it.each(["task", "section", "project"] as const)(
    "purging a %s tombstones the reminders, comments and activity of the tasks it removes",
    (kind) => {
      const store = new LocalStore("test");
      store.set("project", "p1", "name", "Doomed");
      store.set("section", "s1", "project_id", "p1");
      store.set("task", "t1", "project_id", "p1");
      store.set("task", "t1", "section_id", "s1");
      store.set("task", "other", "title", "Keep");
      for (const child of ["reminder", "comment", "activity"] as const) {
        store.set(child, `${child}-doomed`, "task_id", "t1");
        store.set(child, `${child}-kept`, "task_id", "other");
      }
      // Already in Trash on its own: the purge must still tombstone it.
      store.set("comment", "comment-trashed", "task_id", "t1");
      store.set("comment", "comment-trashed", "deleted_at", NOW);
      const id = { task: "t1", section: "s1", project: "p1" }[kind];

      purge(store, noop, kind, id);

      for (const child of ["reminder", "comment", "activity"] as const) {
        expect(store.list(child).map((e) => e.id)).toEqual([`${child}-kept`]);
        expect(
          store.unsyncedOps().some((o) => o.op === "delete" && o.entityId === `${child}-doomed`),
        ).toBe(true);
      }
      expect(store.get("comment", "comment-trashed")).toBeNull();
    },
  );

  it("lists a deleted attachment in the trash and tombstones it when purged", () => {
    const store = new LocalStore("test");
    store.set("attachment", "a1", "task_id", "t1");
    softDelete(store, noop, "attachment", "a1");
    const [item] = listTrash(store, Date.now());
    expect(item).toMatchObject({ kind: "attachment", id: "a1" });

    purge(store, noop, "attachment", "a1");
    expect(store.get("attachment", "a1")).toBeNull();
  });

  it("cascades a folder to the projects nested inside it, and their contents", () => {
    const store = new LocalStore("test");
    store.set("project", "f1", "kind", "folder");
    store.set("project", "f1", "deleted_at", NOW);
    store.set("project", "f2", "kind", "folder");
    store.set("project", "f2", "parent_id", "f1");
    store.set("project", "p1", "parent_id", "f2");
    store.set("section", "s1", "project_id", "p1");
    store.set("task", "t1", "project_id", "p1");
    store.set("project", "elsewhere", "name", "Kept");
    store.set("task", "keep", "project_id", "elsewhere");

    purge(store, noop, "project", "f1");

    // Nothing may survive a permanent delete as an orphan pointing at a project that is gone.
    for (const id of ["f1", "f2", "p1"]) expect(store.get("project", id)).toBeNull();
    expect(store.get("section", "s1")).toBeNull();
    expect(store.get("task", "t1")).toBeNull();
    expect(store.get("project", "elsewhere")).not.toBeNull();
    expect(store.get("task", "keep")).not.toBeNull();
  });

  it("terminates on a parent cycle in the data", () => {
    const store = new LocalStore("test");
    store.set("project", "a", "parent_id", "b");
    store.set("project", "b", "parent_id", "a");

    purge(store, noop, "project", "a");
    expect(store.get("project", "a")).toBeNull();
    expect(store.get("project", "b")).toBeNull();
  });
});

describe("sweepExpiredTrash", () => {
  it("purges only items past the 30-day window", () => {
    const store = new LocalStore("test");
    store.set("task", "old", "title", "Old");
    store.set("task", "old", "deleted_at", NOW - TRASH_RETENTION_MS - 1);
    store.set("task", "recent", "title", "Recent");
    store.set("task", "recent", "deleted_at", NOW - 1000);

    const purged = sweepExpiredTrash(store, noop, NOW);
    expect(purged).toBe(1);
    expect(store.get("task", "old")).toBeNull();
    expect(store.get("task", "recent")).not.toBeNull();
  });
});

describe("purgeAllTrash", () => {
  it("purges all soft-deleted items across kinds with child cascade", () => {
    const store = new LocalStore("test");
    store.set("task", "t1", "title", "Task 1");
    store.set("task", "t1", "deleted_at", NOW - 1000);
    store.set("project", "p1", "name", "Project 1");
    store.set("project", "p1", "deleted_at", NOW - 5000);
    store.set("section", "s1", "project_id", "p1");
    store.set("task", "t2", "project_id", "p1");
    store.set("task", "alive", "title", "Alive task"); // not deleted

    const count = purgeAllTrash(store, noop, NOW);
    expect(count).toBe(2); // t1 and p1 were in trash list
    expect(store.get("task", "t1")).toBeNull();
    expect(store.get("project", "p1")).toBeNull();
    expect(store.get("section", "s1")).toBeNull();
    expect(store.get("task", "t2")).toBeNull();
    expect(store.get("task", "alive")).not.toBeNull();
  });
});

describe("restoring an item another device purged meanwhile", () => {
  it("brings it back whole on every device, not as an untitled item outside its project", () => {
    const nodes = ["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000a2"];
    const device = (node: string, start: number) => {
      let t = start;
      let n = 0;
      return new LocalStore(node, { now: () => t++, newId: () => `${start}-${n++}` });
    };
    const origin = device(nodes[0]!, 1000);
    const seed = [
      origin.set("task", "t1", "title", "Pay rent"),
      origin.set("task", "t1", "project_id", "p1"),
      origin.set("task", "t1", "deleted_at", 1500),
    ];
    const a = device(nodes[0]!, 2000);
    const b = device(nodes[1]!, 3000);
    a.applyRemoteBatch(seed);
    b.applyRemoteBatch(seed);

    // A empties the trash while B, offline, restores the same task.
    purge(a, noop, "task", "t1");
    restoreFromTrash(b, noop, "task", "t1");

    for (const order of [
      [...a.unsyncedOps(), ...b.unsyncedOps()],
      [...b.unsyncedOps(), ...a.unsyncedOps()],
    ]) {
      const other = device("00000000-0000-0000-0000-0000000000a3", 4000);
      other.applyRemoteBatch([...seed, ...order]);
      expect(other.get("task", "t1")).toEqual({
        title: "Pay rent",
        project_id: "p1",
        deleted_at: null,
      });
    }
  });
});
