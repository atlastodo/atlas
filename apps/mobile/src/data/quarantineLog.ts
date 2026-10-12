import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QuarantinedOp } from "./StoreProvider";

/**
 * The changes the server permanently rejected stay listed in Sync details across restarts: the
 * change itself was taken back, so this list is the only trace of it. Device-local on purpose (a
 * synced preference would show one device's rejections on every other), and kept per account like
 * the local database, which `deleteLocalData` removes it with.
 */

/** The most entries kept; older ones fall off, so the list cannot grow without bound. */
export const MAX_QUARANTINED = 50;

/** The AsyncStorage key of `userId`'s list. */
export function quarantineKey(userId: string): string {
  return `@atlas_quarantined_ops_${userId}`;
}

/** Both lists as one, newest first, each op once (the first copy wins), capped. */
export function mergeQuarantined(a: QuarantinedOp[], b: QuarantinedOp[]): QuarantinedOp[] {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((q) => (seen.has(q.opId) ? false : (seen.add(q.opId), true)))
    .sort((x, y) => y.at - x.at)
    .slice(0, MAX_QUARANTINED);
}

function isEntry(v: unknown): v is QuarantinedOp {
  if (!v || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return (
    typeof q.opId === "string" &&
    typeof q.entityKind === "string" &&
    typeof q.entityId === "string" &&
    typeof q.message === "string" &&
    typeof q.at === "number" &&
    (q.status === undefined || typeof q.status === "number")
  );
}

/** `userId`'s saved list; empty when there is none or it cannot be read. */
export async function loadQuarantined(userId: string): Promise<QuarantinedOp[]> {
  try {
    const raw = await AsyncStorage.getItem(quarantineKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? mergeQuarantined(parsed.filter(isEntry), []) : [];
  } catch (err) {
    console.warn("[atlas sync] could not read the rejected changes:", err);
    return [];
  }
}

/** Replace `userId`'s saved list; an empty one removes the key. */
export async function saveQuarantined(userId: string, entries: QuarantinedOp[]): Promise<void> {
  try {
    const key = quarantineKey(userId);
    if (entries.length === 0) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, JSON.stringify(entries.slice(0, MAX_QUARANTINED)));
  } catch (err) {
    console.warn("[atlas sync] could not save the rejected changes:", err);
  }
}
