/**
 * What an invitee is shown before accepting (sync protocol 7): the project's name, icon, color and
 * kind, which the server cannot read any more, encrypted by the inviter under the project key the
 * invitee receives sealed with the invite. Bound to the project and the key id, and padded like a
 * field value, so the server can neither move it to another project nor learn the name's length.
 */

import { decryptAesGcm, encryptAesGcm } from "./aes";
import { padPlaintext, unpadPlaintext } from "./field";
import { bytesToUtf8, utf8ToBytes } from "./utils";

export interface InvitePreview {
  name?: unknown;
  icon?: unknown;
  color?: unknown;
  kind?: unknown;
}

export interface SealedInvitePreview {
  v: 1;
  kid: string;
  iv: string;
  ct: string;
}

function previewAad(projectId: string, kid: string): Uint8Array {
  return utf8ToBytes(JSON.stringify(["atlas-invite-preview", 1, projectId, kid]));
}

/** Under project key `pek` (id `kid`) of `projectId`. */
export function sealInvitePreview(
  pek: Uint8Array,
  kid: string,
  projectId: string,
  preview: InvitePreview,
): SealedInvitePreview {
  const { name, icon, color, kind } = preview;
  const plain = padPlaintext(utf8ToBytes(JSON.stringify({ name, icon, color, kind })), 64);
  const { iv, ct } = encryptAesGcm(pek, plain, previewAad(projectId, kid));
  return { v: 1, kid, iv, ct };
}

/** Throws unless `pek` sealed it for `projectId`. */
export function openInvitePreview(
  pek: Uint8Array,
  projectId: string,
  sealed: SealedInvitePreview,
): InvitePreview {
  const plain = decryptAesGcm(pek, sealed, previewAad(projectId, sealed.kid));
  const parsed: unknown = JSON.parse(bytesToUtf8(unpadPlaintext(plain)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("malformed invite preview");
  }
  const { name, icon, color, kind } = parsed as InvitePreview;
  return { name, icon, color, kind };
}

export function isSealedInvitePreview(v: unknown): v is SealedInvitePreview {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 && typeof o.kid === "string" && typeof o.iv === "string" && typeof o.ct === "string"
  );
}
