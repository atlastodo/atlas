/**
 * The account root key: a random 32-byte key above one key per app.
 *
 * - Unlock slots wrap the root. Each slot is the root under that slot's own wrapping key — the
 *   password-derived MEK (`"password"`), the phrase-derived recovery key (`"recovery"`), later a
 *   passkey's PRF output (`"passkey:<credential id>"`) — with {@link wrapRootKey}, whose associated
 *   data binds the account and the slot, so a wrap moved to another slot or account does not open.
 * - When the phrase is not at hand (an existing account migrating at sign-in) the recovery slot is
 *   instead sealed to the account's phrase-derived recovery public key ({@link sealRootKey}).
 * - The root wraps each app's key ({@link wrapAppKey}, bound to the account and the app), and an
 *   app key wraps that app's X25519 identity ({@link wrapAppPrivateKey}). The account's original DEK
 *   is the `todo` app key, so nothing encrypted before the root key existed changes.
 *
 * Nothing belonging to another app, nor the root itself, is ever wrapped under the todo key (the
 * old DEK): API tokens carry a copy of it.
 */

import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { decryptAesGcm, encryptAesGcm } from "./aes";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "./utils";

/** The app whose key is the account's original DEK. */
export const TODO_APP = "todo";

/** A key wrapped under another (root slot, app key, app identity). */
export interface RootKeyWrap {
  v: 1;
  iv: string;
  ct: string;
}

/** A root key sealed to the recovery public key: `epk` is the ephemeral X25519 public key (hex). */
export interface SealedRootKeyWrap extends RootKeyWrap {
  epk: string;
}

/**
 * Which unlock slot a root wrap belongs to. Passkey slots name their credential, so each
 * passkey's wrap opens only as its own.
 */
export type RootKeySlot = "password" | "recovery" | `passkey:${string}`;

const KEY_BYTES = 32;

const json = (parts: unknown[]) => utf8ToBytes(JSON.stringify(parts));
const rootAad = (userId: string, slot: RootKeySlot) =>
  json(["atlas-root-key", 1, userId.toLowerCase(), slot]);
const sealedAad = (userId: string, recipientHex: string) =>
  json(["atlas-root-key", 1, userId.toLowerCase(), "recovery-sealed", recipientHex.toLowerCase()]);
const appKeyAad = (userId: string, app: string) =>
  json(["atlas-app-key", 1, userId.toLowerCase(), app]);
const appIdentityAad = (userId: string, app: string) =>
  json(["atlas-app-identity", 1, userId.toLowerCase(), app, "x25519"]);

function checkKey(key: Uint8Array, what: string): Uint8Array {
  if (key.byteLength !== KEY_BYTES) throw new Error(`${what} must be ${KEY_BYTES} bytes`);
  return key;
}

function wrapWith(key: Uint8Array, target: Uint8Array, aad: Uint8Array): RootKeyWrap {
  return { v: 1, ...encryptAesGcm(key, target, aad) };
}

function unwrapWith(key: Uint8Array, wrap: RootKeyWrap, aad: Uint8Array, what: string) {
  if (wrap.v !== 1) throw new Error(`unknown ${what} wrap version`);
  return checkKey(decryptAesGcm(key, wrap, aad), what);
}

export function generateRootKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/**
 * A fresh account id (v4 UUID) for a signup: the root wraps bind the id, so the client picks it
 * before the server has the account. Not `crypto.randomUUID()`, which Hermes lacks.
 */
export function generateAccountId(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Wrap the root under one unlock slot's 32-byte wrapping key (MEK, recovery key, passkey PRF). */
export function wrapRootKey(
  root: Uint8Array,
  wrappingKey: Uint8Array,
  userId: string,
  slot: RootKeySlot,
): RootKeyWrap {
  return wrapWith(wrappingKey, checkKey(root, "a root key"), rootAad(userId, slot));
}

/** Open a {@link wrapRootKey} wrap; throws for the wrong key, account or slot. */
export function unwrapRootKey(
  wrap: RootKeyWrap,
  wrappingKey: Uint8Array,
  userId: string,
  slot: RootKeySlot,
): Uint8Array {
  return unwrapWith(wrappingKey, wrap, rootAad(userId, slot), "root key");
}

const sealKeyFrom = (shared: Uint8Array) =>
  hkdf(sha256, shared, undefined, utf8ToBytes("atlas-root-seal-v1"), 32);

/**
 * Seal the root to the account's recovery public key (hex), for a recovery slot written without
 * the phrase. Anyone can seal, so whoever opens one checks the root against the todo key.
 */
export function sealRootKey(
  root: Uint8Array,
  recoveryPublicKeyHex: string,
  userId: string,
): SealedRootKeyWrap {
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, hexToBytes(recoveryPublicKeyHex));
  return {
    ...wrapWith(
      sealKeyFrom(shared),
      checkKey(root, "a root key"),
      sealedAad(userId, recoveryPublicKeyHex),
    ),
    epk: bytesToHex(ephemeral.publicKey),
  };
}

/** Open a {@link sealRootKey} seal with the recovery secret key. */
export function unsealRootKey(
  sealed: SealedRootKeyWrap,
  recoverySecretKey: Uint8Array,
  userId: string,
): Uint8Array {
  const shared = x25519.getSharedSecret(recoverySecretKey, hexToBytes(sealed.epk));
  const recipient = bytesToHex(x25519.getPublicKey(recoverySecretKey));
  return unwrapWith(sealKeyFrom(shared), sealed, sealedAad(userId, recipient), "root key");
}

/**
 * Open a recovery slot in either form with the phrase's keys. The server pads the phrase form with
 * a stand-in `epk`, so both are tried; throws when neither opens.
 */
export function openRecoverySlot(
  slot: RootKeyWrap & { epk?: string },
  recovery: { wrapKey: Uint8Array; secretKey: Uint8Array },
  userId: string,
): Uint8Array {
  if (typeof slot.epk === "string") {
    try {
      return unsealRootKey(slot as SealedRootKeyWrap, recovery.secretKey, userId);
    } catch {
      // Not sealed: the phrase form with a padding epk.
    }
  }
  return unwrapRootKey(
    { v: slot.v, iv: slot.iv, ct: slot.ct },
    recovery.wrapKey,
    userId,
    "recovery",
  );
}

/** Wrap an app's key under the root. For `todo` the app key is the account's DEK. */
export function wrapAppKey(
  appKey: Uint8Array,
  root: Uint8Array,
  userId: string,
  app: string,
): RootKeyWrap {
  return wrapWith(
    checkKey(root, "a root key"),
    checkKey(appKey, "an app key"),
    appKeyAad(userId, app),
  );
}

export function unwrapAppKey(
  wrap: RootKeyWrap,
  root: Uint8Array,
  userId: string,
  app: string,
): Uint8Array {
  return unwrapWith(root, wrap, appKeyAad(userId, app), "app key");
}

/** Wrap an app's X25519 identity private key under that app's key. */
export function wrapAppPrivateKey(
  privateKey: Uint8Array,
  appKey: Uint8Array,
  userId: string,
  app: string,
): RootKeyWrap {
  return wrapWith(
    checkKey(appKey, "an app key"),
    checkKey(privateKey, "a private key"),
    appIdentityAad(userId, app),
  );
}

export function unwrapAppPrivateKey(
  wrap: RootKeyWrap,
  appKey: Uint8Array,
  userId: string,
  app: string,
): Uint8Array {
  return unwrapWith(appKey, wrap, appIdentityAad(userId, app), "private key");
}
