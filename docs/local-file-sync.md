# Syncing local-only mode through a file (planned)

Status: scaffolding only. Nothing here is wired into a client yet.

Local-only mode keeps a user's data on one device. Some people want it on several devices
without an Atlas account or server. They already have a sync service: Nextcloud, iCloud Drive,
Syncthing, Dropbox, OneDrive. This plan lets them pick a file in a folder that service syncs, and
has Atlas read and write its data there.

## Why it works without a server

The op log is a map of last-writer-wins registers, one per field: each field's value is decided
by its HLC alone, and a tombstone the same way, so the result does not depend on the order ops
arrive in or on who merges them. It is not a text or sequence CRDT: concurrent edits to one note
keep the later one whole. Two copies of the log merge by taking the union of their ops. A file therefore needs
no locking and no coordinator:

1. Read the file and decode it (`decodeOpLogFile`).
2. Apply its ops to the store (`LocalStore.applyRemoteBatch`), as if a server had sent them.
3. Write back the union of the file's ops and the store's (`mergeOpLogs`, `encodeOpLogFile`),
   trimmed to what the state needs, as `compactLocal` does for the local database.

When two devices write at about the same time, one of two things happens:

- The later write replaces the earlier one. Nothing is lost: the device whose write was replaced
  still holds its ops and writes them again on its next cycle.
- The sync service keeps both and renames one ("file (conflicted copy)"). Atlas reads the copies
  (`FileSyncTarget.readConflictCopies`), merges them in, and deletes them once its own write
  contains their ops.

## What exists

`packages/client-core/src/opLogFile.ts`:

- `OpLogFile`, the file format: `{ "format": "atlas-oplog", "version": 1, "ops": [...] }`. The
  ops are ordered by HLC, so a sync service that diffs files sees unchanged history as unchanged.
- `encodeOpLogFile`, `decodeOpLogFile` (refuses non-op-log files and newer versions, and skips
  malformed ops) and `mergeOpLogs`.
- `FileSyncTarget`, the interface each platform implements to read and write the chosen file.

## What is left

- **Choosing the file**, per platform: a security-scoped bookmark on iOS and macOS (iCloud
  Drive), a persisted Storage Access Framework URI on Android, a path on Electron, and the File
  System Access API on Chromium. Firefox and Safari on the web have no persistent file handle, so
  the web build may offer only export and import there.
- **A `FileSyncClient`** to run the cycle above on start-up, on foreground, after local writes
  (debounced) and when the file changes, where the platform can watch it. It reports status
  through the same `SyncStatus` the sync badge shows.
- **Storage location setting**: "This device" (today's `atlas-local` database) or "A file you
  choose". The database stays the working copy either way; the file is a replica.
- **Encryption.** Version 1 is plaintext, and the file sits in a third party's cloud. Version 2
  should encrypt the ops under a key derived from a passphrase (Argon2id, as account passwords
  are), with the KDF parameters in the file header. The passphrase is entered once per device.
- **Size.** The file holds the trimmed log, so it grows with the data, not with the number of
  edits. Very large files could later be split by entity kind or by time.
- **Moving to an account.** This works as it does from local-only mode today: the ops are copied
  into the account's outbox (`LocalUpgradeGate`). Afterwards the file is left as it is.
