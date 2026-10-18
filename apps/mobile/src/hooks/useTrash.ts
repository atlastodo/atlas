import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  decryptMeta,
  unwrapAekAny,
  type AttachmentKeyPayload,
  type AttachmentMetaPayload,
  type EntityKind,
  type Keyring,
  type LocalStore,
} from "@atlastodo/client-core";
import {
  listTrash,
  purge,
  purgeAllTrash,
  restoreFromTrash,
  sweepExpiredTrash,
  type TrashItem,
} from "@atlastodo/shared";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";
import { useFirstSyncDone } from "./useFirstSyncDone";

/**
 * Recently Deleted / Trash. The rules (soft-delete vs tombstone, the 30-day window, the container
 * cascade) live in `@atlastodo/shared`'s `trash.ts`; this hook is only the React wiring.
 */

export interface UseTrash {
  /** Soft-deleted items still within the 30-day window, newest-deleted first. */
  items: TrashItem[];
  /** Restore an item from Trash (a container's children return with it). */
  restore: (kind: EntityKind, id: string) => void;
  /** Permanently delete an item (hard tombstone, cascading to children). */
  purgeItem: (kind: EntityKind, id: string) => void;
  /** Permanently delete all items currently in Trash. */
  purgeAll: () => number;
}

/** An attachment's filename, which only its encrypted metadata holds; "" when unreadable. */
function attachmentName(store: LocalStore, keyring: Keyring | null, id: string): string {
  const fields = store.get("attachment", id);
  const wrapped = fields?.wrapped_key as AttachmentKeyPayload | undefined;
  const meta = fields?.meta as AttachmentMetaPayload | undefined;
  if (!keyring?.hasKeys() || !wrapped || !meta) return "";
  try {
    return decryptMeta(unwrapAekAny(wrapped, keyring, id), meta).filename;
  } catch {
    return "";
  }
}

export function useTrash(): UseTrash {
  const { store, version, kick } = useStore();
  const { keyring } = useAuth();

  const items = useMemo(
    () =>
      listTrash(store, Date.now()).map((item) =>
        item.kind === "attachment"
          ? { ...item, label: attachmentName(store, keyring, item.id) }
          : item,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, version, keyring],
  );

  const restore = useCallback(
    (kind: EntityKind, id: string) => restoreFromTrash(store, kick, kind, id),
    [store, kick],
  );
  const purgeItem = useCallback(
    (kind: EntityKind, id: string) => purge(store, kick, kind, id),
    [store, kick],
  );
  const purgeAll = useCallback(() => purgeAllTrash(store, kick, Date.now()), [store, kick]);

  return { items, restore, purgeItem, purgeAll };
}

/**
 * Once-per-session sweep that permanently purges Trash items older than 30 days. It issues the
 * tombstone the soft-delete deferred, so it must run on every platform. Mount it once near the
 * app root.
 *
 * It waits for the first successful sync: until then the local `deleted_at` may be stale, and
 * purging an item another device has since restored would tombstone it everywhere.
 */
export function useTrashSweep(): void {
  const { store, kick } = useStore();
  const firstSyncDone = useFirstSyncDone();
  const swept = useRef(false);
  useEffect(() => {
    if (!firstSyncDone || swept.current) return;
    swept.current = true;
    sweepExpiredTrash(store, kick, Date.now());
  }, [store, kick, firstSyncDone]);
}
