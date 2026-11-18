/**
 * Loading or creating the account's identity signing key after an unlock. The server stores one key
 * once (409 `signing_key_already_set`), so when two devices race the loser loads the winner's.
 */

import { apiErrorCode, type ApiClient, type SigningKeyProof } from "./api";
import { generateSigningKeypair, unwrapSigningKey, wrapSigningKey, type Keyring } from "./crypto";

export type SigningKeyTransport = Pick<ApiClient, "getSigningKey" | "putSigningKey">;

export interface EnsuredSigningKey {
  publicKey: string;
  secretKey: Uint8Array;
  created: boolean;
}

/**
 * Put the account's signing key into `keyring`: the one it holds, else the stored one (`stored`,
 * from the auth response or the session, then the server), else a new one this call uploads.
 * Throws when the stored key does not open under the DEK or does not match its public half: a new
 * key could not replace it anyway. A new key's upload needs `proof` (the credential just entered)
 * unless the session signed in within the last few minutes; without either it throws, and a later
 * unlock with the credential creates it.
 */
export async function ensureSigningKey(
  api: SigningKeyTransport,
  keyring: Keyring,
  stored?: { publicKey?: string | null; wrapped?: { iv: string; ct: string } | null },
  proof?: SigningKeyProof,
): Promise<EnsuredSigningKey> {
  const held = keyring.getSigningKey();
  if (held) return { publicKey: keyring.getSigningPublicKey()!, secretKey: held, created: false };

  const load = (publicKey: string, wrapped: { iv: string; ct: string }): EnsuredSigningKey => {
    const secretKey = unwrapSigningKey(wrapped, keyring.getDek(), publicKey);
    keyring.setSigningKey(secretKey);
    return { publicKey: keyring.getSigningPublicKey()!, secretKey, created: false };
  };
  if (stored?.publicKey && stored.wrapped) return load(stored.publicKey, stored.wrapped);

  const current = await api.getSigningKey();
  if (current.signing_public_key && current.encrypted_signing_key) {
    return load(current.signing_public_key, current.encrypted_signing_key);
  }

  const fresh = generateSigningKeypair();
  try {
    await api.putSigningKey(
      fresh.publicKey,
      wrapSigningKey(fresh.secretKey, keyring.getDek()),
      proof,
    );
  } catch (err) {
    if (apiErrorCode(err) !== "signing_key_already_set") throw err;
    // Another device stored one first: that one is the account's.
    const winner = await api.getSigningKey();
    if (!winner.signing_public_key || !winner.encrypted_signing_key) throw err;
    return load(winner.signing_public_key, winner.encrypted_signing_key);
  }
  keyring.setSigningKey(fresh.secretKey);
  return { publicKey: fresh.publicKey, secretKey: fresh.secretKey, created: true };
}
