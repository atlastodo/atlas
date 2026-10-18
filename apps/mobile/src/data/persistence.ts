import * as SQLite from "expo-sqlite";
import {
  ExpoSqlDatabase,
  SqlitePersistence,
  type IndexedDbEvents,
  type Persistence,
} from "@atlastodo/client-core";
import { closeAll, trackOpen } from "./openDatabases";

/**
 * How the attachment queue keeps a file's ciphertext here: as bytes, the only form SQLite stores
 * (see `AttachmentQueueOptions.ciphertextAsBlob`).
 */
export const CIPHERTEXT_AS_BLOB = false;

/**
 * Build the durable op-log backend ({@link SqlitePersistence}, replayed through
 * `LocalStore.hydrate`), scoped to the signed-in user: the database name embeds the user id so two
 * accounts on one device never share an op log (a second account would inherit the first's
 * unsynced outbox and push ops that 403 forever).
 */
export async function createPersistence(
  userId: string,
  _events: IndexedDbEvents = {},
): Promise<Persistence> {
  const db = await SQLite.openDatabaseAsync(dbName(userId), { useNewConnection: true });
  return trackOpen(userId, new SqlitePersistence(new ExpoSqlDatabase(db)));
}

/**
 * Delete `userId`'s database file: the decrypted op log, the outbox and the upload queue. Any
 * connection still open on it is closed first, so a store left running cannot write it back.
 */
export async function deleteDatabase(userId: string): Promise<void> {
  await closeAll(userId);
  await SQLite.deleteDatabaseAsync(dbName(userId));
}

/** Per-user SQLite filename; the user id is a UUID, so it is filename-safe as-is. */
function dbName(userId: string): string {
  return `atlas-${userId}.db`;
}
