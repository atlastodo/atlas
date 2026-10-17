import { IDBFactory } from "fake-indexeddb";
import { waitFor } from "@testing-library/react-native";
import { type Session } from "@atlastodo/client-core";
import {
  dropSession,
  readSession,
  refreshGrace,
  subscribeSession,
  withRefreshLock,
  writeSession,
} from "./session.web";

/**
 * The RN-web session-storage seam. Metro resolves `session.web.ts` for the browser; jest
 * resolves the base `.ts`, so this names the web file directly. A Map-backed `localStorage` stub
 * makes the test independent of the jest environment (node has no `localStorage`).
 */
const SESSION: Session = {
  accessToken: "acc",
  refreshToken: "ref",
  deviceId: "dev-1",
  user: { id: "u1", email: "a@b.co", display_name: "A" },
};

function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

describe("web session storage", () => {
  const real = (globalThis as { localStorage?: Storage }).localStorage;
  afterEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = real;
  });

  it("round-trips a session across a reload and clears it on sign-out", async () => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeLocalStorage();
    expect(await readSession()).toBeNull();
    await writeSession(SESSION);
    // A later read (== a page reload) sees the persisted session.
    expect(await readSession()).toEqual(SESSION);
    await dropSession();
    expect(await readSession()).toBeNull();
  });

  it("returns null on corrupt stored data rather than throwing", async () => {
    const ls = fakeLocalStorage();
    ls.setItem("atlas.session", "{not json");
    (globalThis as { localStorage?: Storage }).localStorage = ls;
    expect(await readSession()).toBeNull();
  });

  it("degrades quietly when localStorage is unavailable", async () => {
    (globalThis as { localStorage?: Storage }).localStorage = undefined;
    await expect(writeSession(SESSION)).resolves.toBeUndefined();
    expect(await readSession()).toBeNull();
    await expect(dropSession()).resolves.toBeUndefined();
  });
});

describe("web session sharing across tabs", () => {
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  function setLocks(locks: unknown) {
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
  }
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });

  /** A `storage` event as the browser delivers it to the *other* tabs of the origin. */
  function storageEvent(key: string | null, newValue: string | null): Event {
    return Object.assign(new Event("storage"), { key, newValue });
  }

  it("rotates under the origin-wide lock when the browser has one", async () => {
    const request = jest.fn((_name: string, fn: () => Promise<string>) => fn());
    setLocks({ request });
    await expect(withRefreshLock!(async () => "rotated")).resolves.toBe("rotated");
    expect(request).toHaveBeenCalledWith("atlas.session.refresh", expect.any(Function));
  });

  it("still rotates on a plain-http origin, where navigator.locks does not exist", async () => {
    setLocks(undefined);
    await expect(withRefreshLock!(async () => "rotated")).resolves.toBe("rotated");
  });

  it("asks the server for its reuse grace only where tabs cannot lock", () => {
    setLocks({ request: jest.fn() });
    expect(refreshGrace()).toBe(false);
    setLocks(undefined);
    expect(refreshGrace()).toBe(true);
  });

  it("reports another tab's writes and removals of the session, and nothing else", async () => {
    const target = new EventTarget();
    const seen: (Session | null)[] = [];
    const unsubscribe = subscribeSession((s) => seen.push(s), target);

    target.dispatchEvent(storageEvent("atlas.session", JSON.stringify(SESSION)));
    target.dispatchEvent(storageEvent("atlas.serverUrl", "https://elsewhere"));
    target.dispatchEvent(storageEvent("atlas.session", null)); // signed out in the other tab
    await waitFor(() => expect(seen).toEqual([SESSION, null]));

    unsubscribe();
    target.dispatchEvent(storageEvent("atlas.session", JSON.stringify(SESSION)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(2);
  });
});

describe("web session keys at rest", () => {
  const DEK = "d1".repeat(32);
  const PRIVATE_KEY = "e2".repeat(32);
  const UNLOCKED: Session = {
    ...SESSION,
    publicKey: "ab".repeat(32),
    dek: DEK,
    privateKey: PRIVATE_KEY,
  };

  const g = globalThis as { localStorage?: Storage; indexedDB?: IDBFactory };
  const realLocalStorage = g.localStorage;
  const realIdb = g.indexedDB;
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const realClone = globalThis.structuredClone;
  let ls: Storage;
  beforeEach(() => {
    ls = fakeLocalStorage();
    g.localStorage = ls;
    g.indexedDB = new IDBFactory();
    // Browsers (and plain Node) structured-clone a CryptoKey into IndexedDB; jest's sandbox
    // realm turns it into a plain object, so the fake store keeps it by reference instead.
    globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) =>
      value instanceof CryptoKey ? value : realClone(value, options)) as typeof structuredClone;
  });
  afterEach(() => {
    g.localStorage = realLocalStorage;
    g.indexedDB = realIdb;
    globalThis.structuredClone = realClone;
    if (realCrypto) Object.defineProperty(globalThis, "crypto", realCrypto);
  });

  /** A page without WebCrypto's `subtle` (a plain-http origin): `getRandomValues` only. */
  function withoutSubtle() {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues }, configurable: true });
  }

  const raw = () => ls.getItem("atlas.session") ?? "";

  it("stores the keys only wrapped, and unwraps them on load", async () => {
    await writeSession(UNLOCKED);

    expect(raw()).not.toContain(DEK);
    expect(raw()).not.toContain(PRIVATE_KEY);
    expect(JSON.parse(raw())).not.toHaveProperty("dek");
    expect(JSON.parse(raw())).not.toHaveProperty("privateKey");
    expect(await readSession()).toEqual(UNLOCKED);
  });

  it("lets another tab of the origin unwrap them with the shared key", async () => {
    await writeSession(UNLOCKED);

    // A second copy of the module, as another tab has: nothing shared but the browser stores.
    let otherTab!: typeof import("./session.web");
    jest.isolateModules(() => {
      otherTab = jest.requireActual<typeof import("./session.web")>("./session.web");
    });
    expect(await otherTab.readSession()).toEqual(UNLOCKED);

    const seen: (Session | null)[] = [];
    const target = new EventTarget();
    otherTab.subscribeSession((s) => seen.push(s), target);
    target.dispatchEvent(
      Object.assign(new Event("storage"), { key: "atlas.session", newValue: raw() }),
    );
    await waitFor(() => expect(seen).toEqual([UNLOCKED]));
  });

  it("wraps the raw keys of a session stored before wrapping existed", async () => {
    ls.setItem("atlas.session", JSON.stringify(UNLOCKED));

    expect(await readSession()).toEqual(UNLOCKED);

    await waitFor(() => expect(raw()).not.toContain(DEK));
    expect(raw()).not.toContain(PRIVATE_KEY);
    expect(await readSession()).toEqual(UNLOCKED);
  });

  it("reads a session whose wrapping key is gone as locked, keeping its tokens", async () => {
    await writeSession(UNLOCKED);
    g.indexedDB = new IDBFactory(); // site data cleared: a fresh key store

    const { dek: _d, privateKey: _p, ...locked } = UNLOCKED;
    expect(await readSession()).toEqual(locked);
  });

  it("keeps the keys in memory only without WebCrypto, so a reload asks to unlock", async () => {
    withoutSubtle();
    await writeSession(UNLOCKED);

    expect(raw()).not.toContain(DEK);
    expect(raw()).not.toContain(PRIVATE_KEY);
    const reloaded = await readSession();
    expect(reloaded?.refreshToken).toBe(UNLOCKED.refreshToken);
    expect(reloaded?.dek).toBeUndefined();
  });

  it("keeps the keys in memory only without IndexedDB", async () => {
    g.indexedDB = undefined;
    await writeSession(UNLOCKED);

    expect(raw()).not.toContain(DEK);
    expect((await readSession())?.dek).toBeUndefined();
  });

  it("strips raw stored keys it cannot wrap, keeping them for this load only", async () => {
    withoutSubtle();
    ls.setItem("atlas.session", JSON.stringify(UNLOCKED));

    expect(await readSession()).toEqual(UNLOCKED);
    await waitFor(() => expect(raw()).not.toContain(DEK));
    expect(JSON.parse(raw()).refreshToken).toBe(UNLOCKED.refreshToken);
  });

  it("keeps writes in order however long each wrap takes", async () => {
    const later: Session = { ...UNLOCKED, refreshToken: "ref-2" };
    const { dek: _d, privateKey: _p, ...lockedLater } = { ...later, refreshToken: "ref-3" };
    await Promise.all([writeSession(UNLOCKED), writeSession(later), writeSession(lockedLater)]);
    expect((await readSession())?.refreshToken).toBe("ref-3");
    await Promise.all([writeSession(UNLOCKED), dropSession()]);
    expect(await readSession()).toBeNull();
  });

  describe("in the desktop app", () => {
    const desktop = globalThis as { atlasDesktop?: unknown };
    afterEach(() => {
      delete desktop.atlasDesktop;
    });

    /**
     * The preload's `atlasDesktop.safeStorage`, with a toy cipher: a marker byte, then the bytes
     * XOR-ed. `usable: false` is a machine without an OS key store (Linux without a keyring).
     */
    function installOsKeyStore(usable = true) {
      const xor = (bytes: Uint8Array) => Uint8Array.from(bytes, (b) => b ^ 0x5a);
      const bridge = {
        encrypt: jest.fn(async (plain: Uint8Array) =>
          usable ? Uint8Array.of(0xee, ...xor(plain)) : null,
        ),
        decrypt: jest.fn(async (sealed: Uint8Array) =>
          usable && sealed[0] === 0xee ? xor(sealed.slice(1)) : null,
        ),
      };
      desktop.atlasDesktop = { isElectron: true, safeStorage: bridge };
      return bridge;
    }

    const sealedVersion = () => JSON.parse(raw()).sealedKeys?.v;

    it("seals the whole key set with the OS key store, not the browser's key", async () => {
      const bridge = installOsKeyStore();
      g.indexedDB = undefined; // the browser wrap would have nowhere to keep its key

      await writeSession(UNLOCKED);

      expect(sealedVersion()).toBe(2);
      expect(bridge.encrypt).toHaveBeenCalledTimes(1);
      const plain = new TextDecoder().decode(bridge.encrypt.mock.calls[0]![0]);
      expect(JSON.parse(plain)).toEqual({
        user: UNLOCKED.user.id,
        keys: { dek: DEK, privateKey: PRIVATE_KEY },
      });
      expect(raw()).not.toContain(DEK);
      expect(raw()).not.toContain(PRIVATE_KEY);
      expect(await readSession()).toEqual(UNLOCKED);
    });

    it("falls back to the browser's wrap where the OS key store is unusable", async () => {
      installOsKeyStore(false);
      await writeSession(UNLOCKED);

      expect(sealedVersion()).toBe(1);
      expect(raw()).not.toContain(DEK);
      expect(await readSession()).toEqual(UNLOCKED);
    });

    it("seals a session the browser's wrap sealed again with the OS key store on load", async () => {
      await writeSession(UNLOCKED); // before the desktop app could use its OS key store
      expect(sealedVersion()).toBe(1);

      installOsKeyStore();
      expect(await readSession()).toEqual(UNLOCKED);
      await waitFor(() => expect(sealedVersion()).toBe(2));
      expect(raw()).not.toContain(DEK);
      expect(await readSession()).toEqual(UNLOCKED);
    });

    it("leaves a browser-wrapped session alone while the OS key store is unusable", async () => {
      await writeSession(UNLOCKED);
      const before = raw();

      installOsKeyStore(false);
      expect(await readSession()).toEqual(UNLOCKED);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(raw()).toBe(before);
    });

    it("reads a session the OS key store no longer opens as locked, keeping its tokens", async () => {
      installOsKeyStore();
      await writeSession(UNLOCKED);

      installOsKeyStore(false); // the keyring is gone, say
      const { dek: _d, privateKey: _p, ...locked } = UNLOCKED;
      expect(await readSession()).toEqual(locked);
    });

    it("does not open keys sealed for another account", async () => {
      installOsKeyStore();
      await writeSession(UNLOCKED);

      const stored = JSON.parse(raw());
      ls.setItem(
        "atlas.session",
        JSON.stringify({ ...stored, user: { ...stored.user, id: "u2" } }),
      );
      expect((await readSession())?.dek).toBeUndefined();
    });
  });
});
