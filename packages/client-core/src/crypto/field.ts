/**
 * Field-value encryption. Version 3 (`sealField`, sync protocol 7) is what clients write: the
 * plaintext holds the real kind and field name too, and the wire carries an opaque tag
 * (`fieldTag`) instead of the field name. Version 2 (`{ __enc: 2, kid, iv, ct }`) is read for rows
 * written before protocol 7. In both, the AES-GCM associated data binds a value to its envelope
 * version, wire kind and entity id, wire field, key scope and key id, so ciphertext the server
 * copies elsewhere fails to open instead of being read or re-encrypted there. Both pad the JSON
 * plaintext to a size bucket so length does not reveal `true` from `false` or a short title from a
 * long one. Version 1 (unpadded, no associated data) is read, never written.
 */

import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decryptAesGcm, encryptAesGcm } from "./aes";
import { bytesToHex, bytesToUtf8, utf8ToBytes } from "./utils";

export const FIELD_ENVELOPE_VERSION = 2;

export type KeyScope = { kind: "personal" } | { kind: "project"; projectId: string };

export interface FieldLocation {
  entity: string;
  entityId: string;
  field: string;
}

export interface FieldEnvelopeV2 {
  __enc: 2;
  kid: string;
  iv: string;
  ct: string;
}

export function sameKeyScope(a: KeyScope, b: KeyScope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "personal" || a.projectId === (b as { projectId: string }).projectId;
}

export function keyScopeLabel(scope: KeyScope): string {
  return scope.kind === "personal" ? "personal" : `project:${scope.projectId}`;
}

/** The associated data: every part length-delimited by JSON, so no two contexts collide. */
function fieldAad(at: FieldLocation, scope: KeyScope, kid: string): Uint8Array {
  return utf8ToBytes(
    JSON.stringify([
      "atlas-field",
      FIELD_ENVELOPE_VERSION,
      at.entity,
      at.entityId,
      at.field,
      keyScopeLabel(scope),
      kid,
    ]),
  );
}

/**
 * The padded size for `n` bytes of plaintext plus the one-byte pad marker: at least `min` (32 for
 * version 2), then the next power of two up to 1 KiB, then the next multiple of 1 KiB.
 */
export function paddedLength(n: number, min = 32): number {
  const needed = n + 1;
  if (needed <= min) return min;
  if (needed <= 1024) return 2 ** Math.ceil(Math.log2(needed));
  return Math.ceil(needed / 1024) * 1024;
}

/** Append 0x80 and zeros up to the bucket size (ISO/IEC 7816-4 padding). */
export function padPlaintext(data: Uint8Array, min = 32): Uint8Array {
  const out = new Uint8Array(paddedLength(data.length, min));
  out.set(data, 0);
  out[data.length] = 0x80;
  return out;
}

export function unpadPlaintext(data: Uint8Array): Uint8Array {
  let end = data.length - 1;
  while (end >= 0 && data[end] === 0) end--;
  if (end < 0 || data[end] !== 0x80) throw new Error("bad field padding");
  return data.subarray(0, end);
}

export function encryptField(
  key: Uint8Array,
  kid: string,
  scope: KeyScope,
  at: FieldLocation,
  value: unknown,
): FieldEnvelopeV2 {
  const plain = padPlaintext(utf8ToBytes(JSON.stringify(value)));
  const { iv, ct } = encryptAesGcm(key, plain, fieldAad(at, scope, kid));
  return { __enc: 2, kid, iv, ct };
}

/**
 * Open a v2 envelope that claims to sit at `at` and to be encrypted by `key` of `scope`. Throws
 * when any of that is untrue: another key, another scope, or a value copied from elsewhere.
 */
export function decryptField(
  key: Uint8Array,
  scope: KeyScope,
  at: FieldLocation,
  envelope: FieldEnvelopeV2,
): unknown {
  const plain = decryptAesGcm(key, envelope, fieldAad(at, scope, envelope.kid));
  return JSON.parse(bytesToUtf8(unpadPlaintext(plain)));
}

/** Sync protocol 7's envelope (docs/decisions/0006). */
export const FIELD_ENVELOPE_V3 = 3;

/**
 * A v3 plaintext carries the kind and field name too, so its smallest bucket is 64 bytes: a small
 * value of a long-named field must not fall in another bucket than one of a short-named field.
 */
export const FIELD_V3_MIN_PADDING = 64;

export interface FieldEnvelopeV3 {
  __enc: 3;
  kid: string;
  iv: string;
  ct: string;
}

/** Where a v3 envelope sits on the wire: the wire kind and wire field (a tag or a public name). */
export interface WireLocation {
  entity: string;
  entityId: string;
  field: string;
}

/** What a v3 envelope holds. */
export interface SealedField {
  kind: string;
  field: string;
  value: unknown;
}

function fieldAadV3(at: WireLocation, scope: KeyScope, kid: string): Uint8Array {
  return utf8ToBytes(
    JSON.stringify([
      "atlas-field",
      FIELD_ENVELOPE_V3,
      at.entity,
      at.entityId,
      at.field,
      keyScopeLabel(scope),
      kid,
    ]),
  );
}

export function sealField(
  key: Uint8Array,
  kid: string,
  scope: KeyScope,
  at: WireLocation,
  sealed: SealedField,
): FieldEnvelopeV3 {
  const plain = padPlaintext(
    utf8ToBytes(JSON.stringify([sealed.kind, sealed.field, sealed.value ?? null])),
    FIELD_V3_MIN_PADDING,
  );
  const { iv, ct } = encryptAesGcm(key, plain, fieldAadV3(at, scope, kid));
  return { __enc: 3, kid, iv, ct };
}

/**
 * Open a v3 envelope that claims to sit at `at` under `key` of `scope`. Throws when any of that is
 * untrue, or when the plaintext is not a `[kind, field, value]` triple.
 */
export function openSealedField(
  key: Uint8Array,
  scope: KeyScope,
  at: WireLocation,
  envelope: FieldEnvelopeV3,
): SealedField {
  const plain = decryptAesGcm(key, envelope, fieldAadV3(at, scope, envelope.kid));
  const parsed: unknown = JSON.parse(bytesToUtf8(unpadPlaintext(plain)));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    throw new Error("malformed sealed field");
  }
  return { kind: parsed[0], field: parsed[1], value: parsed[2] };
}

export function isFieldEnvelopeV3(v: unknown): v is FieldEnvelopeV3 {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.__enc === 3 &&
    typeof o.kid === "string" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string"
  );
}

/** The key a scope's field tags are made with: HKDF-SHA256 of the encrypting key. */
export function fieldTagKey(key: Uint8Array): Uint8Array {
  return hkdf(sha256, key, undefined, utf8ToBytes("atlas-field-tag-v1"), 32);
}

const TAG_RE = /^[0-9a-f]{32}$/;

/**
 * The opaque wire name of `field` of `kind` entity `entityId`: 32 lowercase hex digits. The entity
 * id is part of it, so the same field of two entities has unrelated tags.
 */
export function fieldTag(
  tagKey: Uint8Array,
  entityId: string,
  kind: string,
  field: string,
): string {
  const mac = hmac(
    sha256,
    tagKey,
    utf8ToBytes(JSON.stringify(["atlas-field-tag", 1, entityId, kind, field])),
  );
  return bytesToHex(mac.subarray(0, 16));
}

export function isFieldTag(name: string): boolean {
  return TAG_RE.test(name);
}

export function isFieldEnvelopeV2(v: unknown): v is FieldEnvelopeV2 {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.__enc === 2 &&
    typeof o.kid === "string" &&
    typeof o.iv === "string" &&
    typeof o.ct === "string"
  );
}
