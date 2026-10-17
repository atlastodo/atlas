import { act, fireEvent, renderHook, screen } from "@testing-library/react-native";
import { LocalStore, type Operation } from "@atlastodo/client-core";
import { allTasks, PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { useLocalTasks } from "./useLocalTasks";
import { useTaskListView } from "./useTaskListView";

/**
 * `discard` is a hard tombstone that syncs to every member of a shared project, so it may only ever
 * remove a task this device created in this session (a draft, an undone duplicate, an undone
 * recurring spawn). These run over a real in-memory store; "remote" tasks arrive through
 * `applyRemote`, exactly as a sync pull lands them.
 */

const ENVELOPE = { __enc: 1, iv: "aXY=", ct: "Y3Q=" };

let seq = 0;
/** Land a task as if another device had written it and it just synced in. */
function remoteTask(store: LocalStore, id: string, fields: Record<string, unknown>) {
  for (const [field, value] of Object.entries(fields)) {
    seq += 1;
    store.applyRemote({
      id: `remote-op-${seq}`,
      entity: "task",
      entityId: id,
      ts: { wallMs: Date.now(), counter: seq, node: "other-device" },
      op: "set",
      field,
      value,
    });
  }
}

const deletes = (store: LocalStore): Operation[] =>
  store.unsyncedOps().filter((op) => op.op === "delete");

/** A store seeded *before* the hook mounts, so the hook's first derive already holds the tasks. */
async function setup(seed: (store: LocalStore) => void = () => {}) {
  const store = new LocalStore("test");
  seed(store);
  const hook = await renderHook(() => useLocalTasks(), { wrapper: withApp(store) });
  return { store, hook };
}

describe("useLocalTasks.discard", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("writes no delete for a blank task that synced in from elsewhere", async () => {
    const { store, hook } = await setup((s) =>
      remoteTask(s, "remote-blank", { title: "", created_at: 1 }),
    );

    await act(() => hook.result.current.discard("remote-blank"));

    expect(store.get("task", "remote-blank")).not.toBeNull();
    expect(deletes(store)).toHaveLength(0);
  });

  it("writes no delete for a task this device cannot decrypt", async () => {
    const { store, hook } = await setup((s) =>
      remoteTask(s, "remote-locked", { title: ENVELOPE, created_at: 1 }),
    );

    await act(() => hook.result.current.discard("remote-locked"));

    expect(store.get("task", "remote-locked")).not.toBeNull();
    expect(deletes(store)).toHaveLength(0);
  });

  it("removes a blank draft it created itself", async () => {
    const { store, hook } = await setup();
    let id = "";
    await act(() => {
      id = hook.result.current.create({ title: "" });
    });

    await act(() => hook.result.current.discard(id));

    expect(store.get("task", id)).toBeNull();
    expect(deletes(store).map((op) => op.entityId)).toEqual([id]);
  });

  it("removes a copy it just duplicated (the duplicate's undo)", async () => {
    const { store, hook } = await setup((s) =>
      remoteTask(s, "original", { title: "Report", created_at: 1 }),
    );
    const original = hook.result.current.tasks.find((t) => t.id === "original")!;
    let copy = "";
    await act(() => {
      copy = hook.result.current.duplicate(original)!;
    });

    await act(() => hook.result.current.discard(copy));

    expect(store.get("task", copy)).toBeNull();
    expect(store.get("task", "original")).not.toBeNull();
  });

  it("removes the next instance a recurring completion spawned (the completion's undo)", async () => {
    const { store, hook } = await setup((s) =>
      remoteTask(s, "daily", {
        title: "Stretch",
        due_at: Date.parse("2026-09-20T09:00:00Z"),
        recurrence: "FREQ=DAILY",
        created_at: 1,
      }),
    );
    const daily = hook.result.current.tasks.find((t) => t.id === "daily")!;
    let spawned: string | null = null;
    await act(() => {
      spawned = hook.result.current.toggle(daily);
    });
    expect(spawned).not.toBeNull();

    await act(() => hook.result.current.discard(spawned!));

    expect(store.get("task", spawned!)).toBeNull();
    // The series' own task is only reopened by the caller, never deleted.
    expect(store.get("task", "daily")).not.toBeNull();
  });
});

describe("list undo toasts still discard what they made", () => {
  it("undoing a bulk duplicate removes the copies", async () => {
    const store = new LocalStore("test");
    remoteTask(store, "original", { title: "Report", created_at: 1 });
    const hook = await renderHook(() => useTaskListView("inbox"), { wrapper: withApp(store) });

    await act(() => hook.result.current.bulkDuplicate(["original"]));
    expect(
      allTasks(store)
        .map((t) => t.title)
        .sort(),
    ).toEqual(["Report", "Report (copy)"]);

    await fireEvent.press(screen.getByText("Undo"));

    expect(allTasks(store).map((t) => t.title)).toEqual(["Report"]);
  });

  it("undoing a recurring completion removes the spawned instance", async () => {
    const store = new LocalStore("test");
    remoteTask(store, "daily", {
      title: "Stretch",
      due_at: Date.parse("2026-09-20T09:00:00Z"),
      recurrence: "FREQ=DAILY",
      created_at: 1,
    });
    const hook = await renderHook(() => useTaskListView("inbox"), { wrapper: withApp(store) });
    const daily = hook.result.current.tasks.find((t) => t.id === "daily")!;

    await act(() => hook.result.current.toggle(daily));
    expect(allTasks(store)).toHaveLength(2);

    await fireEvent.press(screen.getByText("Undo"));

    expect(allTasks(store).map((t) => t.id)).toEqual(["daily"]);
    expect(allTasks(store)[0]!.is_completed).toBe(false);
  });
});

describe("useLocalTasks recurrence", () => {
  it("steps a recurring task in the time zone the user picked, not the device's", async () => {
    // Mon 2026-01-05 23:59 in New York is already Tuesday in UTC and in most device zones.
    const monday = 1_767_675_540_000;
    const { store, hook } = await setup((s) => {
      s.set("preference", PREFERENCES_ID, "timezone", "America/New_York");
      remoteTask(s, "gym", {
        title: "Gym",
        due_at: monday,
        recurrence: "FREQ=WEEKLY;BYDAY=MO,WE",
        created_at: 1,
      });
    });
    const gym = hook.result.current.tasks.find((t) => t.id === "gym")!;

    await act(() => hook.result.current.skip(gym));

    expect(allTasks(store)[0]!.due_at).toBe(1_767_848_340_000); // Wed 2026-01-07 23:59 New York
  });
});

describe("bulk actions on a task this device cannot decrypt", () => {
  // Its label_ids are a placeholder []: adding a label would overwrite the real set and a duplicate would copy a
  // blank title. The ops refuse; the toast counts only what really changed.
  async function lockedAndPlain() {
    const store = new LocalStore("test");
    remoteTask(store, "locked", { title: ENVELOPE, label_ids: ENVELOPE, created_at: 1 });
    remoteTask(store, "plain", { title: "Readable", created_at: 2 });
    const hook = await renderHook(() => useTaskListView("inbox"), { wrapper: withApp(store) });
    return { store, hook, before: store.unsyncedOps().length };
  }

  it("labels, moves and deletes only the readable task", async () => {
    const { store, hook } = await lockedAndPlain();
    await act(() =>
      hook.result.current.bulkSetLabels(["locked", "plain"], { add: ["l1"], remove: [] }),
    );
    expect(screen.getByText("Labeled 1 task")).toBeTruthy();
    await act(() =>
      hook.result.current.bulkMove(["locked", "plain"], { project_id: "p2", section_id: null }),
    );
    await act(() => hook.result.current.bulkDelete(["locked", "plain"]));

    const locked = store.unsyncedOps().filter((op) => op.entityId === "locked");
    expect(locked).toHaveLength(0);
    expect(store.rawField("task", "locked", "label_ids")).toEqual(ENVELOPE);
    expect(store.rawField("task", "plain", "project_id")).toBe("p2");
  });

  it("duplicates nothing it cannot read", async () => {
    const { store, hook, before } = await lockedAndPlain();
    await act(() => hook.result.current.bulkDuplicate(["locked"]));
    expect(allTasks(store)).toHaveLength(2);
    expect(store.unsyncedOps()).toHaveLength(before);
    expect(screen.queryByText(/Duplicated/)).toBeNull();
  });
});
