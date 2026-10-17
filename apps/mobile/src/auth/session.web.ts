import { type Session, type TokenStore, sessionFromAuth } from "@atlastodo/client-core";
import {
  isPreferredSeal,
  openSessionKeys,
  sealSessionKeys,
  type SealedKeys,
  type SessionKeys,
} from "./webKeyStore";

/**
 * Web session persistence in localStorage; expo-secure-store has no browser backend. Metro resolves
 * this file in place of `session.ts` on web (the Electron app runs it too). The signatures match
 * the native module so `AuthContext` is identical on every client.
 *
 * Tokens in localStorage are readable by any script on the origin (an accepted tradeoff: an
 * httpOnly refresh cookie would need credentialed CORS and be third-party). Refresh-token reuse
 * detection, a CSP, rate limiting and the 15-minute access TTL contain the risk.
 *
 * The unwrapped E2EE keys are stored only wrapped under a non-extractable key (`webKeyStore.ts`),
 * or not at all (the session then asks for the password after a reload). That is not protection at
 * rest. A session stored before wrapping existed is wrapped on its first read.
 */

const KEY = "atlas.session";
const REFRESH_LOCK = "atlas.session.refresh";

export { type Session, sessionFromAuth };

/** The session as stored: the unwrapped keys replaced by `sealedKeys` (or absent). */
type StoredSession = Omit<Session, "dek" | "privateKey" | "signingKey"> & {
  sealedKeys?: SealedKeys;
  /** Raw keys, only in a session stored before wrapping existed. */
  dek?: string;
  privateKey?: string;
};

function parseStored(raw: string | null | undefined): StoredSession | null {
  try {
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function readRaw(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

/** The stored form of `session`: its keys wrapped, or dropped where nothing can wrap them. */
async function toStored(session: Session): Promise<StoredSession> {
  const { dek, privateKey, signingKey, ...rest } = session;
  if (!dek) return rest;
  const keys: SessionKeys = { dek };
  if (privateKey) keys.privateKey = privateKey;
  if (signingKey) keys.signingKey = signingKey;
  const sealed = await sealSessionKeys(keys, session.user.id);
  return sealed ? { ...rest, sealedKeys: sealed } : rest;
}

/** The session a stored form holds: wrapped keys opened, or left out (locked) when they cannot be. */
async function fromStored(stored: StoredSession): Promise<Session> {
  const { sealedKeys, ...rest } = stored;
  if (!sealedKeys) return rest;
  const keys = await openSessionKeys(sealedKeys, stored.user.id);
  return keys ? { ...rest, ...keys } : rest;
}

/**
 * Storage writes, in call order: each waits for the wrap before it lands, so without the queue a
 * later write could be overtaken by an earlier one that took longer to wrap.
 */
let writes: Promise<unknown> = Promise.resolve();
function enqueue(write: () => Promise<void>): Promise<void> {
  const next = writes.then(write);
  writes = next.catch(() => {});
  return next;
}

export async function readSession(): Promise<Session | null> {
  const raw = readRaw();
  const stored = parseStored(raw);
  if (!stored) return null;
  if (stored.dek) {
    // Raw keys from before wrapping: this load keeps them; storage gets the wrapped form (or none),
    // unless something else was written meanwhile.
    const session = stored as Session;
    void enqueue(async () => {
      const rewritten = JSON.stringify(await toStored(session));
      if (readRaw() === raw) globalThis.localStorage?.setItem(KEY, rewritten);
    }).catch(() => {});
    return session;
  }
  try {
    const session = await fromStored(stored);
    const sealed = stored.sealedKeys;
    if (session.dek && sealed && !isPreferredSeal(sealed)) {
      // Browser-wrapped in the desktop app: seal with the OS key store now, unless it is unusable
      // or something else was written meanwhile.
      void enqueue(async () => {
        const next = await toStored(session);
        if (next.sealedKeys?.v === 2 && readRaw() === raw) {
          globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
        }
      }).catch(() => {});
    }
    return session;
  } catch {
    return null;
  }
}

export function writeSession(session: Session): Promise<void> {
  return enqueue(async () => {
    const stored = JSON.stringify(await toStored(session));
    globalThis.localStorage?.setItem(KEY, stored);
  });
}

export function dropSession(): Promise<void> {
  return enqueue(async () => {
    globalThis.localStorage?.removeItem(KEY);
  });
}

/**
 * Tabs share this session but each holds its own single-use refresh token, so a rotation runs under
 * an origin-wide lock (see `TokenStore`): one tab rotates, the others adopt the stored pair. Web
 * Locks exist only in secure contexts; on plain http the server's `refresh_superseded` answer and
 * the client's re-read of storage cover the race.
 */
export const withRefreshLock: TokenStore["withRefreshLock"] = <T>(fn: () => Promise<T>) => {
  const locks = webLocks();
  // The DOM typing wraps the callback's promise once more; at runtime `request` resolves to T.
  return locks ? (locks.request(REFRESH_LOCK, () => fn()) as Promise<T>) : fn();
};

/**
 * Without `navigator.locks` tabs rotate unserialized, so the refresh asks the server for its
 * short reuse grace; with the lock a reuse is always a theft signal.
 */
export function refreshGrace(): boolean {
  return webLocks() === null;
}

function webLocks(): LockManager | null {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  return typeof locks?.request === "function" ? locks : null;
}

/**
 * Follow the session other tabs write: `onChange` gets the stored session after another tab
 * rotated, signed in or unlocked, and `null` after it signed out (or cleared storage). The
 * browser never delivers a tab's own writes to itself. Unwrapping is async, so changes are
 * delivered one after another in the order they happened. Returns the unsubscribe.
 */
export function subscribeSession(
  onChange: (session: Session | null) => void,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined = globalThis,
): () => void {
  if (typeof target?.addEventListener !== "function") return () => {};
  let active = true;
  let deliveries: Promise<void> = Promise.resolve();
  const handler = (event: Event) => {
    const { key, newValue } = event as StorageEvent;
    if (key !== null && key !== KEY) return;
    // `key === null` is a `localStorage.clear()`: read what is left rather than trust the event.
    const stored = parseStored(key === null ? readRaw() : newValue);
    deliveries = deliveries.then(async () => {
      const session = stored ? await fromStored(stored).catch(() => null) : null;
      if (active) onChange(session);
    });
  };
  target.addEventListener("storage", handler);
  return () => {
    active = false;
    target.removeEventListener("storage", handler);
  };
}
