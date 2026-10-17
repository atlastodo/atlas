import { IDBFactory } from "fake-indexeddb";
import { LocalStore } from "@atlastodo/client-core";
import { createPersistence, deleteDatabase } from "./persistence.web";

/**
 * The RN-web durable-persistence seam. Metro resolves `persistence.web.ts` for the browser;
 * jest resolves the base `.ts`, so this names the web file directly to test the browser variant.
 *
 * The durable backend itself ({@link IndexedDbPersistence}) is proven by `@atlastodo/client-core`'s
 * backend-agnostic conformance battery; this covers the *seam*: it selects IndexedDB when the browser
 * provides it (durable across a reload) and degrades to an in-memory store when it does not.
 */
const NODE = "00000000-0000-0000-0000-0000000000c1";
const USER_A = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_B = "bbbbbbbb-0000-0000-0000-000000000002";

describe("web persistence seam", () => {
  const realIdb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  afterEach(() => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = realIdb;
  });

  it("persists the op log across a reload when IndexedDB is present", async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();

    const first = await createPersistence(USER_A);
    const store = new LocalStore(NODE, { newId: () => "op-1" });
    const op = store.set("task", "t1", "title", "Buy milk");
    await first.append(op, false);

    // A fresh backend over the same IndexedDB global is the analogue of relaunching the browser tab.
    const reopened = await createPersistence(USER_A);
    expect(await reopened.load()).toEqual([{ op, synced: false }]);
  });

  it("scopes the op log per user, so a second account never inherits the first's outbox", async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();

    const a = await createPersistence(USER_A);
    const store = new LocalStore(NODE, { newId: () => "op-1" });
    await a.append(store.set("task", "t1", "title", "A's secret"), false);

    // Same browser, different signed-in user: a fresh store must start empty, not replay A's ops.
    const b = await createPersistence(USER_B);
    expect(await b.load()).toEqual([]);
  });

  it("deletes a user's database, closing this tab's connection so it is not written back", async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    const running = await createPersistence(USER_A);
    const store = new LocalStore(NODE, { newId: () => `op-${Math.random()}` });
    await running.append(store.set("task", "t1", "title", "A's secret"), false);

    await deleteDatabase(USER_A);

    // A store still holding the old connection cannot recreate the database.
    await expect(running.append(store.set("task", "t2", "title", "late"), false)).rejects.toThrow();
    const reopened = await createPersistence(USER_A);
    expect(await reopened.load()).toEqual([]);
  });

  it("asks for persistent storage silently only in the desktop app", async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();
    const nav = globalThis.navigator as { storage?: unknown };
    const win = globalThis as unknown as { atlasDesktop?: { isElectron?: boolean } };
    const saved = nav.storage;
    const persist = jest.fn(async () => true);
    nav.storage = { persisted: async () => false, persist };
    try {
      // A browser may prompt, so there the explainer asks (PersistentStorageExplainer), not this.
      await createPersistence(USER_A);
      await new Promise((r) => setTimeout(r, 0));
      expect(persist).not.toHaveBeenCalled();

      // Electron grants it without a prompt.
      win.atlasDesktop = { isElectron: true };
      await createPersistence(USER_B);
      await new Promise((r) => setTimeout(r, 0));
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      nav.storage = saved;
      delete win.atlasDesktop;
    }
  });

  it("falls back to an in-memory backend when IndexedDB is absent", async () => {
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;

    const p = await createPersistence(USER_A);
    const store = new LocalStore(NODE, { newId: () => "op-1" });
    const op = store.set("task", "t1", "title", "x");
    await p.append(op, false);
    expect(await p.load()).toEqual([{ op, synced: false }]);

    // A separate memory backend shares no durable medium, so it starts empty -- confirming the
    // fallback is genuinely non-durable rather than accidentally IndexedDB-backed.
    const fresh = await createPersistence(USER_A);
    expect(await fresh.load()).toEqual([]);
  });
});
