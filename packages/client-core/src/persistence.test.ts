import { describe, it, expect } from "bun:test";
import { LocalStore, PersistError } from "./store";
import { SqlitePersistence, type Persistence, type SqlDatabase } from "./persistence";
import { FakeSqlDatabase } from "./persistence.testutil";

const NODE_A = "00000000-0000-0000-0000-0000000000a1";

let idSeq = 0;
/** A bare store used only to mint ops with globally-unique ids (stands in for UUIDs). */
function mint(node = NODE_A) {
  return new LocalStore(node, { newId: () => `op-${idSeq++}` });
}

/** A persistence-backed store; `tag` namespaces newly-minted op ids so reloads don't collide. */
function sqliteStore(tag: string, db: SqlDatabase, startMs = 1000) {
  let t = startMs;
  let n = 0;
  return new LocalStore(NODE_A, {
    now: () => t++,
    newId: () => `${tag}-${n++}`,
    persistence: new SqlitePersistence(db),
  });
}

/** A {@link FakeSqlDatabase} that records every statement it runs, in order. */
class LoggingSqlDatabase extends FakeSqlDatabase {
  readonly log: string[] = [];
  override async execute(query: string, params: unknown[] = []) {
    this.log.push(query.trim().split(/\s+/).slice(0, 3).join(" ").toUpperCase());
    return super.execute(query, params);
  }
}

describe("SqlitePersistence", () => {
  it("never lets another write land inside a batch's transaction on the shared connection", async () => {
    const db = new LoggingSqlDatabase();
    const p = new SqlitePersistence(db);
    await p.getCursor(); // tables exist
    const g = mint();
    const batch = [g.set("task", "t1", "title", "a"), g.set("task", "t2", "title", "b")];

    // The sync cursor and a batch of pulled ops written at the same time, as the app does: the
    // cursor write must not become part of the batch's transaction (a rollback would take it too).
    await Promise.all([p.appendBatch(batch, true), p.setCursor(7)]);

    const begin = db.log.indexOf("BEGIN TRANSACTION");
    const commit = db.log.indexOf("COMMIT");
    expect(db.log.slice(begin, commit).some((q) => q.startsWith("INSERT INTO META"))).toBe(false);
    expect(await p.getCursor()).toBe(7);
  });
});

describe("LocalStore durability (op-log write-through)", () => {
  it("advances the clock past replayed ops so a new local write wins", async () => {
    const db = new FakeSqlDatabase();
    const store = sqliteStore("orig", db, 10_000);
    store.set("task", "t1", "title", "old");
    await store.flush();

    // Reload with a clock that starts *earlier* in wall time than the persisted op.
    const reloaded = sqliteStore("re", db, 1000);
    await reloaded.hydrate();
    reloaded.set("task", "t1", "title", "new");
    expect(reloaded.get("task", "t1")).toEqual({ title: "new" });
  });

  it("hydrate is a no-op with no persistence configured", async () => {
    const store = new LocalStore(NODE_A);
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(store.list("task")).toHaveLength(0);
  });

  it("surfaces background persistence write failures via onPersistError", async () => {
    const failing: Persistence = {
      load: async () => [],
      append: async () => {
        throw new Error("disk full");
      },
      markSynced: async () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
    };
    const errors: unknown[] = [];
    const store = new LocalStore(NODE_A, {
      persistence: failing,
      onPersistError: (e) => errors.push(e),
    });
    store.set("task", "t1", "title", "x"); // read model still updates synchronously
    expect(store.get("task", "t1")).toEqual({ title: "x" });
    // The flush writes it again, and says so when that fails too: a caller must not move its
    // sync cursor past an op that is not on disk.
    await expect(store.flush()).rejects.toBeInstanceOf(PersistError);
    expect(store.unsavedCount()).toBe(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as Error).message).toBe("disk full");
  });
});
