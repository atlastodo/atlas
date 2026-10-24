import { encryptAesGcm, decryptAesGcm, type EncryptedPayload } from "./aes";
import { keyScopeLabel, type KeyScope } from "./field";
import { randomBytes, utf8ToBytes } from "./utils";

export function generateDek(): Uint8Array {
  return randomBytes(32);
}

export function generatePek(): Uint8Array {
  return randomBytes(32);
}

/**
 * Wraps a symmetric key (DEK, PEK or private key) with a wrapping key (MEK or recovery key) using
 * AES-256-GCM.
 */
export function wrapKey(targetKey: Uint8Array, wrappingKey: Uint8Array): EncryptedPayload {
  return encryptAesGcm(wrappingKey, targetKey);
}

export function unwrapKey(wrapped: EncryptedPayload, wrappingKey: Uint8Array): Uint8Array {
  return decryptAesGcm(wrappingKey, wrapped);
}

export interface WrappedProjectKey {
  v: 2;
  iv: string;
  ct: string;
}

const projectKeyAad = (projectId: string) =>
  utf8ToBytes(JSON.stringify(["atlas-pek-wrap", 2, projectId]));

/**
 * Wrap `pek` under the DEK with `projectId` as associated data, so the server cannot hand one
 * project's copy back as another's.
 */
export function wrapProjectKey(
  pek: Uint8Array,
  dek: Uint8Array,
  projectId: string,
): WrappedProjectKey {
  return { v: 2, ...encryptAesGcm(dek, pek, projectKeyAad(projectId)) };
}

/**
 * Open a copy stored by {@link wrapProjectKey} for `projectId`, or an older unbound one
 * (`wrapKey(pek, dek)`, no `v`).
 */
export function unwrapProjectKey(
  wrapped: EncryptedPayload & { v?: unknown },
  dek: Uint8Array,
  projectId: string,
): Uint8Array {
  if (wrapped.v === 2) return decryptAesGcm(dek, wrapped, projectKeyAad(projectId));
  return decryptAesGcm(dek, wrapped);
}

/**
 * An attachment's file key wrapped for that attachment under a key of its scope (`wrapped_key`).
 * `kid` names the wrapping key (`dek` or a project key fingerprint), so no key search is needed.
 */
export interface WrappedAttachmentKey {
  v: 2;
  kid: string;
  iv: string;
  ct: string;
}

export type AttachmentKeyPayload = WrappedAttachmentKey | EncryptedPayload;

/**
 * The associated data of a wrapped attachment key: attachment id, scope and wrapping key id. A
 * copied `wrapped_key` does not open on another attachment.
 */
const attachmentKeyAad = (attachmentId: string, scope: KeyScope, kid: string) =>
  utf8ToBytes(JSON.stringify(["atlas-attachment-key", 2, attachmentId, keyScopeLabel(scope), kid]));

export function wrapAttachmentKey(
  aek: Uint8Array,
  key: Uint8Array,
  kid: string,
  scope: KeyScope,
  attachmentId: string,
): WrappedAttachmentKey {
  return { v: 2, kid, ...encryptAesGcm(key, aek, attachmentKeyAad(attachmentId, scope, kid)) };
}

/**
 * Open a key from {@link wrapAttachmentKey}; throws unless it belongs to `attachmentId` and was
 * wrapped by `key` of `scope`.
 */
export function unwrapAttachmentKey(
  wrapped: WrappedAttachmentKey,
  key: Uint8Array,
  scope: KeyScope,
  attachmentId: string,
): Uint8Array {
  return decryptAesGcm(key, wrapped, attachmentKeyAad(attachmentId, scope, wrapped.kid));
}

/**
 * Whether `v` is a bound wrapped attachment key. Older clients wrote unbound `{ iv, ct }`: still
 * read, never written.
 */
export function isWrappedAttachmentKey(v: unknown): v is WrappedAttachmentKey {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 2 && typeof o.kid === "string" && typeof o.iv === "string" && typeof o.ct === "string"
  );
}

/**
 * Whether a field value is still in encrypted wire form (`{ __enc: 3, kid, iv, ct }`, or the older
 * `__enc: 2` and `__enc: 1`). A field no key here opens is stored as this object, so its presence
 * means "unreadable here", not "empty".
 */
export function isEncryptedEnvelope(
  v: unknown,
): v is
  { __enc: 1; iv: string; ct: string } | { __enc: 2 | 3; kid: string; iv: string; ct: string } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.iv !== "string" || typeof o.ct !== "string") return false;
  return o.__enc === 1 || ((o.__enc === 2 || o.__enc === 3) && typeof o.kid === "string");
}
