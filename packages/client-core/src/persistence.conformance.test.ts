import { describe, it, expect } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { LocalStore } from "./store";
import {
  DatabaseClosedError,
  DatabaseResetError,
  MemoryPersistence,
  SqlitePersistence,
  type Persistence,
  type PersistedAttachmentUpload,
} from "./persistence";
import { IndexedDbPersistence } from "./indexeddb";
import { sealPersistence } from "./sealedPersistence";
import { ExpoSqlDatabase } from "./expo-sqlite";
import type { Operation } from "./types";
import type { Repair } from "./scope";
import { FakeExpoDatabase, FakeSqlDatabase } from "./persistence.testutil";

/**
 * Conformance suite for the {@link Persistence} port: every op-log backend (SQLite via expo-sqlite,
 * IndexedDB, the in-memory default) must pass it.
 *
 * A `Durable` models one persistent medium that can be re-opened, like relaunching the app against
 * the same on-disk database.
 */
interface Durable {
  /** Open a persistence view over this medium (repeated opens see the same data). */
  open(): Persistence;
}

const NODE = "00000000-0000-0000-0000-0000000000c1";

const BACKENDS: { name: string; makeDurable: () => Durable }[] = [
  {
    name: "MemoryPersistence",
    makeDurable: () => {
      const p = new MemoryPersistence();
      return { open: () => p };
    },
  },
  {
    name: "SqlitePersistence (over the plugin-sql port)",
    makeDurable: () => {
      const db = new FakeSqlDatabase();
      return { open: () => new SqlitePersistence(db) };
    },
  },
  {
    // The RN app's backend: the same SqlitePersistence, reached through the expo-sqlite
    // adapter instead of the plugin-sql one. Proving the contract here proves the store interface
    // holds on iOS/Android, since only the injected database differs on-device.
    name: "SqlitePersistence (over the expo-sqlite port)",
    makeDurable: () => {
      const db = new ExpoSqlDatabase(new FakeExpoDatabase());
      return { open: () => new SqlitePersistence(db) };
    },
  },
  {
    // The web durable backend. A fresh IDBFactory per medium isolates tests; re-opening the same
    // factory + db name is the analogue of relaunching the browser against the same IndexedDB.
    name: "IndexedDbPersistence (over fake-indexeddb)",
    makeDurable: () => {
      const factory = new IDBFactory();
      const dbName = `atlas-${idbSeq++}`;
      return { open: () => new IndexedDbPersistence(dbName, factory) };
    },
  },
  {
    // A locking client's store: values sealed at rest, over a durable backend. One key per
    // medium, as one device's unlocked app key gives one.
    name: "sealPersistence (over SqlitePersistence)",
    makeDurable: () => {
      const db = new FakeSqlDatabase();
      const key = new Uint8Array(32).fill(7);
      return { open: () => sealPersistence(new SqlitePersistence(db), key) };
    },
  },
  {
    name: "sealPersistence (over fake-indexeddb)",
    makeDurable: () => {
      const factory = new IDBFactory();
      const dbName = `atlas-sealed-${idbSeq++}`;
      const key = new Uint8Array(32).fill(9);
      return { open: () => sealPersistence(new IndexedDbPersistence(dbName, factory), key) };
    },
  },
];

let idbSeq = 0;

let seq = 0;
/** A bare store used only to mint ops with globally-unique ids (stands in for UUIDv7). */
function gen() {
  return new LocalStore(NODE, { newId: () => `c-${seq++}` });
}

let uploadSeq = 0;
/** A fully-populated queue row; the ciphertext stands in for a sealed blob. */
function uploadRow(overrides: Partial<PersistedAttachmentUpload> = {}): PersistedAttachmentUpload {
  const n = uploadSeq++;
  return {
    id: `up-${n}`,
    taskId: `t-${n}`,
    projectId: null,
    blobSha: `a`.repeat(64),
    blobSize: 3,
    ciphertext: new Uint8Array([1, 2, 3]),
    wrappedKey: { iv: "aXY=", ct: "Y3Q=" },
    meta: { __aenc: 1, iv: "aXY=", ct: "bWV0YQ==" },
    thumbSha: null,
    sortOrder: 0,
    createdAt: 1000,
    state: "queued",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    metaReleased: false,
    ...overrides,
  };
}

/** A persistence-backed store over a durable medium; `tag` namespaces minted ids per launch. */
function storeOver(d: Durable, tag: string, startMs = 1000) {
  let t = startMs;
  let n = 0;
  return new LocalStore(NODE, {
    now: () => t++,
    newId: () => `${tag}-${n++}`,
    persistence: d.open(),
  });
}

describe.each(BACKENDS)("Persistence conformance: $name", ({ makeDurable }) => {
  it("appends set and delete ops and loads them in insertion order with synced flags", async () => {
    const p = makeDurable().open();
    const g = gen();
    const setOp = g.set("task", "t1", "title", "Buy milk");
    const delOp = g.remove("task", "t2");
    await p.append(setOp, false);
    await p.append(delOp, true);

    const loaded = await p.load();
    expect(loaded).toEqual([
      { op: setOp, synced: false },
      { op: delOp, synced: true },
    ]);
  });

  it("is idempotent on op id: appending the same op twice stores it once", async () => {
    const p = makeDurable().open();
    const g = gen();
    const op = g.set("task", "t1", "title", "x");
    await p.append(op, false);
    await p.append(op, true);
    const loaded = await p.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.synced).toBe(false); // first write wins; markSynced flips it
  });

  it("markSynced flips only the named ops and ignores an empty list", async () => {
    const p = makeDurable().open();
    const g = gen();
    const a = g.set("task", "t1", "title", "a");
    const b = g.set("task", "t2", "title", "b");
    await p.append(a, false);
    await p.append(b, false);
    await expect(p.markSynced([])).resolves.toBeUndefined();
    await p.markSynced([a.id]);

    const loaded = await p.load();
    expect(loaded.find((l) => l.op.id === a.id)!.synced).toBe(true);
    expect(loaded.find((l) => l.op.id === b.id)!.synced).toBe(false);
  });

  it("preserves every JSON-representable field value type", async () => {
    const p = makeDurable().open();
    const g = gen();
    const values: unknown[] = ["str", 42, true, false, null, [1, 2, 3], { a: 1, b: "two" }];
    for (const [i, v] of values.entries())
      await p.append(g.set("task", `t${i}`, "value", v), false);

    const loaded = await p.load();
    expect(loaded.map((l) => (l.op.op === "set" ? l.op.value : undefined))).toEqual(values);
  });

  it("cursor defaults to 0 and round-trips", async () => {
    const p = makeDurable().open();
    expect(await p.getCursor()).toBe(0);
    await p.setCursor(17);
    expect(await p.getCursor()).toBe(17);
  });

  it("keeps a snapshot bootstrap's resume point apart from the cursor, across a reload", async () => {
    const d = makeDurable();
    const p = d.open();
    expect(await p.getBootstrap!()).toBeNull();
    await p.setCursor(0);
    await p.setBootstrap!({ next: "task/00000000-0000-0000-0000-000000000001/42", cursor: 42 });
    expect(await d.open().getBootstrap!()).toEqual({
      next: "task/00000000-0000-0000-0000-000000000001/42",
      cursor: 42,
    });
    expect(await d.open().getCursor()).toBe(0);

    await p.setBootstrap!(null);
    expect(await d.open().getBootstrap!()).toBeNull();

    await p.setBootstrap!({ next: "x/y/1", cursor: 1 });
    await p.clear!();
    expect(await p.getBootstrap!()).toBeNull();
  });

  it("stores a walk's repairs page by page with its resume point, and drops them with it", async () => {
    const d = makeDurable();
    const p = d.open();
    const repair = (id: string): Repair => ({
      entity: "task",
      entityId: id,
      field: "title",
      ts: { wallMs: 1, counter: 0, node: NODE },
      value: `value of ${id}`,
      reason: "key",
    });
    await p.setBootstrap!({ next: "p2", cursor: 7 }, { page: "", repairs: [repair("t1")] });
    await p.setBootstrap!({ next: "p3", cursor: 7 }, { page: "p2", repairs: [repair("t2")] });
    await p.setBootstrap!({ next: "p4", cursor: 7 }, { page: "p3", repairs: [] });

    const stored = await d.open().getBootstrap!();
    expect(stored?.next).toBe("p4");
    expect(stored?.repairs?.map((r) => r.entityId).sort()).toEqual(["t1", "t2"]);
    expect(stored?.repairs?.find((r) => r.entityId === "t1")).toEqual(repair("t1"));

    await p.setBootstrap!(null);
    await p.setBootstrap!({ next: "p2", cursor: 8 });
    expect(await d.open().getBootstrap!()).toEqual({ next: "p2", cursor: 8 });
  });

  it("clearSynced drops acknowledged ops, the cursor and bootstrap progress, keeping the outbox", async () => {
    const d = makeDurable();
    const p = d.open();
    const g = gen();
    const synced = g.set("task", "t1", "title", "from the server");
    const queued = g.set("task", "t2", "title", "not pushed yet");
    await p.append(synced, true);
    await p.append(queued, false);
    await p.setCursor(12);
    await p.setBootstrap!({ next: "task/x/12", cursor: 12 });

    await p.clearSynced!();

    const reopened = d.open();
    expect(await reopened.load()).toEqual([{ op: queued, synced: false }]);
    expect(await reopened.getCursor()).toBe(0);
    expect(await reopened.getBootstrap!()).toBeNull();
    // Idempotency on op id still holds for the kept rows.
    await reopened.append(queued, false);
    expect(await reopened.load()).toHaveLength(1);
  });

  it("rebuilds an identical read model after a reload (hydrate replays the log)", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    store.set("task", "t1", "title", "Buy milk");
    store.set("task", "t1", "title", "Buy oat milk");
    store.set("project", "p1", "name", "Errands");
    store.remove("task", "t2");
    await store.flush();

    const reloaded = storeOver(d, "re");
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "Buy oat milk" });
    expect(reloaded.get("project", "p1")).toEqual({ name: "Errands" });
    expect(reloaded.get("task", "t2")).toBeNull();
  });

  it("compacts the log to each field's winning write, the tombstones and every unsynced op", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    const title1 = store.set("task", "t1", "title", "a");
    const title2 = store.set("task", "t1", "title", "b");
    const notes = store.set("task", "t1", "notes", "n");
    const hidden = store.set("task", "t2", "title", "gone");
    const del1 = store.remove("task", "t2");
    const del2 = store.remove("task", "t2");
    store.markSynced([title1, title2, notes, hidden, del1, del2].map((o) => o.id));
    // Unsynced ops stay even when superseded: they have yet to reach the server.
    const draft1 = store.set("task", "t3", "title", "draft");
    const draft2 = store.set("task", "t3", "title", "final");
    await store.flush();

    expect(await store.compact()).toBeGreaterThanOrEqual(2);

    const ids = (await d.open().load()).map((r) => r.op.id);
    expect(ids).toEqual([title2, notes, hidden, del2, draft1, draft2].map((o) => o.id));
    const reloaded = storeOver(d, "re");
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "b", notes: "n" });
    expect(reloaded.get("task", "t2")).toBeNull();
    expect(reloaded.rawField("task", "t2", "title")).toBe("gone");
    expect(reloaded.get("task", "t3")).toEqual({ title: "final" });
    expect(reloaded.unsyncedOps().map((o) => o.id)).toEqual([draft1.id, draft2.id]);
  });

  it("compactLocal drops superseded unsynced ops too (no server can refuse them)", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    store.set("task", "t1", "title", "a");
    const title = store.set("task", "t1", "title", "b");
    const notes = store.set("task", "t1", "notes", "n");
    const hidden = store.set("task", "t2", "title", "gone");
    store.remove("task", "t2");
    const del = store.remove("task", "t2");
    await store.flush();

    expect(await store.compactLocal()).toBe(2);

    const kept = [title, notes, hidden, del].map((o) => o.id);
    expect((await d.open().load()).map((r) => r.op.id)).toEqual(kept);
    expect(store.unsyncedOps().map((o) => o.id)).toEqual(kept);
    const reloaded = storeOver(d, "re");
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "b", notes: "n" });
    expect(reloaded.get("task", "t2")).toBeNull();
    expect(reloaded.unsyncedOps().map((o) => o.id)).toEqual(kept);
  });

  it("rebuilds an entity from the remaining log when a refused local op is discarded", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    const accepted = store.set("task", "t1", "title", "server's");
    store.markSynced([accepted.id]);
    const refused = store.set("task", "t1", "title", "refused");
    const created = store.set("task", "t9", "title", "refused too");
    await store.flush();

    store.discard([refused.id, created.id]);
    await store.flush();

    expect(store.get("task", "t1")).toEqual({ title: "server's" });
    expect(store.get("task", "t9")).toBeNull();
    expect(store.unsyncedOps()).toEqual([]);
    expect((await d.open().load()).map((r) => r.op.id)).toEqual([accepted.id]);
  });

  it("compacts on hydrate once enough of the log is superseded", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    const ops = [0, 1, 2, 3].map((i) => store.set("task", "t1", "title", `v${i}`));
    store.markSynced(ops.map((o) => o.id));
    await store.flush();

    const reloaded = new LocalStore(NODE, { persistence: d.open(), compactAfter: 3 });
    await reloaded.hydrate();
    expect((await d.open().load()).map((r) => r.op.id)).toEqual([ops[3]!.id]);
    expect(reloaded.get("task", "t1")).toEqual({ title: "v3" });
  });

  it("skips a malformed op instead of failing the whole load", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    store.set("task", "t1", "title", "kept");
    await store.flush();
    await d
      .open()
      .append({ id: "bad", entity: "task", entityId: "t2" } as unknown as Operation, true);

    const reloaded = storeOver(d, "re");
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "kept" });
    expect(reloaded.exists("task", "t2")).toBe(false);
  });

  it("close() lets queued writes land, then refuses new ones", async () => {
    const d = makeDurable();
    const p = d.open();
    const g = gen();
    const queued = p.append(g.set("task", "t1", "title", "queued"), false);
    await Promise.all([p.close!(), p.close!()]); // closing twice is harmless
    await queued;
    await expect(p.append(g.set("task", "t2", "title", "late"), false)).rejects.toBeInstanceOf(
      DatabaseClosedError,
    );
  });

  it("restores the unsynced outbox but not synced ops across a reload", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig");
    const a = store.set("task", "t1", "title", "a");
    const b = store.set("task", "t2", "title", "b");
    store.markSynced([a.id]);
    await store.flush();

    const reloaded = storeOver(d, "re");
    await reloaded.hydrate();
    expect(reloaded.unsyncedOps().map((o) => o.id)).toEqual([b.id]);
  });

  it("restamps rows in place, keeping their order and synced flags", async () => {
    const d = makeDurable();
    const store = storeOver(d, "orig", 10_000_000 + 3600_000);
    const a = store.set("task", "t1", "title", "a");
    const b = store.remove("task", "t2");
    store.markSynced([a.id]);
    await store.flush();

    const p = d.open();
    const ts = { wallMs: 10_000_000, counter: 7, node: NODE };
    await p.restamp!([
      { ...a, ts },
      { ...b, ts: { ...ts, counter: 8 } },
      { ...b, id: "unknown", ts },
    ]);
    const rows = await d.open().load();
    expect(rows).toEqual([
      { op: { ...a, ts }, synced: true },
      { op: { ...b, ts: { ...ts, counter: 8 } }, synced: false },
    ]);
  });

  it("appends batches atomically and preserves insertion order", async () => {
    const p = makeDurable().open();
    const g = gen();
    const batch = [
      g.set("task", "t1", "title", "First"),
      g.set("task", "t2", "title", "Second"),
      g.set("task", "t3", "title", "Third"),
    ];
    if (p.appendBatch) {
      await p.appendBatch(batch, true);
      const loaded = await p.load();
      expect(loaded).toEqual(batch.map((op) => ({ op, synced: true })));
    }
  });

  it("commits sync batch with cursor atomically", async () => {
    const p = makeDurable().open();
    const g = gen();
    const batch = [g.set("task", "t1", "title", "A"), g.set("task", "t2", "title", "B")];
    if (p.commitSyncBatch) {
      await p.commitSyncBatch(batch, 42);
      expect(await p.getCursor()).toBe(42);
      const loaded = await p.load();
      expect(loaded).toHaveLength(2);
    }
  });

  it("clears all persisted ops and cursor on clear()", async () => {
    const p = makeDurable().open();
    const g = gen();
    await p.append(g.set("task", "t1", "title", "Old"), false);
    await p.setCursor(99);
    if (p.clear) {
      await p.clear();
      expect(await p.getCursor()).toBe(0);
      expect(await p.load()).toHaveLength(0);
    }
  });

  // ---- Device-local attachment upload queue (see attachments.ts; optional backend members) ----

  it("persists the device-local attachment upload queue across a reload", async () => {
    const d = makeDurable();
    const p = d.open();
    if (!p.putAttachmentUpload) return;
    const row = uploadRow({ projectId: "p1", ciphertext: new Uint8Array([9, 8, 7, 6]) });
    await p.putAttachmentUpload(row);

    // Re-open the same medium (the relaunch analogue): the row — ciphertext bytes included —
    // must come back byte-exact so the upload can finish without the original plaintext.
    const reopened = d.open();
    if (!reopened.loadAttachmentQueue || !reopened.putAttachmentUpload) return;
    expect(await reopened.loadAttachmentQueue()).toEqual([row]);

    // Upsert: a state transition replaces the row wholesale.
    const failed = { ...row, state: "failed" as const, attempts: 1, lastError: "too large" };
    await reopened.putAttachmentUpload(failed);
    expect(await reopened.loadAttachmentQueue()).toEqual([failed]);

    // Deletion is how a stored entry leaves the queue (its work continues in the op log).
    if (!reopened.deleteAttachmentUpload) return;
    await reopened.deleteAttachmentUpload(row.id);
    expect(await reopened.loadAttachmentQueue()).toEqual([]);
  });

  it("lists the queue without ciphertext and loads one entry's ciphertext on demand", async () => {
    const d = makeDurable();
    const p = d.open();
    if (
      !p.putAttachmentUpload ||
      !p.listAttachmentQueue ||
      !p.loadAttachmentCiphertext ||
      !p.updateAttachmentUpload ||
      !p.deleteAttachmentUpload ||
      !p.loadAttachmentQueue
    )
      return;
    const row = uploadRow({ ciphertext: new Uint8Array([5, 4, 3, 2, 1]) });
    await p.putAttachmentUpload(row);

    const [listed] = await p.listAttachmentQueue();
    expect(listed).toBeDefined();
    expect("ciphertext" in listed!).toBe(false);
    expect(await p.loadAttachmentCiphertext(row.id)).toEqual(row.ciphertext);

    // A state change keeps the ciphertext as it was.
    const { ciphertext: _c, ...info } = row;
    await p.updateAttachmentUpload({ ...info, state: "failed", lastError: "too large" });
    expect(await p.loadAttachmentQueue()).toEqual([
      { ...row, state: "failed", lastError: "too large" },
    ]);

    // An update after the entry was removed must not bring it back.
    await p.deleteAttachmentUpload(row.id);
    await p.updateAttachmentUpload({ ...info, attempts: 3 });
    expect(await p.listAttachmentQueue()).toEqual([]);
    expect(await p.loadAttachmentCiphertext(row.id)).toBeNull();
  });

  it("takes a Blob of ciphertext and hands back the same bytes", async () => {
    const p = makeDurable().open();
    if (!p.putAttachmentUpload || !p.loadAttachmentCiphertext) return;
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const row = uploadRow({ ciphertext: new Blob([bytes]) });
    await p.putAttachmentUpload(row);
    // A browser store keeps the Blob; a byte store (SQLite) reads it in.
    const stored = await p.loadAttachmentCiphertext(row.id);
    const back = stored instanceof Blob ? new Uint8Array(await stored.arrayBuffer()) : stored;
    expect(back).toEqual(bytes);
  });

  it("loads queue entries in enqueue order (created_at, then id)", async () => {
    const p = makeDurable().open();
    if (!p.loadAttachmentQueue || !p.putAttachmentUpload) return;
    // Insert deliberately out of order to pin the sort, not the insertion accident.
    await p.putAttachmentUpload(uploadRow({ id: "b", createdAt: 2000 }));
    await p.putAttachmentUpload(uploadRow({ id: "a", createdAt: 2000 }));
    await p.putAttachmentUpload(uploadRow({ id: "z", createdAt: 1000 }));

    expect((await p.loadAttachmentQueue()).map((r) => r.id)).toEqual(["z", "a", "b"]);
  });

  it("clear() wipes ops and meta but leaves the attachment queue alone", async () => {
    const p = makeDurable().open();
    const g = gen();
    await p.append(g.set("task", "t1", "title", "x"), false);
    if (!p.loadAttachmentQueue || !p.putAttachmentUpload || !p.clear) return;
    await p.putAttachmentUpload(uploadRow());
    await p.clear();
    // A recovery re-sync replays the op log; a pending upload is independent device-local state
    // whose loss would strand its ciphertext (and its already-released metadata op).
    expect(await p.loadAttachmentQueue()).toHaveLength(1);
    expect(await p.load()).toHaveLength(0);
  });
});

// Every backend but the in-memory one, whose "reopen" is the same object: two connections to one
// database, as two browser tabs have.
describe.each(BACKENDS.filter((b) => b.name !== "MemoryPersistence"))(
  "Persistence reset epoch: $name",
  ({ makeDurable }) => {
    it("refuses the sync position of a connection that loaded before another one reset it", async () => {
      const d = makeDurable();
      const tabA = d.open();
      const tabB = d.open();
      await tabA.load();
      await tabB.load();
      await tabB.setCursor(5);

      // Tab A's pull hit an expired cursor: it wipes the synced state and starts a snapshot walk.
      await tabA.clearSynced!();
      await tabA.setBootstrap!({ next: "page-2", cursor: 9 });

      // Tab B still holds its old cursor; writing it would skip the walk on the next load.
      await expect(tabB.setCursor(7)).rejects.toBeInstanceOf(DatabaseResetError);
      await expect(tabB.setBootstrap!(null)).rejects.toBeInstanceOf(DatabaseResetError);

      const next = d.open();
      expect(await next.getCursor()).toBe(0);
      expect(await next.getBootstrap!()).toEqual({ next: "page-2", cursor: 9 });
      // The connection that reset, and any opened since, write as usual.
      await tabA.setCursor(9);
      await next.setCursor(10);
      expect(await d.open().getCursor()).toBe(10);
    });
  },
);

describe("IndexedDbPersistence schema upgrade (v1 → v2)", () => {
  it("adds the attachment queue store to an existing v1 database without touching its rows", async () => {
    const factory = new IDBFactory();
    const dbName = "atlas-upgrade";
    // Build a genuine v1 database — the shape every deployed web client has on disk — by hand:
    // ops + meta stores, one op written, connection closed.
    const v1req = factory.open(dbName, 1);
    v1req.onupgradeneeded = () => {
      const db = v1req.result;
      const ops = db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      ops.createIndex("op_id", "op_id", { unique: true });
      db.createObjectStore("meta", { keyPath: "key" });
    };
    const v1 = await new Promise<IDBDatabase>((resolve, reject) => {
      v1req.onsuccess = () => resolve(v1req.result);
      v1req.onerror = () => reject(v1req.error);
    });
    const seed = v1.transaction(["ops", "meta"], "readwrite");
    seed.objectStore("ops").add({ op_id: "op-legacy", synced: false, op: { id: "op-legacy" } });
    seed.objectStore("meta").add({ key: "cursor", value: 7 });
    await new Promise((resolve, reject) => {
      seed.oncomplete = resolve;
      seed.onerror = () => reject(seed.error);
    });
    v1.close();

    // Opening through the persistence (now v2) must run the upgrade: the queue store appears and
    // the pre-existing op log + cursor survive verbatim.
    const p = new IndexedDbPersistence(dbName, factory);
    expect(await p.getCursor()).toBe(7);
    const loaded = await p.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.op).toEqual({ id: "op-legacy" });

    // And the new store is functional, not merely present.
    const row = uploadRow({ id: "up-after-upgrade" });
    if (!p.putAttachmentUpload || !p.loadAttachmentQueue) return;
    await p.putAttachmentUpload(row);
    expect(await p.loadAttachmentQueue()).toEqual([row]);
  });
});

describe("IndexedDbPersistence schema upgrade (v2 → v3)", () => {
  it("moves queued ciphertext into its own store without losing an entry", async () => {
    const factory = new IDBFactory();
    const dbName = "atlas-upgrade-v3";
    const v2req = factory.open(dbName, 2);
    v2req.onupgradeneeded = () => {
      const db = v2req.result;
      const ops = db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
      ops.createIndex("op_id", "op_id", { unique: true });
      db.createObjectStore("meta", { keyPath: "key" });
      db.createObjectStore("attachment_queue", { keyPath: "id" });
    };
    const v2 = await new Promise<IDBDatabase>((resolve, reject) => {
      v2req.onsuccess = () => resolve(v2req.result);
      v2req.onerror = () => reject(v2req.error);
    });
    // A v2 record held its ciphertext inline.
    const row = uploadRow({ id: "up-v2", ciphertext: new Uint8Array([7, 7, 7]) });
    const seed = v2.transaction("attachment_queue", "readwrite");
    seed.objectStore("attachment_queue").add(row);
    await new Promise((resolve, reject) => {
      seed.oncomplete = resolve;
      seed.onerror = () => reject(seed.error);
    });
    v2.close();

    const p = new IndexedDbPersistence(dbName, factory);
    expect(await p.loadAttachmentQueue()).toEqual([row]);
    const [listed] = await p.listAttachmentQueue();
    expect("ciphertext" in listed!).toBe(false);
    expect(await p.loadAttachmentCiphertext("up-v2")).toEqual(row.ciphertext);
  });
});
