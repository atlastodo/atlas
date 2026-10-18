/**
 * Per-account cache of the KDF salt and the KDF the account last derived with, in AsyncStorage.
 *
 * Both are public data — the server hands them to anyone who asks (it must, for zero-knowledge
 * login) — so caching them leaks nothing and only saves a round trip: on a repeat login the
 * (comparatively expensive) key derivation can start while the fresh `/auth/salt` response is still
 * in flight. The fresh response still verifies the cached values on every login, so a rotated salt
 * or a newer KDF costs one extra derivation, never a wrong-password failure.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { kdfFromWire, kdfToWire, type PasswordKdf } from "@atlastodo/client-core";

const KEY = "atlas.saltCache.v1";

/** The salt and KDF last seen for an account, keyed by normalized email. */
export interface CachedSalt {
  salt: string;
  /** Absent in an entry cached before per-account KDFs, when every account derived with version 1. */
  kdf?: PasswordKdf;
}

/** The stored form: the KDF as the server names it on the wire. */
interface StoredEntry {
  salt: string;
  kdf_version?: number;
  kdf_params?: Record<string, number>;
}

export async function readCachedSalt(email: string): Promise<CachedSalt | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const entry = (JSON.parse(raw) as Record<string, StoredEntry>)[email];
    if (typeof entry?.salt !== "string") return null;
    const kdf = kdfFromWire(entry.kdf_version, entry.kdf_params);
    return kdf ? { salt: entry.salt, kdf } : { salt: entry.salt };
  } catch {
    // A corrupt cache must never block login: the fresh salt fetch is the real source anyway.
    return null;
  }
}

export async function writeCachedSalt(email: string, entry: CachedSalt): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const map = (raw ? JSON.parse(raw) : {}) as Record<string, StoredEntry>;
    map[email] = entry.kdf ? { salt: entry.salt, ...kdfToWire(entry.kdf) } : { salt: entry.salt };
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch (err) {
    console.warn("[atlas] could not cache the login salt:", err);
  }
}
