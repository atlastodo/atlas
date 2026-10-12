/**
 * The client half of password change, KDF upgrade, phrase recovery and phrase replacement. The
 * server can only swap the stored hash of the derived auth credential; the DEK and private key are
 * wrapped with the password-derived MEK, so the re-wrap happens here, built from the shared crypto
 * primitives.
 */
import {
  CURRENT_KDF,
  bytesToHex,
  deriveAuthAndMekAsync,
  deriveRecoveryKeys,
  generateRecoveryPhrase,
  kdfToWire,
  unsealKey,
  unwrapKey,
  wrapKey,
  type EncryptedPayload,
  type PasswordKdf,
} from "./crypto";
import type {
  ChangePasswordPayload,
  RecoverAccountPayload,
  RecoveryKeysResponse,
  RegisterRecoveryKeyPayload,
  ReplaceRecoveryKeyPayload,
} from "./types";

export interface E2eeKeyMaterial {
  /**
   * The account's KDF salt. Immutable: the auth hash, the MEK and the recovery wraps all derive
   * from it, so rotating it would invalidate every stored wrap.
   */
  salt: string;
  kdf: PasswordKdf;
  dek: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Build the `POST /auth/change-password` payload: the current auth hash (verified as at login), the
 * new credential from `newKdf`, and the DEK and private key re-wrapped under the new MEK. The
 * public key is untouched.
 */
export async function buildE2eePasswordChange(
  material: E2eeKeyMaterial,
  currentPassword: string,
  newPassword: string,
  newKdf: PasswordKdf,
): Promise<ChangePasswordPayload> {
  const current = await deriveAuthAndMekAsync(currentPassword, material.salt, material.kdf);
  const next = await deriveAuthAndMekAsync(newPassword, material.salt, newKdf);
  return {
    current_password: current.authHash,
    new_password: next.authHash,
    encrypted_dek: wrapKey(material.dek, next.mek),
    encrypted_private_key: wrapKey(material.privateKey, next.mek),
    ...kdfToWire(newKdf),
  };
}

/**
 * Build the payload that moves an unchanged password to `newKdf` right after a sign-in with an
 * older one. Only what the password-derived key wraps is re-wrapped; recovery copies stay. The
 * server applies it in one UPDATE, so a failure leaves the old KDF and wraps working.
 */
export async function buildKdfUpgrade(
  material: Omit<E2eeKeyMaterial, "kdf">,
  password: string,
  currentAuthHash: string,
  newKdf: PasswordKdf = CURRENT_KDF,
): Promise<ChangePasswordPayload> {
  const next = await deriveAuthAndMekAsync(password, material.salt, newKdf);
  return {
    current_password: currentAuthHash,
    new_password: next.authHash,
    encrypted_dek: wrapKey(material.dek, next.mek),
    encrypted_private_key: wrapKey(material.privateKey, next.mek),
    ...kdfToWire(newKdf),
    kdf_upgrade: true,
  };
}

/**
 * The phrase does not open the account's recovery blobs: a typo, another account's phrase, or the
 * server's anti-enumeration dummy, which are indistinguishable by design.
 */
export class RecoveryPhraseError extends Error {
  constructor(cause?: unknown) {
    super("the recovery phrase does not match this account", { cause });
    this.name = "RecoveryPhraseError";
  }
}

/**
 * Build the `POST /auth/recover` payload: recover the DEK and private key with the phrase, answer
 * the challenge (sealed to the recovery key, version 2, or for an account without one to its own
 * key, version 1), and re-wrap under the new password with `newKdf`. The salt is reused so the
 * recovery wraps stay valid. Throws {@link RecoveryPhraseError} on a wrong phrase.
 */
export async function buildRecoveryRequest(
  recoveryKeys: RecoveryKeysResponse,
  phrase: string,
  newPassword: string,
  email: string,
  newKdf: PasswordKdf,
): Promise<RecoverAccountPayload> {
  const { salt, recovery_encrypted_dek, recovery_encrypted_private_key, challenge } = recoveryKeys;
  if (!challenge) throw new Error("the server sent no recovery challenge");
  if (!salt || !recovery_encrypted_dek || !recovery_encrypted_private_key) {
    throw new RecoveryPhraseError();
  }

  let dek: Uint8Array;
  let privateKey: Uint8Array;
  let nonce: Uint8Array;
  try {
    const keys = deriveRecoveryKeys(phrase, salt);
    dek = unwrapKey(recovery_encrypted_dek, keys.wrapKey);
    privateKey = unwrapKey(recovery_encrypted_private_key, keys.wrapKey);
    const answeringKey = recoveryKeys.recovery_key_version === 2 ? keys.auth.secretKey : privateKey;
    nonce = unsealKey(challenge.sealed, answeringKey);
  } catch (err) {
    throw new RecoveryPhraseError(err);
  }

  const next = await deriveAuthAndMekAsync(newPassword, salt, newKdf);
  return {
    email,
    challenge_token: challenge.token,
    challenge_response: bytesToHex(nonce),
    new_auth_hash: next.authHash,
    encrypted_dek: wrapKey(dek, next.mek),
    encrypted_private_key: wrapKey(privateKey, next.mek),
    ...kdfToWire(newKdf),
  };
}

/**
 * Build the `PUT /auth/recovery-key` body for an account created before such keys. The phrase must
 * first open the recovery-wrapped DEK to this session's DEK, so a mistyped or foreign phrase can
 * never become the recovery key. Throws {@link RecoveryPhraseError} otherwise.
 */
export async function buildRecoveryKeyRegistration(
  recoveryKeys: RecoveryKeysResponse,
  material: Pick<E2eeKeyMaterial, "salt" | "kdf" | "dek">,
  phrase: string,
  currentPassword: string,
): Promise<RegisterRecoveryKeyPayload> {
  const blob = recoveryKeys.recovery_encrypted_dek;
  if (!blob) throw new RecoveryPhraseError();
  let recoveryPublicKey: string;
  try {
    const keys = deriveRecoveryKeys(phrase, material.salt);
    const dek = unwrapKey(blob, keys.wrapKey);
    if (!sameBytes(dek, material.dek)) throw new Error("the recovery blob holds another DEK");
    recoveryPublicKey = keys.auth.publicKey;
  } catch (err) {
    throw new RecoveryPhraseError(err);
  }
  const { authHash } = await deriveAuthAndMekAsync(currentPassword, material.salt, material.kdf);
  return { current_password: authHash, recovery_public_key: recoveryPublicKey };
}

/**
 * A new recovery phrase and the `POST /auth/recovery-key/replace` body registering it. Show
 * `phrase` only once the server accepted `payload`; the old phrase then stops working.
 */
export async function buildRecoveryPhraseReplacement(
  material: E2eeKeyMaterial,
  currentPassword: string,
): Promise<{ phrase: string; payload: ReplaceRecoveryKeyPayload }> {
  const phrase = generateRecoveryPhrase();
  const recovery = deriveRecoveryKeys(phrase, material.salt);
  const { authHash } = await deriveAuthAndMekAsync(currentPassword, material.salt, material.kdf);
  return {
    phrase,
    payload: {
      current_password: authHash,
      recovery_public_key: recovery.auth.publicKey,
      recovery_encrypted_dek: wrapKey(material.dek, recovery.wrapKey),
      recovery_encrypted_private_key: wrapKey(material.privateKey, recovery.wrapKey),
    },
  };
}

/**
 * Whether `password` is the account's current password, checked on this device alone: the MEK it
 * derives must open the session's password-wrapped DEK (AES-GCM refuses any other key) and, when
 * the session is unlocked, yield the very DEK in memory. For confirming a local action (a plaintext
 * export) without a server round trip; nothing new is stored.
 */
export async function verifyAccountPassword(
  material: { salt: string; kdf: PasswordKdf; encryptedDek: EncryptedPayload },
  password: string,
  unlockedDek?: Uint8Array,
): Promise<boolean> {
  const { mek } = await deriveAuthAndMekAsync(password, material.salt, material.kdf);
  let dek: Uint8Array;
  try {
    dek = unwrapKey(material.encryptedDek, mek);
  } catch {
    return false;
  }
  return unlockedDek === undefined || sameBytes(dek, unlockedDek);
}

/** Constant-time: a byte-by-byte early exit would time how much of a secret matched. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
