import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decryptField, encryptField, isFieldEnvelopeV2, type KeyScope } from "./crypto/field";
import { utf8ToBytes } from "./crypto/utils";
import type { BootstrapProgress, PageRepairs, PersistedOp, Persistence } from "./persistence";
import type { Repair } from "./scope";
import type { Operation } from "./types";

/**
 * A {@link Persistence} that keeps every op's value encrypted at rest.
 *
 * The local op log holds what the store merged: values already decrypted from the wire. For most
 * apps that is the device's own business, but a client that locks (a password manager) must not
 * leave its data readable on disk while it is locked. `sealPersistence(inner, key)` wraps any
 * backend (IndexedDB, SQLite, memory) so that each `set` op's value, and each bootstrap repair's,
 * is stored as a field envelope under `key` instead; loading opens them again. Everything else
 * (op ids, entities, entity ids, field names, clocks, the cursor) is stored as before: the same
 * metadata the server sees.
 *
 * The envelope is the wire's v2 field envelope (AES-256-GCM, padded, associated data naming the
 * entity, field and scope) with its own key id ({@link LOCAL_STORE_KEY_ID}), so a value sealed
 * here can neither be opened at another field nor pass for a wire envelope. Use a key of its own
 * ({@link deriveLocalStoreKey}), not the app key itself.
 *
 * Every stored value must be sealed: a backend written without the wrapper, or under another key,
 * fails to load with {@link SealedStoreError} rather than half-load (start over with `clear()`).
 * Attachment queue rows pass through unchanged (their blob is already ciphertext; their metadata
 * is not sealed): a client that needs them sealed must not queue attachments through this.
 */

/** The key id of a value sealed at rest; never one the wire uses. */
export const LOCAL_STORE_KEY_ID = "local-v1";

const SCOPE: KeyScope = { kind: "personal" };

/**
 * The at-rest key for a user's local store, derived from an app key the client holds only while
 * unlocked (HKDF-SHA256, salted with the user id, info `atlas-local-store-v1`).
 */
export function deriveLocalStoreKey(appKey: Uint8Array, userId: string): Uint8Array {
  if (appKey.length !== 32) throw new Error("the app key must be 32 bytes");
  return hkdf(sha256, appKey, utf8ToBytes(userId), utf8ToBytes("atlas-local-store-v1"), 32);
}

/** A stored value that does not open under this key (another key, tampering, or never sealed). */
export class SealedStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedStoreError";
  }
}

function seal(key: Uint8Array, entity: string, entityId: string, field: string, value: unknown) {
  return encryptField(key, LOCAL_STORE_KEY_ID, SCOPE, { entity, entityId, field }, value);
}

function open(
  key: Uint8Array,
  entity: string,
  entityId: string,
  field: string,
  stored: unknown,
): unknown {
  if (!isFieldEnvelopeV2(stored) || stored.kid !== LOCAL_STORE_KEY_ID) {
    throw new SealedStoreError(`a stored value of ${entity}.${field} is not sealed`);
  }
  try {
    return decryptField(key, SCOPE, { entity, entityId, field }, stored);
  } catch {
    throw new SealedStoreError(`a stored value of ${entity}.${field} does not open with this key`);
  }
}

function sealOp(key: Uint8Array, op: Operation): Operation {
  if (op.op !== "set") return op;
  return { ...op, value: seal(key, op.entity, op.entityId, op.field, op.value) };
}

function openOp(key: Uint8Array, op: Operation): Operation {
  if (op.op !== "set") return op;
  return { ...op, value: open(key, op.entity, op.entityId, op.field, op.value) };
}

function sealRepairs(key: Uint8Array, repairs: Repair[]): Repair[] {
  return repairs.map((r) => ({ ...r, value: seal(key, r.entity, r.entityId, r.field, r.value) }));
}

function openRepairs(key: Uint8Array, repairs: Repair[]): Repair[] {
  return repairs.map((r) => ({ ...r, value: open(key, r.entity, r.entityId, r.field, r.value) }));
}

/**
 * `inner` with every value sealed under `key` (32 bytes). The wrapper offers exactly the optional
 * methods `inner` does, so a store's behaviour (batching, restamping, bootstrap resume) is the
 * inner backend's. Keep a reference to `key` only while the client is unlocked.
 */
export function sealPersistence(inner: Persistence, key: Uint8Array): Persistence {
  if (key.length !== 32) throw new Error("the local store key must be 32 bytes");
  const sealed: Persistence = {
    load: async (): Promise<PersistedOp[]> =>
      (await inner.load()).map((p) => ({ ...p, op: openOp(key, p.op) })),
    append: (op, synced) => inner.append(sealOp(key, op), synced),
    markSynced: (opIds) => inner.markSynced(opIds),
    getCursor: () => inner.getCursor(),
    setCursor: (cursor) => inner.setCursor(cursor),
  };
  if (inner.appendBatch) {
    const appendBatch = inner.appendBatch.bind(inner);
    sealed.appendBatch = (ops, synced) =>
      appendBatch(
        ops.map((op) => sealOp(key, op)),
        synced,
      );
  }
  if (inner.getBootstrap) {
    const getBootstrap = inner.getBootstrap.bind(inner);
    sealed.getBootstrap = async (): Promise<BootstrapProgress | null> => {
      const progress = await getBootstrap();
      if (!progress?.repairs) return progress;
      return { ...progress, repairs: openRepairs(key, progress.repairs) };
    };
  }
  if (inner.setBootstrap) {
    const setBootstrap = inner.setBootstrap.bind(inner);
    sealed.setBootstrap = (progress, page?: PageRepairs) =>
      setBootstrap(
        progress && progress.repairs
          ? { ...progress, repairs: sealRepairs(key, progress.repairs) }
          : progress,
        page ? { ...page, repairs: sealRepairs(key, page.repairs) } : page,
      );
  }
  if (inner.commitSyncBatch) {
    const commit = inner.commitSyncBatch.bind(inner);
    sealed.commitSyncBatch = (ops, cursor) =>
      commit(
        ops.map((op) => sealOp(key, op)),
        cursor,
      );
  }
  if (inner.restamp) {
    const restamp = inner.restamp.bind(inner);
    sealed.restamp = (ops) => restamp(ops.map((op) => sealOp(key, op)));
  }
  const passThrough = [
    "clear",
    "clearSynced",
    "compact",
    "deleteOps",
    "close",
    "loadAttachmentQueue",
    "putAttachmentUpload",
    "deleteAttachmentUpload",
    "listAttachmentQueue",
    "loadAttachmentCiphertext",
    "updateAttachmentUpload",
  ] as const;
  for (const name of passThrough) {
    const fn = inner[name];
    if (typeof fn === "function") {
      (sealed as unknown as Record<string, unknown>)[name] = (
        fn as (...a: unknown[]) => unknown
      ).bind(inner);
    }
  }
  return sealed;
}
