import { act, renderHook } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { derivedUuidV1, derivedUuidV2 } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { useHabitCheckins } from "./useHabitCheckins";

async function setup(seed: (store: LocalStore) => void = () => {}) {
  const store = new LocalStore("test");
  seed(store);
  const hook = await renderHook(() => useHabitCheckins(), { wrapper: withApp(store) });
  return { store, hook };
}

describe("useHabitCheckins ids", () => {
  it("writes a new day under the collision-resistant derived id, and its undo removes it", async () => {
    const { store, hook } = await setup();
    let undo = () => {};
    await act(() => {
      undo = hook.result.current.setState("habit-1", "2026-09-24", "done");
    });

    const id = derivedUuidV2("habit_checkin", "habit-1\u00002026-09-24");
    expect(store.get("habit_checkin", id)).toMatchObject({ habit_id: "habit-1", state: "done" });

    await act(() => undo());
    expect(store.list("habit_checkin")).toHaveLength(0);
  });

  it("still finds and updates a day stored under the legacy id", async () => {
    const legacy = derivedUuidV1("habit_checkin", "habit-1\u00002026-09-24");
    const { store, hook } = await setup((s) => {
      s.set("habit_checkin", legacy, "habit_id", "habit-1");
      s.set("habit_checkin", legacy, "date", "2026-09-24");
      s.set("habit_checkin", legacy, "state", "done");
    });

    await act(() => {
      hook.result.current.setState("habit-1", "2026-09-24", "skip");
    });

    expect(store.list("habit_checkin").map((e) => e.id)).toEqual([legacy]);
    expect(store.get("habit_checkin", legacy)!.state).toBe("skip");
  });
});
