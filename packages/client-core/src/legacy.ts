/**
 * The migration of rows written before sync protocol 7 (docs/decisions/0006): their plaintext kind,
 * field names and links stay on the server until the client that holds them re-encodes them and
 * drops the originals.
 *
 * The server lists what the partition still holds (`GET /sync/legacy/keys`). A key a current copy
 * already covers (another device or member re-encoded it) is dropped as it is. Any other is
 * re-encoded from this device's copy: every visible field and the tombstone, each with its original
 * stamp, so the re-encoded copy changes nothing on any device, then dropped
 * (`POST /sync/legacy/drop`). The local store is not written. An entity this device cannot re-encode
 * yet (a value no key opens, a scope without its key, an activity of another member, a shared
 * project of another owner) stays until a later pass or its owner's client.
 */

import type { LocalStore } from "./store";
import type { EntityKind, Operation } from "./types";
import { isEncryptedEnvelope } from "./crypto";

export interface LegacyKey {
  entity: string;
  entity_id: string;
  covered: boolean;
}

export interface LegacyKeysPage {
  entities: LegacyKey[];
  next?: string;
}

export interface LegacyTransport {
  legacyKeys(next?: string): Promise<LegacyKeysPage>;
  dropLegacy(keys: { entity: string; entity_id: string }[]): Promise<number>;
  syncPush(ops: Operation[]): Promise<{ deferred?: string[] }>;
  /** Whether this account may write every field of the entity (its role, its activity). */
  mayReencode?(kind: EntityKind, entityId: string): boolean;
}

export interface LegacyMigration {
  /** Entities re-encoded and dropped. */
  reencoded: number;
  /** Keys dropped as they were, already covered by a current copy. */
  covered: number;
  /** Keys left for a later pass. */
  left: number;
}

/** Keys re-encoded per push. */
const ENTITIES_PER_PUSH = 100;

/** The ops that re-encode `kind` entity `id` from `store`'s copy, or null when it cannot yet. */
function reencode(
  store: Pick<LocalStore, "exists" | "visibleFieldStates" | "tombstoneTs" | "newEntityId">,
  kind: EntityKind,
  id: string,
): Operation[] | null {
  if (!store.exists(kind, id)) return null; // not on this device yet
  const fields = store.visibleFieldStates(kind, id);
  if (fields.some((f) => isEncryptedEnvelope(f.value))) return null; // a value no key opens yet
  const ops: Operation[] = fields.map((f) => ({
    id: store.newEntityId(),
    entity: kind,
    entityId: id,
    ts: f.ts,
    op: "set",
    field: f.field,
    value: f.value,
  }));
  const deleted = store.tombstoneTs(kind, id);
  if (deleted)
    ops.push({ id: store.newEntityId(), entity: kind, entityId: id, ts: deleted, op: "delete" });
  return ops;
}

/** One pass over the partition's legacy keys. Throws what the transport throws. */
export async function migrateLegacy(
  store: LocalStore,
  transport: LegacyTransport,
): Promise<LegacyMigration> {
  const result: LegacyMigration = { reencoded: 0, covered: 0, left: 0 };
  let next: string | undefined;
  do {
    const page = await transport.legacyKeys(next);
    next = page.next;
    const drop: { entity: string; entity_id: string }[] = [];
    const pending: { key: LegacyKey; ops: Operation[] }[] = [];
    for (const key of page.entities) {
      if (key.covered) {
        drop.push(key);
        result.covered++;
        continue;
      }
      const kind = key.entity as EntityKind;
      const ops =
        transport.mayReencode?.(kind, key.entity_id) === false
          ? null
          : reencode(store, kind, key.entity_id);
      if (!ops || ops.length === 0) {
        result.left++;
        continue;
      }
      pending.push({ key, ops });
    }
    for (let i = 0; i < pending.length; i += ENTITIES_PER_PUSH) {
      const chunk = pending.slice(i, i + ENTITIES_PER_PUSH);
      const { deferred = [] } = await transport.syncPush(chunk.flatMap((c) => c.ops));
      const waiting = new Set(deferred);
      for (const { key, ops } of chunk) {
        // An op waiting for its project's key went nowhere: keep the original.
        if (ops.some((op) => waiting.has(op.id))) {
          result.left++;
          continue;
        }
        drop.push(key);
        result.reencoded++;
      }
    }
    if (drop.length > 0) {
      await transport.dropLegacy(drop.map(({ entity, entity_id }) => ({ entity, entity_id })));
    }
  } while (next);
  return result;
}
