import { describe, expect, it } from "vitest";
import { MemoryPersistence } from "./persistence";
import {
  LOCAL_STORE_KEY_ID,
  SealedStoreError,
  deriveLocalStoreKey,
  sealPersistence,
} from "./sealedPersistence";
import { LocalStore } from "./store";
import type { Repair } from "./scope";
import type { Operation } from "./types";

const KEY = new Uint8Array(32).fill(1);
const OTHER = new Uint8Array(32).fill(2);
const NODE = "00000000-0000-0000-0000-0000000000d1";
const ITEM = "0192f000-0000-7000-8000-0000000000aa";

let seq = 0;
const store = (persistence: ReturnType<typeof sealPersistence>) =>
  new LocalStore(NODE, { persistence, newId: () => `op-${seq++}` });

describe("sealPersistence", () => {
  it("stores values sealed and loads them back", async () => {
    const inner = new MemoryPersistence();
    const a = store(sealPersistence(inner, KEY));
    a.set("vault.item", ITEM, "name", "Deploy key");
    a.set("vault.item", ITEM, "fields", [{ name: "token", kind: "hidden", value: "sk_live_1" }]);
    a.remove("vault.folder", "0192f000-0000-7000-8000-00000000f001");
    await a.flush();

    const raw = await inner.load();
    expect(raw).toHaveLength(3);
    const text = JSON.stringify(raw);
    expect(text).not.toContain("Deploy key");
    expect(text).not.toContain("sk_live_1");
    for (const p of raw.filter((p) => p.op.op === "set")) {
      expect(p.op).toMatchObject({ value: { __enc: 2, kid: LOCAL_STORE_KEY_ID } });
    }

    const b = store(sealPersistence(inner, KEY));
    await b.hydrate();
    expect(b.get("vault.item", ITEM)).toEqual({
      name: "Deploy key",
      fields: [{ name: "token", kind: "hidden", value: "sk_live_1" }],
    });
    expect(b.unsyncedOps()).toHaveLength(3);
  });

  it("refuses to load under another key, or a store written without it", async () => {
    const inner = new MemoryPersistence();
    const a = store(sealPersistence(inner, KEY));
    a.set("vault.item", ITEM, "name", "x");
    await a.flush();
    await expect(sealPersistence(inner, OTHER).load()).rejects.toThrow(SealedStoreError);

    const plain = new MemoryPersistence();
    const p = store(plain);
    p.set("vault.item", ITEM, "name", "plaintext");
    await p.flush();
    await expect(sealPersistence(plain, KEY).load()).rejects.toThrow("is not sealed");
  });

  it("binds a sealed value to its field: moved elsewhere it does not open", async () => {
    const inner = new MemoryPersistence();
    const sealed = sealPersistence(inner, KEY);
    const a = store(sealed);
    a.set("vault.item", ITEM, "name", "x");
    await a.flush();
    const [stored] = await inner.load();
    const moved = { ...stored!.op, id: "moved", field: "notes" };
    const other = new MemoryPersistence();
    await other.append(moved as Operation, false);
    await expect(sealPersistence(other, KEY).load()).rejects.toThrow("does not open");
  });

  it("seals bootstrap repairs too", async () => {
    const inner = new MemoryPersistence();
    const sealed = sealPersistence(inner, KEY);
    const repair: Repair = {
      entity: "vault.item",
      entityId: ITEM,
      field: "notes",
      ts: { wallMs: 1, counter: 0, node: NODE },
      value: "a secret note",
      reason: "key",
    };
    await sealed.setBootstrap!({ next: "p2", cursor: 9 }, { page: "p1", repairs: [repair] });
    expect(JSON.stringify(await inner.getBootstrap!())).not.toContain("a secret note");
    expect(await sealed.getBootstrap!()).toMatchObject({
      next: "p2",
      cursor: 9,
      repairs: [{ value: "a secret note", field: "notes" }],
    });
  });

  it("offers exactly the inner backend's optional methods", () => {
    const bare = {
      load: async () => [],
      append: async () => {},
      markSynced: async () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
    };
    const wrapped = sealPersistence(bare, KEY);
    expect(wrapped.restamp).toBeUndefined();
    expect(wrapped.appendBatch).toBeUndefined();
    expect(wrapped.clear).toBeUndefined();
    const full = sealPersistence(new MemoryPersistence(), KEY);
    expect(typeof full.restamp).toBe("function");
    expect(typeof full.commitSyncBatch).toBe("function");
  });

  it("derives a per-user key apart from the app key", () => {
    const appKey = new Uint8Array(32).fill(3);
    const k1 = deriveLocalStoreKey(appKey, "user-1");
    expect(k1).toHaveLength(32);
    expect(k1).not.toEqual(appKey);
    expect(deriveLocalStoreKey(appKey, "user-1")).toEqual(k1);
    expect(deriveLocalStoreKey(appKey, "user-2")).not.toEqual(k1);
    expect(() => deriveLocalStoreKey(new Uint8Array(16), "u")).toThrow("32 bytes");
  });
});
