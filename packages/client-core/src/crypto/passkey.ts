/**
 * A passkey's unlock slot: the key that wraps the account root key under `"passkey:<credential
 * id>"`, derived from the passkey's WebAuthn PRF output.
 *
 * - Every passkey evaluates the same PRF input, {@link passkeyPrfInput} (SHA-256 of
 *   `"atlas-passkey-prf-v1"`): a discoverable sign-in cannot know beforehand which passkey will
 *   answer. The outputs still differ per passkey (the authenticator's PRF secret is per credential).
 * - The slot key is HKDF-SHA256 over the 32-byte PRF output, salted with the raw credential id,
 *   info `"atlas-passkey-slot-v1"` ({@link derivePasskeySlotKey}). The PRF output never leaves the
 *   device; the server stores only the wrap.
 *
 * Pinned by `test-vectors/passkey_vectors.json`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import type { RootKeySlot } from "./rootKey";
import { trimTrailing } from "../text";
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from "./utils";

export const PASSKEY_PRF_LABEL = "atlas-passkey-prf-v1";
const SLOT_INFO = "atlas-passkey-slot-v1";

/** The PRF input every passkey evaluates (32 bytes). */
export function passkeyPrfInput(): Uint8Array {
  return sha256(utf8ToBytes(PASSKEY_PRF_LABEL));
}

/** The PRF input as WebAuthn JSON carries it (unpadded base64url). */
export function passkeyPrfInputBase64Url(): string {
  return bytesToBase64Url(passkeyPrfInput());
}

/** Decode a WebAuthn base64url field, padded or not; throws on anything else. */
export function decodeBase64Url(text: string): Uint8Array {
  const bytes = base64UrlToBytes(trimTrailing(text, "="));
  if (!bytes) throw new Error("not base64url");
  return bytes;
}

/** A credential id normalized to unpadded base64url, the form slots and the server use. */
export function normalizeCredentialId(credentialId: string): string {
  return bytesToBase64Url(decodeBase64Url(credentialId));
}

/** The root key slot of a passkey. */
export function passkeySlot(credentialId: string): RootKeySlot {
  return `passkey:${normalizeCredentialId(credentialId)}`;
}

/** The 32-byte key that wraps the root key in a passkey's slot. */
export function derivePasskeySlotKey(prfOutput: Uint8Array, credentialId: string): Uint8Array {
  if (prfOutput.byteLength !== 32) throw new Error("a PRF output is 32 bytes");
  return hkdf(sha256, prfOutput, decodeBase64Url(credentialId), utf8ToBytes(SLOT_INFO), 32);
}
