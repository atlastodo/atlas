import { base64ToBytes, bytesToBase64 } from "@atlastodo/client-core";

/**
 * Storage for the unwrapped keys a web session keeps across reloads (imported only by
 * `session.web.ts`; native uses the OS keychain).
 *
 * The desktop app seals the key set with the OS key store (`atlasDesktop.safeStorage`) and falls
 * back to the browser wrap where that answers null. In the browser the keys are AES-GCM-wrapped
 * under a non-extractable WebCrypto key in IndexedDB; that keeps the plain text out of localStorage
 * but is not protection at rest, since the profile holds the wrapping key too.
 *
 * Without WebCrypto or IndexedDB `seal` answers null and the caller keeps the keys in memory only.
 */

/**
 * Wrapped key material as stored. Version 1 is AES-GCM under the browser's wrapping key over the
 * {@link SessionKeys} JSON, bound to the user id as associated data. Version 2 is the desktop app's
 * OS key store over `{user, keys}`.
 */
export type SealedKeys = { v: 1; iv: string; ct: string } | { v: 2; ct: string };

export interface SessionKeys {
  dek: string;
  privateKey?: string;
  signingKey?: string;
}

/** A small store of its own, apart from the synced data's database, so either can be reset alone. */
const DB_NAME = "atlas-keystore";
const STORE = "keys";
const WRAP_KEY_ID = "session-wrap-v1";

interface Env {
  subtle: SubtleCrypto;
  idb: IDBFactory;
}

function currentEnv(): Env | null {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (typeof subtle?.encrypt !== "function" || !idb) return null;
  return { subtle, idb };
}

/** The wrapping key per environment, loaded once (tests swap the globals between cases). */
let cached: { env: Env; key: Promise<CryptoKey | null> } | null = null;

function wrappingKey(): { env: Env; key: Promise<CryptoKey | null> } | null {
  const env = currentEnv();
  if (!env) return null;
  if (!cached || cached.env.subtle !== env.subtle || cached.env.idb !== env.idb) {
    cached = {
      env,
      key: loadOrCreateKey(env).catch((err: unknown) => {
        console.warn("[atlas] no key store; session keys stay in memory:", err);
        return null;
      }),
    };
  }
  return cached;
}

function openKeyStore(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("the key store is blocked"));
  });
}

/**
 * The origin's wrapping key, created on first use. The get-or-put runs in one readwrite
 * transaction, which IndexedDB serializes across tabs, so two tabs starting at once still end up
 * with the same key. The candidate is generated beforehand: awaiting anything but an IndexedDB
 * request inside the transaction would let it commit early.
 */
async function loadOrCreateKey({ subtle, idb }: Env): Promise<CryptoKey> {
  const db = await openKeyStore(idb);
  try {
    const candidate = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    return await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let key = candidate;
      const existing = store.get(WRAP_KEY_ID);
      existing.onsuccess = () => {
        if (existing.result) key = existing.result as CryptoKey;
        else store.put(candidate, WRAP_KEY_ID);
      };
      tx.oncomplete = () => resolve(key);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("the key store transaction aborted"));
    });
  } finally {
    db.close();
  }
}

/** The desktop app's OS key store bridge (apps/electron's preload), or null in a browser. */
interface DesktopKeyStore {
  encrypt(plain: Uint8Array): Promise<Uint8Array | null>;
  decrypt(sealed: Uint8Array): Promise<Uint8Array | null>;
}

function desktopKeyStore(): DesktopKeyStore | null {
  const bridge = (globalThis as { atlasDesktop?: { safeStorage?: Partial<DesktopKeyStore> } })
    .atlasDesktop?.safeStorage;
  if (typeof bridge?.encrypt !== "function" || typeof bridge.decrypt !== "function") return null;
  return bridge as DesktopKeyStore;
}

/** The bridge's answer as bytes, or null for a refusal, a failure or anything else. */
async function viaBridge(call: () => Promise<Uint8Array | null>): Promise<Uint8Array | null> {
  try {
    const out = await call();
    return ArrayBuffer.isView(out)
      ? new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      : null;
  } catch {
    return null;
  }
}

/**
 * Whether keys sealed as `sealed` are in the best form this page can store: false for a browser
 * wrap in the desktop app, which the OS key store may be able to seal instead.
 */
export function isPreferredSeal(sealed: SealedKeys): boolean {
  return sealed.v === 2 || desktopKeyStore() === null;
}

const encoder = new TextEncoder();

/**
 * Wrap `keys` for `userId`: with the OS key store in the desktop app, otherwise (or where it cannot
 * be used) under the browser's wrapping key. Null when neither is available (keep them in memory).
 */
export async function sealSessionKeys(
  keys: SessionKeys,
  userId: string,
): Promise<SealedKeys | null> {
  const desktop = desktopKeyStore();
  if (desktop) {
    const plain = encoder.encode(JSON.stringify({ user: userId, keys }));
    const ct = await viaBridge(() => desktop.encrypt(plain));
    if (ct) return { v: 2, ct: bytesToBase64(ct) };
  }
  const wrapping = wrappingKey();
  const key = await wrapping?.key;
  if (!wrapping || !key) return null;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(JSON.stringify(keys));
  const ct = await wrapping.env.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(userId) },
    key,
    plain,
  );
  return { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

/**
 * Unwrap keys sealed for `userId`, or null when they cannot be opened here (no key store, a key
 * store reset since, or another account's blob): the session then reads as locked.
 */
export async function openSessionKeys(
  sealed: SealedKeys,
  userId: string,
): Promise<SessionKeys | null> {
  if (sealed.v === 2) return openWithOsKeyStore(sealed.ct, userId);
  const wrapping = wrappingKey();
  const key = await wrapping?.key;
  if (!wrapping || !key || sealed.v !== 1) return null;
  try {
    const plain = await wrapping.env.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(sealed.iv) as BufferSource,
        additionalData: encoder.encode(userId),
      },
      key,
      base64ToBytes(sealed.ct) as BufferSource,
    );
    return sessionKeysFrom(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    return null;
  }
}

async function openWithOsKeyStore(ct: string, userId: string): Promise<SessionKeys | null> {
  const desktop = desktopKeyStore();
  if (!desktop) return null;
  try {
    const plain = await viaBridge(() => desktop.decrypt(base64ToBytes(ct)));
    if (!plain) return null;
    const opened = JSON.parse(new TextDecoder().decode(plain)) as {
      user?: unknown;
      keys?: unknown;
    };
    return opened.user === userId ? sessionKeysFrom(opened.keys) : null;
  } catch {
    return null;
  }
}

/** The key set in an unwrapped value, or null when it is not one. */
function sessionKeysFrom(value: unknown): SessionKeys | null {
  const keys = (value ?? {}) as Partial<SessionKeys>;
  if (typeof keys.dek !== "string") return null;
  const opened: SessionKeys = { dek: keys.dek };
  if (typeof keys.privateKey === "string") opened.privateKey = keys.privateKey;
  if (typeof keys.signingKey === "string") opened.signingKey = keys.signingKey;
  return opened;
}
