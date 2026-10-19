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
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "./utils";

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

const toBase64Url = bytesToBase64Url;
const fromBase64Url = base64UrlToBytes;

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

/**
 * Which key a wrap holds: the todo key (the DEK) and identity keep their original slot names;
 * another app's are `app_key:<app>` and `app_private_key:<app>`.
 */
type WrapSlot = "dek" | "private_key" | `app_key:${string}` | `app_private_key:${string}`;

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

/**
 * Open the todo wraps a token session returned; throws when they are not this token's, or when the
 * token carries no todo key (a token for other apps only).
 */
export function unwrapApiTokenKeys(
  parts: ApiTokenParts,
  userId: string,
  wrapped: { wrapped_dek?: ApiTokenWrap; wrapped_private_key?: ApiTokenWrap },
): { dek: Uint8Array; privateKey: Uint8Array } {
  if (!wrapped.wrapped_dek || !wrapped.wrapped_private_key) {
    throw new Error("this API token carries no todo key");
  }
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

function checkTokenApp(app: string): string {
  if (app === "todo") throw new Error("todo's key travels as wrapped_dek (wrapKeysForApiToken)");
  if (!/^[a-z][a-z0-9_]*$/.test(app)) throw new Error(`not an app id: ${app}`);
  return app;
}

/**
 * Wrap a non-todo app's key and X25519 identity for the token `parts`, as one `app_keys` entry
 * of `POST /auth/api-tokens`. The associated data names the app, so one app's wrap does not open
 * as another's.
 */
export function wrapAppKeysForApiToken(
  parts: ApiTokenParts,
  userId: string,
  app: string,
  keys: { appKey: Uint8Array; privateKey: Uint8Array },
): { wrapped_key: ApiTokenWrap; wrapped_private_key: ApiTokenWrap } {
  checkTokenApp(app);
  const { wrapKey } = deriveApiTokenKeys(parts);
  return {
    wrapped_key: {
      v: 1,
      ...encryptAesGcm(wrapKey, keys.appKey, wrapAad(userId, parts.id, `app_key:${app}`)),
    },
    wrapped_private_key: {
      v: 1,
      ...encryptAesGcm(
        wrapKey,
        keys.privateKey,
        wrapAad(userId, parts.id, `app_private_key:${app}`),
      ),
    },
  };
}

/** Open one `app_keys` entry a token session returned; throws when it is not this token's or app's. */
export function unwrapApiTokenAppKeys(
  parts: ApiTokenParts,
  userId: string,
  app: string,
  wrapped: { wrapped_key: ApiTokenWrap; wrapped_private_key: ApiTokenWrap },
): { appKey: Uint8Array; privateKey: Uint8Array } {
  checkTokenApp(app);
  const { wrapKey } = deriveApiTokenKeys(parts);
  const appKey = decryptAesGcm(
    wrapKey,
    wrapped.wrapped_key,
    wrapAad(userId, parts.id, `app_key:${app}`),
  );
  const privateKey = decryptAesGcm(
    wrapKey,
    wrapped.wrapped_private_key,
    wrapAad(userId, parts.id, `app_private_key:${app}`),
  );
  if (appKey.byteLength !== 32 || privateKey.byteLength !== 32) {
    throw new Error("an API token wrap holds a key of the wrong size");
  }
  return { appKey, privateKey };
}
