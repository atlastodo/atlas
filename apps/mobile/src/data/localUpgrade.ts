import AsyncStorage from "@react-native-async-storage/async-storage";
import { LocalStore, type EntityKind, type Operation } from "@atlastodo/client-core";
import { LOCAL_SCOPE } from "../auth/localMode";
import { createPersistence } from "./persistence";
import { deleteLocalData } from "./localData";

/**
 * Moving local-only data into an account. The local store keeps every change as a plaintext op in
 * its outbox (ops are encrypted only when pushed), so moving it is copying those ops, still marked
 * unsynced, into the account's database: the account's first sync encrypts and pushes them like
 * any other offline edit, and LWW merges them with what the account already has.
 */

/** Set once a local-only store has opened, so a signed-in launch never creates an empty database. */
const LOCAL_DB_USED_KEY = "@atlas_local_db_used";

/** Settings: per account, so a sign-in to an existing account never takes them from this device. */
const SETTINGS_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(["preference"]);

/** Record that the local-only database exists (it may hold data to move later). */
export async function markLocalDataUsed(): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_DB_USED_KEY, "1");
  } catch (err) {
    console.warn("[atlas] could not record the local database:", err);
  }
}

/** What the local-only database holds, for the move into an account. */
export interface LocalSnapshot {
  /** Every op the local state is built from (superseded history dropped). */
  ops: Operation[];
  /** Tasks, projects, habits and the like still present; settings not counted. */
  itemCount: number;
}

/** The local-only data, or null when there is none to move. */
export async function readLocalData(): Promise<LocalSnapshot | null> {
  if ((await AsyncStorage.getItem(LOCAL_DB_USED_KEY).catch(() => null)) == null) return null;
  const persistence = await createPersistence(LOCAL_SCOPE);
  try {
    // The node only stamps new writes, and this store makes none.
    const store = new LocalStore(LOCAL_SCOPE, { persistence });
    await store.hydrate();
    await store.compactLocal();
    const ops = store.unsyncedOps();
    if (ops.length === 0) return null;
    const kinds = new Set(ops.map((op) => op.entity));
    let itemCount = 0;
    for (const kind of kinds) if (!SETTINGS_KINDS.has(kind)) itemCount += store.list(kind).length;
    return { ops, itemCount };
  } finally {
    await persistence.close?.();
  }
}

/** The ops a sign-in to an existing account takes: everything but settings. */
export function withoutSettings(ops: Operation[]): Operation[] {
  return ops.filter((op) => !SETTINGS_KINDS.has(op.entity));
}

/**
 * Copy `ops` into `userId`'s database as unsynced, then delete the local-only database. The copy is
 * durable before the delete, and the account's outbox survives restarts, so nothing is lost if the
 * app stops halfway: a second run copies the same op ids again, which the database does not store
 * twice (and the server ignores a re-pushed op id).
 */
export async function moveLocalDataInto(userId: string, ops: Operation[]): Promise<void> {
  if (ops.length > 0) {
    const persistence = await createPersistence(userId);
    try {
      if (persistence.appendBatch) await persistence.appendBatch(ops, false);
      else for (const op of ops) await persistence.append(op, false);
    } finally {
      await persistence.close?.();
    }
  }
  await discardLocalData();
}

/** Delete the local-only database and its marker. */
export async function discardLocalData(): Promise<void> {
  await deleteLocalData(LOCAL_SCOPE);
  await AsyncStorage.removeItem(LOCAL_DB_USED_KEY);
}
