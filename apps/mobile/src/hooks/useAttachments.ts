import { useCallback, useMemo } from "react";
import { isTrashed, softDelete } from "@atlastodo/shared";
import {
  BlobIntegrityError,
  decryptMeta,
  fetchBlob,
  unwrapAekAny,
  type AttachmentDraft,
  type AttachmentKeyPayload,
  type AttachmentMeta,
  type AttachmentMetaPayload,
  type Keyring,
  type PersistedAttachmentUpload,
  type Task,
} from "@atlastodo/client-core";
import { useAuth } from "../auth/AuthContext";
import { useStore } from "../data/StoreProvider";

/**
 * Task attachments, the `attachment` entity kind. The metadata rides the ordinary sync outbox like
 * a comment; the descriptive fields (filename, mime) live inside the encrypted `meta` envelope
 * (`__aenc:1`, keyed by the file's own AEK), so rendering a row unwraps the AEK with the task's
 * scope key (the project's PEK, else the personal DEK). A row whose meta cannot be read still
 * shows: the plaintext `blob_size` and `blob_sha` give a generic placeholder.
 *
 * The upload is the durable `AttachmentQueue` from the store context: `add` encrypts immediately
 * (works offline), lets the queue make its first blob attempt, then kicks sync so the metadata,
 * released after that attempt, goes out. Deletion is a soft-delete; the server's blob GC reclaims
 * the bytes later.
 *
 * Read-time trash cascade: an attachment whose task is trashed (or gone) hides with it, so no
 * device has to tombstone it separately.
 */

/** One renderable attachment row: metadata already decrypted into plaintext display fields. */
export interface AttachmentView {
  id: string;
  taskId: string;
  filename: string;
  mime: string;
  /** Plaintext link/size fields -- always readable, even when `meta` is not. */
  blobSha: string;
  blobSize: number;
  createdAt: number;
  sortOrder: number;
  /** The decrypted meta, or null when the AEK could not be unwrapped (render a generic row). */
  meta: AttachmentMeta | null;
}

export interface UseAttachments {
  attachments: AttachmentView[];
  /** Encrypt + durably queue a file and make the first upload attempt; resolves to the queue row. */
  add: (
    file: Pick<AttachmentDraft, "filename" | "mime" | "source" | "dims">,
  ) => Promise<PersistedAttachmentUpload | null>;
  /** Fetch + verify + decrypt one attachment's bytes (throws 404/403/integrity errors upward). */
  load: (id: string) => Promise<Uint8Array>;
  /** Soft-delete an attachment (returns an undo closure, the comments pattern). */
  remove: (id: string) => () => void;
}

/** Attachments are E2EE-only, so an unlocked keyring is the gate (as for the queue). */
export function canUseAttachments(keyring: Keyring | null): boolean {
  return keyring?.hasKeys() ?? false;
}

export function useAttachments(task: Task): UseAttachments {
  const { store, version, kick, attachments } = useStore();
  const { api, keyring } = useAuth();

  const attachments_ = useMemo(() => {
    void version; // re-derive on every store change
    // The read-time cascade: a trashed (or absent) task hides its attachments.
    const parent = store.get("task", task.id);
    if (!parent || isTrashed(parent)) return [];
    // The project's key first; an attachment written under another key still opens.
    const preferred = task.project_id ? keyring?.getProjectKey(task.project_id) : null;
    return store
      .list("attachment")
      .filter((e) => e.fields.task_id === task.id && !isTrashed(e.fields))
      .map((e) => {
        let meta: AttachmentMeta | null = null;
        const wrapped = e.fields.wrapped_key as AttachmentKeyPayload | undefined;
        const payload = e.fields.meta as AttachmentMetaPayload | undefined;
        if (keyring?.hasKeys() && wrapped && payload) {
          try {
            meta = decryptMeta(unwrapAekAny(wrapped, keyring, e.id, preferred), payload);
          } catch {
            // No key (revoked project, or not yet distributed) -- a generic row, never a crash.
            meta = null;
          }
        }
        return {
          id: e.id,
          taskId: task.id,
          filename: meta?.filename ?? "",
          mime: meta?.mime ?? "",
          blobSha: typeof e.fields.blob_sha === "string" ? e.fields.blob_sha : "",
          blobSize: typeof e.fields.blob_size === "number" ? e.fields.blob_size : 0,
          createdAt: typeof e.fields.created_at === "number" ? e.fields.created_at : 0,
          sortOrder: typeof e.fields.sort_order === "number" ? e.fields.sort_order : 0,
          meta,
        } satisfies AttachmentView;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  }, [store, version, task.id, task.project_id, keyring]);

  const add = useCallback(
    async (file: Pick<AttachmentDraft, "filename" | "mime" | "source" | "dims">) => {
      const ctx = attachments;
      if (!ctx) return null; // no queue before the store and keyring exist (the UI gates this)
      // `projectId` must ride along so the AEK wraps under the task's PEK scope.
      const upload = await ctx.queue.enqueue({
        taskId: task.id,
        projectId: task.project_id ?? null,
        ...file,
      });
      await ctx.queue.drain().catch(() => {}); // first settled put attempt (releases the metadata)
      kick(); // push whatever the attempt released
      return upload;
    },
    [attachments, task.id, task.project_id, kick],
  );

  const remove = useCallback(
    (id: string) => softDelete(store, kick, "attachment", id),
    [store, kick],
  );

  /**
   * Download one row: unwrap the AEK again, stream the ciphertext through the ApiClient blob bridge
   * decrypting chunk by chunk, and verify both the content address and the plaintext sha. A 404 is
   * "not uploaded yet" (the section retries lazily), a 403 is revocation, and a
   * `BlobIntegrityError` poisons the row only.
   */
  const load = useCallback(
    async (id: string): Promise<Uint8Array> => {
      if (!keyring) throw new Error("attachments are E2EE-only; the keyring is locked");
      const fields = store.get("attachment", id);
      const wrapped = fields?.wrapped_key as AttachmentKeyPayload | undefined;
      const payload = fields?.meta as AttachmentMetaPayload | undefined;
      const blobSha = fields?.blob_sha;
      if (!fields || !wrapped || typeof blobSha !== "string") {
        throw new BlobIntegrityError("attachment metadata is incomplete");
      }
      const preferred = task.project_id ? keyring.getProjectKey(task.project_id) : null;
      const aek = unwrapAekAny(wrapped, keyring, id, preferred);
      const meta = payload ? decryptMeta(aek, payload) : null;
      return fetchBlob(
        { put: (sha, body) => api.putBlob(sha, body), get: (sha) => api.streamBlob(sha) },
        blobSha,
        aek,
        meta?.plain_sha,
      );
    },
    [keyring, store, task.project_id, api],
  );

  return { attachments: attachments_, add, load, remove };
}
