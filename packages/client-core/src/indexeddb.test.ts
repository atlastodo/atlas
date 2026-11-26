import { describe, it, expect } from "bun:test";
import { waitFor } from "./runner.testutil";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDbPersistence } from "./indexeddb";
import type { Operation } from "./types";

/** Open `name` at `version` directly, failing if it neither succeeds nor errors within `ms`. */
function openRaw(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade?: (db: IDBDatabase) => void,
  ms = 1_000,
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    const timer = setTimeout(() => reject(new Error(`open v${version} still waiting`)), ms);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error);
    };
  });
}

describe("IndexedDbPersistence across tabs", () => {
  it("closes its connection when another tab upgrades the database, and says so", async () => {
    const factory = new IDBFactory();
    let versionChanges = 0;
    const p = new IndexedDbPersistence("atlas-tabs-1", factory, {
      onVersionChange: () => versionChanges++,
    });
    await p.setCursor(3);

    // A newer build in another tab opens the next version: it must not wait on this tab forever.
    const newer = await openRaw(factory, "atlas-tabs-1", 99);
    newer.close();
    expect(versionChanges).toBe(1);
  });

  it("reports an open blocked by another tab's older connection, then proceeds once it closes", async () => {
    const factory = new IDBFactory();
    // An old build (the v1 schema) that never closes its connection.
    const older = await openRaw(factory, "atlas-tabs-2", 1, (db) => {
      db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true }).createIndex(
        "op_id",
        "op_id",
        {
          unique: true,
        },
      );
      db.createObjectStore("meta", { keyPath: "key" });
    });
    let blocked = 0;
    const p = new IndexedDbPersistence("atlas-tabs-2", factory, { onBlocked: () => blocked++ });

    const loading = p.load();
    // The blocked event arrives on a later task; wait for it rather than a fixed delay.
    await waitFor(() => expect(blocked).toBe(1));

    older.close();
    await expect(loading).resolves.toEqual([]);
  });
});

describe("IndexedDbPersistence with two tabs writing", () => {
  it("does not lose a batch when another tab stores one of its ops meanwhile", async () => {
    const factory = new IDBFactory();
    const tabA = new IndexedDbPersistence("atlas-tabs-3", factory);
    const tabB = new IndexedDbPersistence("atlas-tabs-3", factory);
    await Promise.all([tabA.load(), tabB.load()]);
    const op = (id: string): Operation => ({
      id,
      entity: "task",
      entityId: "t1",
      ts: { wallMs: 1, counter: 0, node: "00000000-0000-0000-0000-0000000000a1" },
      op: "set",
      field: "title",
      value: id,
    });
    const batch = Array.from({ length: 20 }, (_, i) => op(`op-${i}`));

    // Both tabs receive the same pull; B stores the last op while A's batch is being written.
    await Promise.all([tabA.appendBatch(batch, true), tabB.append(batch[19]!, true)]);

    const ids = (await tabA.load()).map((r) => r.op.id).sort();
    expect(ids).toEqual(batch.map((o) => o.id).sort());
  });
});
