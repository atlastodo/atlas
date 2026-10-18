import { type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { TRASH_RETENTION_MS } from "@atlastodo/shared";
import { StoreContext } from "../data/StoreProvider";
import { useTrashSweep } from "./useTrash";

/** A store context whose first successful sync the test flips, as `StoreProvider` would. */
function contextFor(store: LocalStore, synced: { current: boolean }) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreContext.Provider
        value={{
          store,
          status: "idle",
          version: 0,
          kick: () => {},
          resync: async () => {},
          diagnostics: {
            lastError: null,
            lastSyncAt: synced.current ? 1 : null,
            quarantined: [],
            pending: 0,
          },
          attachments: null,
          initialSyncDone: true,
        }}
      >
        {children}
      </StoreContext.Provider>
    );
  };
}

const longAgo = () => Date.now() - TRASH_RETENTION_MS - 60_000;

describe("useTrashSweep", () => {
  it("leaves a stale deletion alone until the first sync says what is still deleted", async () => {
    const store = new LocalStore("test");
    store.set("task", "t1", "title", "Restored on the laptop");
    // What this device last saw: deleted long ago. The laptop has since restored it.
    store.set("task", "t1", "deleted_at", longAgo());
    const synced = { current: false };
    const { rerender } = await renderHook(() => useTrashSweep(), {
      wrapper: contextFor(store, synced),
    });

    expect(store.get("task", "t1")?.title).toBe("Restored on the laptop");

    // The first sync brings the restore, then the sweep may run.
    await act(() => store.set("task", "t1", "deleted_at", null));
    synced.current = true;
    await rerender({});
    expect(store.get("task", "t1")?.title).toBe("Restored on the laptop");
  });

  it("purges what is still expired once a sync has succeeded", async () => {
    const store = new LocalStore("test");
    store.set("task", "t1", "title", "Long gone");
    store.set("task", "t1", "deleted_at", longAgo());
    const synced = { current: false };
    const { rerender } = await renderHook(() => useTrashSweep(), {
      wrapper: contextFor(store, synced),
    });

    synced.current = true;
    await rerender({});
    expect(store.get("task", "t1")).toBeNull();
  });
});
