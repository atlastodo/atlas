/**
 * Personal API tokens: `atlas_pat_` + base64url(16-byte token id ‖ 32-byte secret).
 * - The id is a UUID (v4 layout), the token's server-side id and the session's device id.
 * - HKDF over the secret (salted with the id) gives the auth value the server checks
 *   (`atlas-pat-auth-v1`, sent as hex and stored only hashed) and the key that wraps a copy of
 *   the DEK and X25519 private key (`atlas-pat-wrap-v1`). The server never sees the secret, so the
 *   wraps open only for whoever holds the token.
 * - Each wrap's associated data binds the account, the token id and which key it is, so a wrap
 *   moved to another token, account or slot does not open.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { decryptAesGcm, encryptAesGcm } from "./aes";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "./utils";

export const API_TOKEN_PREFIX = "atlas_pat_";
const ID_BYTES = 16;
const SECRET_BYTES = 32;

export interface ApiTokenParts {
  /** The token id, as a lowercase UUID. */
  id: string;
  secret: Uint8Array;
}

/** A key wrapped for an API token, as `POST /auth/api-tokens` stores it. */
export interface ApiTokenWrap {
  v: 1;
  iv: string;
  ct: string;
}

export class InvalidApiTokenError extends Error {
  constructor() {
    super("not an Atlas API token");
    this.name = "InvalidApiTokenError";
  }
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function uuidFromBytes(b: Uint8Array): string {
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A fresh token: a random v4-layout id and a random secret. */
export function generateApiToken(): ApiTokenParts {
  const id = randomBytes(ID_BYTES);
  id[6] = (id[6]! & 0x0f) | 0x40;
  id[8] = (id[8]! & 0x3f) | 0x80;
  return { id: uuidFromBytes(id), secret: randomBytes(SECRET_BYTES) };
}

/** The token string a user copies into an integration. */
export function formatApiToken(parts: ApiTokenParts): string {
  const raw = new Uint8Array(ID_BYTES + SECRET_BYTES);
  raw.set(hexToBytes(parts.id.replace(/-/g, "")), 0);
  raw.set(parts.secret, ID_BYTES);
  return API_TOKEN_PREFIX + toBase64Url(raw);
}

/** Read a token string (surrounding whitespace allowed); throws {@link InvalidApiTokenError}. */
export function parseApiToken(token: string): ApiTokenParts {
  const trimmed = token.trim();
  if (!trimmed.startsWith(API_TOKEN_PREFIX)) throw new InvalidApiTokenError();
  const raw = fromBase64Url(trimmed.slice(API_TOKEN_PREFIX.length));
  if (!raw || raw.length !== ID_BYTES + SECRET_BYTES) throw new InvalidApiTokenError();
  return { id: uuidFromBytes(raw.slice(0, ID_BYTES)), secret: raw.slice(ID_BYTES) };
}

/** The values a token's secret derives: the auth value (hex) and the wrapping key. */
export function deriveApiTokenKeys(parts: ApiTokenParts): { auth: string; wrapKey: Uint8Array } {
  const salt = hexToBytes(parts.id.replace(/-/g, ""));
  return {
    auth: bytesToHex(hkdf(sha256, parts.secret, salt, utf8ToBytes("atlas-pat-auth-v1"), 32)),
    wrapKey: hkdf(sha256, parts.secret, salt, utf8ToBytes("atlas-pat-wrap-v1"), 32),
  };
}

type WrapSlot = "dek" | "private_key";

const wrapAad = (userId: string, tokenId: string, slot: WrapSlot) =>
  utf8ToBytes(
    JSON.stringify(["atlas-pat-wrap", 1, userId.toLowerCase(), tokenId.toLowerCase(), slot]),
  );

/** Wrap the account's DEK and X25519 private key for the token `parts`. */
export function wrapKeysForApiToken(
  parts: ApiTokenParts,
  userId: string,
  keys: { dek: Uint8Array; privateKey: Uint8Array },
): { wrapped_dek: ApiTokenWrap; wrapped_private_key: ApiTokenWrap } {
  const { wrapKey } = deriveApiTokenKeys(parts);
  return {
    wrapped_dek: { v: 1, ...encryptAesGcm(wrapKey, keys.dek, wrapAad(userId, parts.id, "dek")) },
    wrapped_private_key: {
      v: 1,
      ...encryptAesGcm(wrapKey, keys.privateKey, wrapAad(userId, parts.id, "private_key")),
    },
  };
}

/** Open the wraps a token session returned; throws when they are not this token's. */
export function unwrapApiTokenKeys(
  parts: ApiTokenParts,
  userId: string,
  wrapped: { wrapped_dek: ApiTokenWrap; wrapped_private_key: ApiTokenWrap },
): { dek: Uint8Array; privateKey: Uint8Array } {
  const { wrapKey } = deriveApiTokenKeys(parts);
  const dek = decryptAesGcm(wrapKey, wrapped.wrapped_dek, wrapAad(userId, parts.id, "dek"));
  const privateKey = decryptAesGcm(
    wrapKey,
    wrapped.wrapped_private_key,
    wrapAad(userId, parts.id, "private_key"),
  );
  if (dek.byteLength !== 32 || privateKey.byteLength !== 32) {
    throw new Error("an API token wrap holds a key of the wrong size");
  }
  return { dek, privateKey };
}
