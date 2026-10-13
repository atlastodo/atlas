/**
 * The persisted session shape shared by every client: a projection of the server's {@link
 * AuthResponse}, kept next to it so it cannot drift from the wire format. Storage is
 * platform-specific and lives in each app.
 */

import { kdfFromWire, type PasswordKdf, type RootKeyWrap } from "./crypto";
import type { AppKeyRow, AuthResponse, AuthUser } from "./types";

export interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  user: AuthUser;
  salt?: string;
  publicKey?: string;
  encryptedDek?: { iv: string; ct: string };
  encryptedPrivateKey?: { iv: string; ct: string };
  /**
   * The KDF whose MEK unwraps `encryptedDek` and `encryptedPrivateKey`, updated together with them.
   * Absent means version 1 (stored before per-account KDFs).
   */
  kdf?: PasswordKdf;
  signingPublicKey?: string;
  encryptedSigningKey?: { iv: string; ct: string };
  isE2ee?: boolean;
  /**
   * The account root key state (see `rootKey.ts`): whether the account has one (absent: unknown,
   * e.g. a server predating root keys), its password slot, the app keys under it, and what the
   * recovery slot needs. The unwrapped root is never stored; flows that need it re-open the
   * password slot with the password they ask for.
   */
  hasRootKey?: boolean;
  encryptedRootKey?: RootKeyWrap;
  appKeys?: AppKeyRow[];
  hasRecoveryRootKey?: boolean;
  recoveryPublicKey?: string;
  dek?: string;
  privateKey?: string;
  signingKey?: string;
}

/**
 * Whether this session's user is an administrator. A UI hint only: the server re-reads
 * `users.is_admin` on every `/admin/*` call. `=== true` because older sessions lack the field.
 */
export function isAdmin(session: Session | null | undefined): boolean {
  return session?.user.is_admin === true;
}

export function sessionFromAuth(auth: AuthResponse): Session {
  const session: Session = {
    accessToken: auth.access_token,
    refreshToken: auth.refresh_token,
    deviceId: auth.device_id,
    user: auth.user,
  };
  if (auth.salt !== undefined) session.salt = auth.salt;
  if (auth.public_key !== undefined) session.publicKey = auth.public_key;
  if (auth.encrypted_dek !== undefined) session.encryptedDek = auth.encrypted_dek;
  if (auth.encrypted_private_key !== undefined)
    session.encryptedPrivateKey = auth.encrypted_private_key;
  const kdf = authKdf(auth);
  if (kdf) session.kdf = kdf;
  if (auth.signing_public_key !== undefined) session.signingPublicKey = auth.signing_public_key;
  if (auth.encrypted_signing_key !== undefined)
    session.encryptedSigningKey = auth.encrypted_signing_key;
  if (auth.is_e2ee !== undefined) session.isE2ee = auth.is_e2ee;
  // A server that knows root keys always says whether the account has one; the slot and the app
  // keys are omitted when it has not.
  if (auth.has_root_key !== undefined) {
    session.hasRootKey = auth.has_root_key;
    session.appKeys = auth.app_keys ?? [];
    session.hasRecoveryRootKey = auth.has_recovery_root_key === true;
  }
  if (auth.encrypted_root_key !== undefined) session.encryptedRootKey = auth.encrypted_root_key;
  if (auth.recovery_public_key !== undefined) session.recoveryPublicKey = auth.recovery_public_key;
  return session;
}

/**
 * The KDF an auth response names, or null. Parameters this client would not run read as none: a
 * token rotation must not fail over them, and an unlock could not use them anyway.
 */
function authKdf(auth: AuthResponse): PasswordKdf | null {
  try {
    return kdfFromWire(auth.kdf_version, auth.kdf_params);
  } catch {
    return null;
  }
}

/**
 * Fold a token rotation into its session. Tokens, user, device id and key blobs follow the
 * response; the unwrapped keys stay because no auth response carries them. A response for a
 * different user starts from scratch.
 */
export function mergeRotatedTokens(prev: Session, auth: AuthResponse): Session {
  const rotated = sessionFromAuth(auth);
  if (rotated.user.id !== prev.user.id) return rotated;
  const next: Session = { ...prev, ...rotated };
  if (prev.publicKey !== undefined) next.publicKey = prev.publicKey;
  // The root went away (a client predating root keys changed the password): drop its stale slot.
  if (rotated.hasRootKey === false) delete next.encryptedRootKey;
  // Set once on the server, so a response issued before this device registered it is stale.
  if (prev.user.has_recovery_key === true) next.user = { ...next.user, has_recovery_key: true };
  return next;
}

/**
 * Whether the session carries the salt and password-wrapped blobs an unlock needs; without them
 * only a full sign-in works.
 */
export function hasWrappedKeys(session: Session): boolean {
  return Boolean(session.salt && session.encryptedDek && session.encryptedPrivateKey);
}

/**
 * Reconcile with a session another client sharing the storage (a browser tab) just wrote: `null` if
 * removed, `current` if unchanged, else the stored one, keeping this client's unwrapped keys when
 * the write lacks them for the same account.
 */
export function reconcileStoredSession(
  current: Session | null,
  stored: Session | null,
): Session | null {
  if (!stored) return null;
  if (!current || stored.user.id !== current.user.id) return stored;
  const gainsKeys = Boolean(stored.dek && !current.dek);
  if (stored.refreshToken === current.refreshToken && !gainsKeys) return current;
  if (stored.dek || !current.dek) return stored;
  const next: Session = { ...stored, dek: current.dek };
  if (current.privateKey !== undefined) next.privateKey = current.privateKey;
  if (current.publicKey !== undefined) next.publicKey = current.publicKey;
  if (current.signingKey !== undefined) next.signingKey = current.signingKey;
  return next;
}
