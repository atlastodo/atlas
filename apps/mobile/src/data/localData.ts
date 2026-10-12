import AsyncStorage from "@react-native-async-storage/async-storage";
import { createPersistence, deleteDatabase } from "./persistence";
import { quarantineKey } from "./quarantineLog";

/** AsyncStorage keys of the one-time local database migrations `StoreProvider` runs per user. */
export function migrationKeys(userId: string) {
  return {
    atomicSync: `@atlas_migration_atomic_sync_v2_${userId}`,
    e2ee: `@atlas_migration_e2ee_v2_${userId}`,
    /** The E2EE migration's snapshot walk has started (it then resumes instead of restarting). */
    e2eeWalk: `@atlas_migration_e2ee_v2_walk_${userId}`,
  };
}

/**
 * Delete what this device keeps of `userId`'s data: the local database, which holds every synced
 * value decrypted plus the changes not yet pushed, the migration markers that describe it, and the
 * list of changes the server rejected.
 */
export async function deleteLocalData(userId: string): Promise<void> {
  await deleteDatabase(userId);
  await AsyncStorage.multiRemove([...Object.values(migrationKeys(userId)), quarantineKey(userId)]);
}

/**
 * How many of `userId`'s local changes the server does not have yet, read from the database. For
 * when no store has it open (a locked session); a mounted store knows its own outbox.
 */
export async function countUnsyncedChanges(userId: string): Promise<number> {
  const p = await createPersistence(userId);
  try {
    return (await p.load()).filter((e) => !e.synced).length;
  } finally {
    await p.close?.();
  }
}
