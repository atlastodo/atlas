import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import type { Hlc } from "./hlc";
import { migrateLegacy, type LegacyKey, type LegacyTransport } from "./legacy";
import { LocalStore } from "./store";
import { SyncClient, type SyncTransport } from "./sync-client";
import type { EntityKind, Operation } from "./types";

let seq = 0;
const newId = () => `0190a6f0-0000-7000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const ts = (wallMs: number, counter = 0): Hlc => ({
  wallMs,
  counter,
  node: "0190a6f0-0000-7000-8000-0000000000d2",
});

function set(
  entity: EntityKind,
  entityId: string,
  field: string,
  value: unknown,
  at: Hlc,
): Operation {
  return { id: newId(), entity, entityId, ts: at, op: "set", field, value };
}

const key = (entity: string, entity_id: string, covered = false): LegacyKey => ({
  entity,
  entity_id,
  covered,
});

/** A fake server: serves `pages` of legacy keys, records pushes and drops. */
function transport(pages: LegacyKey[][], opts: { deferred?: (ops: Operation[]) => string[] } = {}) {
  const pushed: Operation[][] = [];
  const dropped: { entity: string; entity_id: string }[][] = [];
  const t: LegacyTransport = {
    legacyKeys: vi.fn(async (next?: string) => {
      const i = next ? Number(next) : 0;
      return { entities: pages[i] ?? [], next: i + 1 < pages.length ? String(i + 1) : undefined };
    }),
    dropLegacy: vi.fn(async (keys) => {
      dropped.push(keys);
      return keys.length;
    }),
    syncPush: vi.fn(async (ops: Operation[]) => {
      pushed.push(ops);
      return { deferred: opts.deferred?.(ops) ?? [] };
    }),
  };
  return { t, pushed, dropped };
}

describe("migrateLegacy", () => {
  it("re-encodes what this device holds with its stamps, then drops the originals", async () => {
    const store = new LocalStore("device", { newId });
    const [task, gone] = [newId(), newId()];
    store.applyRemoteBatch([
      set("task", task, "title", "Buy milk", ts(10)),
      set("task", task, "notes", "2 litres", ts(11, 1)),
      set("label", gone, "name", "Old", ts(5)),
      { id: newId(), entity: "label", entityId: gone, ts: ts(6), op: "delete" },
    ]);
    const { t, pushed, dropped } = transport([[key("task", task), key("label", gone)]]);
    const result = await migrateLegacy(store, t);

    expect(result).toEqual({ reencoded: 2, covered: 0, left: 0 });
    const ops = pushed.flat();
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "task", entityId: task, field: "title", ts: ts(10) }),
        expect.objectContaining({ entity: "task", entityId: task, field: "notes", ts: ts(11, 1) }),
        expect.objectContaining({ entity: "label", entityId: gone, op: "delete", ts: ts(6) }),
      ]),
    );
    // A field the tombstone hides is not written again.
    expect(ops.some((o) => o.entityId === gone && o.op === "set")).toBe(false);
    expect(dropped.flat()).toEqual([
      { entity: "task", entity_id: task },
      { entity: "label", entity_id: gone },
    ]);
    // The store is not written: nothing to push again, no stamp moved.
    expect(store.unsyncedOps()).toEqual([]);
    expect(store.fieldTs("task", task, "title")).toEqual(ts(10));
  });

  it("drops a covered key as it is, and leaves what it cannot re-encode yet", async () => {
    const store = new LocalStore("device", { newId });
    const [covered, locked, notHere, foreign] = [newId(), newId(), newId(), newId()];
    store.applyRemoteBatch([
      set("task", locked, "title", { __enc: 2, kid: "k", iv: "aXY=", ct: "Y3Q=" }, ts(1)),
      set("activity", foreign, "actor_id", "someone-else", ts(1)),
    ]);
    const { t, pushed, dropped } = transport([
      [
        key("task", covered, true),
        key("task", locked),
        key("comment", notHere),
        key("activity", foreign),
      ],
    ]);
    t.mayReencode = (kind) => kind !== "activity";
    const result = await migrateLegacy(store, t);

    expect(result).toEqual({ reencoded: 0, covered: 1, left: 3 });
    expect(pushed).toEqual([]);
    expect(dropped.flat()).toEqual([{ entity: "task", entity_id: covered }]);
  });

  it("keeps the original of an entity whose push waits for its project's key", async () => {
    const store = new LocalStore("device", { newId });
    const [shared, mine] = [newId(), newId()];
    store.applyRemoteBatch([
      set("task", shared, "title", "Shared", ts(1)),
      set("task", mine, "title", "Mine", ts(1)),
    ]);
    const { t, dropped } = transport([[key("task", shared), key("task", mine)]], {
      deferred: (ops) => ops.filter((o) => o.entityId === shared).map((o) => o.id),
    });
    const result = await migrateLegacy(store, t);
    expect(result).toEqual({ reencoded: 1, covered: 0, left: 1 });
    expect(dropped.flat()).toEqual([{ entity: "task", entity_id: mine }]);
  });

  it("walks every page", async () => {
    const store = new LocalStore("device", { newId });
    const ids = [newId(), newId(), newId()];
    store.applyRemoteBatch(ids.map((id) => set("label", id, "name", id, ts(1))));
    const { t, dropped } = transport(ids.map((id) => [key("label", id)]));
    expect((await migrateLegacy(store, t)).reencoded).toBe(3);
    expect(t.legacyKeys).toHaveBeenCalledTimes(3);
    expect(dropped.flat().map((k) => k.entity_id)).toEqual(ids);
  });
});

describe("the sync client's migration pass", () => {
  function syncTransport(legacy: Partial<SyncTransport>): SyncTransport {
    return {
      syncPush: vi.fn(async () => ({ cursor: 1, applied: 0 })),
      syncPull: vi.fn(async () => ({ operations: [], cursor: 1 })),
      ...legacy,
    };
  }

  it("runs after a cycle, once it found everything, and again later while keys are left", async () => {
    vi.useFakeTimers();
    try {
      const store = new LocalStore("device", { newId });
      const label = newId();
      store.applyRemote(set("label", label, "name", "Old", ts(1)));
      let left = true;
      const legacyKeys = vi.fn(async () => ({
        entities: left ? [key("label", label), key("task", newId())] : [],
      }));
      const dropLegacy = vi.fn(
        async (keys: { entity: string; entity_id: string }[]) => keys.length,
      );
      const onLegacyMigrated = vi.fn();
      const sync = new SyncClient(store, syncTransport({ legacyKeys, dropLegacy }), {
        cursor: 1,
        onLegacyMigrated,
      });
      await sync.sync();
      expect(legacyKeys).toHaveBeenCalledTimes(1);
      expect(onLegacyMigrated).toHaveBeenCalledWith({ reencoded: 1, covered: 0, left: 1 });

      // Within the retry window nothing runs; after it, the pass runs again and finds nothing.
      await sync.sync();
      expect(legacyKeys).toHaveBeenCalledTimes(1);
      left = false;
      vi.advanceTimersByTime(11 * 60_000);
      await sync.sync();
      expect(legacyKeys).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(11 * 60_000);
      await sync.sync();
      expect(legacyKeys).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a server without the routes as having nothing to migrate, and never fails the cycle", async () => {
    const store = new LocalStore("device", { newId });
    const legacyKeys = vi.fn(async () => {
      throw new ApiError(404, "not found");
    });
    const sync = new SyncClient(
      store,
      syncTransport({ legacyKeys, dropLegacy: vi.fn(async () => 0) }),
      { cursor: 1 },
    );
    await expect(sync.sync()).resolves.toMatchObject({ pushed: 0 });
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(11 * 60_000);
      await sync.sync();
      expect(legacyKeys).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
