import "../lib/polyfillCrypto";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppSkeleton } from "../ui/AppSkeleton";
import { SkeletonGate } from "../ui/Skeleton";
import {
  ApiError,
  CURRENT_KDF,
  LEGACY_KDF,
  apiErrorCode,
  bytesToHex,
  buildE2eePasswordChange,
  buildKdfUpgrade,
  buildRecoveryKeyRegistration,
  buildRecoveryPhraseReplacement,
  buildRecoveryRequest,
  buildSignupRoot,
  deriveAuthAndMekAsync,
  deriveRecoveryKeys,
  ensureRootKey,
  ensureSigningKey,
  generateDek,
  generateRecoveryPhrase,
  generateSalt,
  generateSigningKeypair,
  generateUserKeypair,
  getPublicKey,
  hexToBytes,
  kdfForNewCredential,
  kdfFromWire,
  Keyring,
  mergeRotatedTokens,
  openAccountKeys,
  reconcileStoredSession,
  sameKdf,
  verifyAccountPassword,
  wrapKey,
  wrapSigningKey,
  addPasskey as addPasskeyFlow,
  buildPasskeySignup,
  openPasskeyAccountKeys,
  openTodoAppKey,
  reauthenticateWithPasskey,
  unwrapRootKey,
  withoutPrfOutput,
  PasskeyPrfUnsupportedError,
  type AccountKeys,
  type AccountProof,
  type ApiClient,
  type AuthResponse,
  type PasskeyAuthenticator,
  type PasskeyProof,
  type PasswordKdf,
  type RootKeyState,
  type TokenStore,
} from "@atlas/client-core";
import { createApiClient } from "../data/api";
import { deleteLocalData } from "../data/localData";
import {
  dropSession,
  readSession,
  refreshGrace,
  sessionFromAuth,
  subscribeSession,
  withRefreshLock,
  writeSession,
  type Session,
} from "./session";
import { setServerUrlOverride } from "./serverUrl";
import { ensureServerCompatible, ensurePasskeysOffered } from "./serverCompat";
import { getPasskeyAuthenticator } from "./passkeyAuthenticator";
import { readCachedSalt, writeCachedSalt } from "./saltCache";
import { cancelAllAppNotifications } from "../lib/notify";
import { detectDeviceName } from "../lib/deviceName";
import { getInstallKey } from "./installKey";

/**
 * Authentication state and a token-bound `ApiClient`.
 *
 * - Session storage and the server URL are async, so the provider shows a splash until they
 *   resolve. The client is built here because it binds `baseUrl` and the `tokenStore` at
 *   construction; the store re-persists a rotated refresh token (and shares it across tabs on web).
 * - A failed keychain write fails the sign-in: there is no plaintext fallback, and appearing signed
 *   in while losing the session on restart is worse. Token rotation has no user waiting, so a
 *   failed write there only warns.
 */
export interface AuthContextValue {
  session: Session | null;
  /**
   * Whether the persisted-session restore has finished. `session` is also `null` while restoring,
   * so anything acting on "no session" must wait for this, or a deep link into a gated area would
   * bounce a signed-in user on every cold load.
   */
  sessionRestored: boolean;
  /** A ready-to-use API client bound to the current session's tokens. */
  api: ApiClient;
  /**
   * The unlocked keys, or null. A session without a keyring is locked (restored without its
   * unwrapped keys) and must `unlock` before anything syncs; the client refuses to sync without
   * keys rather than push plaintext.
   */
  keyring: Keyring | null;
  recoveryPhrase: string | null;
  dismissRecoveryPhrase: () => void;
  /**
   * Persist a new server-URL override and rebuild the API client against it. Auth methods read the
   * client from a ref so they use the rebuilt one. Only meaningful before sign-in: a session is
   * bound to the server it authenticated against.
   */
  changeServerUrl: (url: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, displayName?: string, invite?: string) => Promise<void>;
  recoverAccount: (email: string, phrase: string, newPassword: string) => Promise<void>;
  /**
   * Register the phrase-derived recovery key of an account that has none yet
   * (`session.user.has_recovery_key === false`). The phrase is checked against the account's
   * recovery blob first and rejects with `RecoveryPhraseError`; a wrong password rejects with the
   * server's 403 `invalid_credentials`, and a key registered already with 409
   * `recovery_key_already_set` (after which the account no longer asks).
   */
  registerRecoveryKey: (phrase: string, password: string) => Promise<void>;
  /**
   * Replace the account's recovery phrase with a new one, after verifying the password (a wrong one
   * rejects with the server's 403 `invalid_credentials`). Resolves the new phrase once the server
   * holds it, for the caller to show once; the old phrase no longer recovers the account.
   */
  replaceRecoveryPhrase: (password: string | PasskeyProof) => Promise<string>;
  /**
   * Change the password, proven by the current one or a passkey (`confirmWithPasskey`); with a
   * passkey proof an account without a password gets one.
   */
  changePassword: (currentPassword: string | PasskeyProof, newPassword: string) => Promise<void>;
  /** Schedule the account's deletion; once the server accepts, sign out and delete the local data. */
  deleteAccount: (password: string | PasskeyProof) => Promise<void>;
  /**
   * This device's passkey support (a browser with WebAuthn, Android's Credential Manager), or null
   * (iOS, the desktop app). Whether the server offers passkeys is a separate question
   * (`serverOffersPasskeys`).
   */
  passkeyAuthenticator: PasskeyAuthenticator | null;
  /** Sign in with a passkey (discoverable; `email` names the account's passkeys instead). */
  loginWithPasskey: (email?: string) => Promise<void>;
  /** Sign up with a passkey instead of a password; the recovery phrase is shown as for any signup. */
  signupWithPasskey: (email: string, displayName?: string, invite?: string) => Promise<void>;
  /**
   * Confirm the account holder with one of the account's passkeys: a single-use proof for the
   * account-critical actions (five minutes), and the root key the passkey unlocked.
   */
  confirmWithPasskey: () => Promise<PasskeyProof>;
  /** Unlock a locked session with a passkey; resolves false when the passkey cannot unlock. */
  unlockWithPasskey: () => Promise<boolean>;
  /** Add a passkey, proven by the password or a passkey proof that unlocked the root key. */
  addPasskey: (name: string, proof: string | PasskeyProof) => Promise<void>;
  removePasskey: (id: string, proof: string | PasskeyProof) => Promise<void>;
  /** Make the account passkey-only (the server refuses unless a passkey remains). */
  removePassword: (proof: string | PasskeyProof) => Promise<void>;
  cancelAccountDeletion: (email: string, password: string) => Promise<void>;
  /**
   * Sign out and delete this device's copy of the user's data, unsynced changes included: callers
   * warn about those first (see `useSignOut`).
   */
  logout: () => Promise<void>;
  /**
   * Unlock a locked session with the account password: derive the MEK from the password and the
   * session's salt, unwrap the session's key blobs, persist the unwrapped keys and install the
   * keyring. Resolves `false` for a wrong password; throws when the session holds no blobs.
   */
  unlock: (password: string) => Promise<boolean>;
  /**
   * Whether `password` is the account password, checked on this device: it must derive the MEK that
   * opens the session's wrapped DEK, and that DEK must be the unlocked one. No server round trip,
   * so it works offline; throws when the session holds no wrapped keys to check against.
   */
  verifyPassword: (password: string) => Promise<boolean>;
  /**
   * The server refused this build's sync protocol (HTTP 426): the gate shows the update screen
   * instead of the app, and sync stays stopped until the app is updated.
   */
  upgradeRequired: boolean;
  /** Clear `upgradeRequired` to check again (native "Retry"): the next refusal sets it anew. */
  retryAfterUpgrade: () => void;
  /**
   * Why the server ended the last session, when it said: the sign-in screen shows it. Cleared by
   * the next session.
   */
  signOutNotice: SignOutNotice | null;
}

/** A server-side reason a session ended that the user needs to hear about. */
export interface SignOutNotice {
  code: "account_disabled" | "account_scheduled_deletion" | "account_deleted";
  /** Days left to cancel a scheduled deletion. */
  daysRemaining?: number;
}

/** The notice for a refused refresh, or null when the refusal says nothing the user can act on. */
function signOutNoticeFor(reason: ApiError | undefined): SignOutNotice | null {
  if (!reason || reason.status !== 403) return null;
  const code = apiErrorCode(reason) ?? reason.message;
  if (code === "account_scheduled_deletion") {
    const days = (reason.data as { days_remaining?: unknown } | undefined)?.days_remaining;
    return { code, daysRemaining: typeof days === "number" ? days : undefined };
  }
  if (code === "account_disabled" || code === "account_deleted") return { code };
  return null;
}

/** Exported so tests can supply a fake value instead of mocking secure-store and the network. */
export const AuthContext = createContext<AuthContextValue | null>(null);

/** What a password login sends (the derived auth hash) and the MEK that unwraps the account's keys. */
interface ResolvedCredential {
  authHash: string;
  mek: Uint8Array;
  /** The salt `authHash` was derived from. */
  salt: string;
  /** The KDF `authHash` was derived with. */
  kdf: PasswordKdf;
  /**
   * Whether the server named the account's KDF, and so stores one: a server that predates
   * per-account KDFs must never be asked to move an account to a newer one.
   */
  serverNamesKdf: boolean;
}

/**
 * The error for an account created before encryption, which cannot sign in any more. Shaped like
 * the server's own 403 for it, so the sign-in screen handles both with one branch.
 */
function legacyAccountError(): ApiError {
  return new ApiError(403, "legacy_account", { code: "legacy_account" });
}

/**
 * Resolve the credential for a password login (`login`, `deleteAccount`, `cancelAccountDeletion`):
 * derive the auth hash and MEK from the password with the account's salt and KDF. The password
 * itself is never sent — with no salt to derive from, the lookup's error is the answer.
 *
 * A cached salt and KDF (see `./saltCache`) let the expensive derivation start while `/auth/salt`
 * is still in flight; the fresh response still verifies them, and a mismatch (the account was
 * recreated, or moved to a newer KDF) costs one re-derivation.
 */
async function resolveLoginCredential(
  client: ApiClient,
  email: string,
  password: string,
): Promise<ResolvedCredential> {
  const cached = await readCachedSalt(email);
  const cachedKdf = cached?.kdf ?? LEGACY_KDF;
  const lookup = client.getSalt(email).then(
    (res) => ({ res, err: null }),
    (err: unknown) => ({ res: null, err }),
  );

  const derive = async (salt: string, kdf: PasswordKdf) => ({
    ...(await deriveAuthAndMekAsync(password, salt, kdf)),
    salt,
    kdf,
  });

  // With a cached salt the derivation is already running by the time the server answers.
  const cachedDerive = cached ? derive(cached.salt, cachedKdf) : null;
  const { res, err } = await lookup;

  let derived: Awaited<ReturnType<typeof derive>>;
  let serverNamesKdf = false;
  if (res) {
    if (!res.is_e2ee) throw legacyAccountError();
    // Throws for a KDF this client does not run (or parameters it refuses): no credential it could
    // derive would sign in.
    const named = kdfFromWire(res.kdf_version, res.kdf_params);
    serverNamesKdf = named !== null;
    const kdf = named ?? LEGACY_KDF;
    const cacheHolds = (!res.salt || res.salt === cached?.salt) && sameKdf(kdf, cachedKdf);
    if (cachedDerive && cacheHolds) derived = await cachedDerive;
    else if (res.salt) derived = await derive(res.salt, kdf);
    else throw new Error("the server sent no salt for this account");
  } else if (cachedDerive) {
    // The lookup only verifies a cached salt; the login call itself reports an unreachable server.
    derived = await cachedDerive;
  } else {
    throw err;
  }

  return { ...derived, serverNamesKdf };
}

/**
 * The salt and KDF the signed-in account's current credential derives with, and the KDF a new
 * credential gets (see `kdfForNewCredential`), for a request that proves the password. Asked fresh
 * rather than taken from the session: another device may have moved the account to a newer KDF
 * since this session last heard from the server.
 */
async function accountCredentialKdf(
  client: ApiClient,
  session: Session,
): Promise<{ salt: string; kdf: PasswordKdf; newKdf: PasswordKdf }> {
  const res = await client.getSalt(session.user.email);
  const salt = session.salt ?? res.salt;
  if (!salt) throw new Error("missing E2EE salt for the account");
  return {
    salt,
    kdf: kdfFromWire(res.kdf_version, res.kdf_params) ?? LEGACY_KDF,
    newKdf: kdfForNewCredential(res),
  };
}

/**
 * The proof an account-critical request carries: the auth hash a password derives (as at login),
 * or a passkey proof's single-use token.
 */
async function accountProofOf(
  client: ApiClient,
  session: Session,
  proof: string | PasskeyProof,
): Promise<AccountProof> {
  if (typeof proof !== "string") return { reauth_token: proof.reauthToken };
  const { authHash } = await resolveLoginCredential(client, session.user.email, proof);
  return { current_password: authHash };
}

/** What a session knows about the account root key, as `ensureRootKey` takes it. */
function rootStateOf(session: Session): RootKeyState {
  return {
    hasRootKey: session.hasRootKey,
    encryptedRootKey: session.encryptedRootKey,
    appKeys: session.appKeys,
    hasRecoveryRootKey: session.hasRecoveryRootKey,
    recoveryPublicKey: session.recoveryPublicKey,
  };
}

/**
 * The state after a credential write that carried no root slot: the server dropped the root
 * (see `root_key::drop_for_legacy_write`), and the next sign-in re-creates it.
 */
const DROPPED_ROOT: RootKeyState = { hasRootKey: false, appKeys: [], hasRecoveryRootKey: false };

/** A session with `state` folded in; a root that went away takes its slot with it. */
function withRootState(session: Session, state: RootKeyState): Session {
  const next: Session = { ...session, ...state };
  if (state.hasRootKey === false) delete next.encryptedRootKey;
  return next;
}

/**
 * The root key state for a flow that re-wraps it (password change, phrase replacement): asked
 * fresh, since another device may have migrated the account since this session last heard; the
 * session's copy when the server cannot say (offline, or it predates root keys).
 */
async function currentRootState(client: ApiClient, session: Session): Promise<RootKeyState> {
  try {
    const res = await client.getRootKey();
    return {
      hasRootKey: res.has_root_key,
      encryptedRootKey: res.encrypted_root_key ?? undefined,
      appKeys: res.app_keys,
      hasRecoveryRootKey: res.has_recovery_root_key,
      recoveryPublicKey: res.recovery_public_key ?? undefined,
    };
  } catch {
    return rootStateOf(session);
  }
}

/**
 * The account's keys from a sign-in response: through the root key when the account has one,
 * else the legacy MEK wraps (`openAccountKeys`). Throws when neither opens.
 */
function openAuthKeys(auth: AuthResponse, mek: Uint8Array): AccountKeys {
  return openAccountKeys({
    userId: auth.user.id,
    mek,
    encryptedRootKey: auth.encrypted_root_key,
    appKeys: auth.app_keys,
    encryptedDek: auth.encrypted_dek,
    encryptedPrivateKey: auth.encrypted_private_key,
  });
}

function keyringOf(keys: AccountKeys, publicKey: string | undefined): Keyring {
  return new Keyring({ dek: keys.dek, privateKey: keys.privateKey, publicKey });
}

/** The keyring a persisted session's unwrapped keys make, or null when it holds none (locked). */
function keyringFromSession(session: Session | null): Keyring | null {
  if (!session?.dek) return null;
  try {
    return new Keyring({
      dek: hexToBytes(session.dek),
      privateKey: session.privateKey ? hexToBytes(session.privateKey) : undefined,
      publicKey: session.publicKey,
      signingKey: session.signingKey ? hexToBytes(session.signingKey) : undefined,
    });
  } catch (e) {
    console.warn("[atlas-e2ee] could not restore keyring from session:", e);
    return null;
  }
}

export function AuthProvider({
  children,
  wipeLocalData = deleteLocalData,
}: {
  children: ReactNode;
  /** Deletes a user's local database on sign-out and account deletion (injectable for tests). */
  wipeLocalData?: (userId: string) => Promise<void>;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [api, setApi] = useState<ApiClient | null>(null);
  const [keyring, setKeyring] = useState<Keyring | null>(null);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [signOutNotice, setSignOutNotice] = useState<SignOutNotice | null>(null);
  const flagUpgradeRequired = useCallback(() => setUpgradeRequired(true), []);
  const retryAfterUpgrade = useCallback(() => setUpgradeRequired(false), []);

  const dismissRecoveryPhrase = useCallback(() => {
    setRecoveryPhrase(null);
  }, []);

  // Session and keyring live in refs as well as state. The client's callbacks are bound once, and
  // anything that awaited must merge into the session as it is now; a stale closure would write
  // old tokens back.
  const sessionRef = useRef<Session | null>(null);
  const keyringRef = useRef<Keyring | null>(null);

  // The client too, so auth methods see a rebuilt one before React re-renders.
  const apiRef = useRef<ApiClient | null>(null);

  const installClient = useCallback((client: ApiClient) => {
    apiRef.current = client;
    setApi(client);
  }, []);

  const commitSession = useCallback((next: Session | null) => {
    sessionRef.current = next;
    setSession(next);
    if (next) setSignOutNotice(null);
  }, []);

  const commitKeyring = useCallback((next: Keyring | null) => {
    keyringRef.current = next;
    apiRef.current?.setKeyring(next);
    setKeyring(next);
  }, []);

  /** Wipe the keys from memory and drop the in-memory session (the storage is the caller's). */
  const clearLocalSession = useCallback(() => {
    const client = apiRef.current;
    client?.setTokens(undefined, undefined);
    keyringRef.current?.clear();
    commitKeyring(null);
    commitSession(null);
    setRecoveryPhrase(null);
    // Booked notifications hold this user's plaintext titles; none may outlive the session.
    void cancelAllAppNotifications();
  }, [commitKeyring, commitSession]);

  // Persist tokens the client rotated, merged into the current session so the unwrapped keys
  // survive (a refresh response never carries them). Stable, so the client is constructed once.
  const applyAuth = useCallback(
    async (auth: AuthResponse) => {
      const prev = sessionRef.current;
      // Signed out while the rotation was in flight: never resurrect the session.
      if (!prev) return;
      const next = mergeRotatedTokens(prev, auth);
      commitSession(next);
      try {
        await writeSession(next);
      } catch (err) {
        // The in-memory session still works for this run; only a restart would lose it.
        console.warn("[atlas] could not persist rotated tokens:", err);
      }
    },
    [commitSession],
  );

  // Take over the session another tab (web) wrote: its rotated tokens, its unlock, its sign-in --
  // or its sign-out. Tokens are installed explicitly, never from render.
  const adoptStoredSession = useCallback(
    (stored: Session | null) => {
      const current = sessionRef.current;
      const next = reconcileStoredSession(current, stored);
      if (next === current) return;
      if (!next) {
        clearLocalSession();
        return;
      }
      apiRef.current?.setTokens(next.accessToken, next.refreshToken);
      if (current?.user.id !== next.user.id) {
        keyringRef.current?.clear();
        commitKeyring(keyringFromSession(next));
      } else if (!keyringRef.current?.hasKeys()) {
        commitKeyring(keyringFromSession(next));
      }
      commitSession(next);
    },
    [clearLocalSession, commitKeyring, commitSession],
  );

  // The refresh token was rejected, so no credential is left: end the session and show the login
  // screen, rather than retrying against a dead token and tripping the auth rate limit.
  //
  // Storage is only dropped while it still holds the dead token: another tab that rotated in the
  // meantime owns a live pair, and dropping it would sign every tab out (they follow removals). A
  // stored token this client already presented is no such pair: it is spent, and presenting it
  // again would read as theft.
  const endSession = useCallback(
    (reason?: ApiError) => {
      const dead = sessionRef.current?.refreshToken;
      void (async () => {
        const stored = await readSession().catch(() => null);
        const presented = stored ? apiRef.current?.hasPresented(stored.refreshToken) : false;
        if (stored && stored.refreshToken !== dead && !presented) {
          adoptStoredSession(stored);
          return;
        }
        await dropSession().catch(() => {});
        clearLocalSession();
        setSignOutNotice(signOutNoticeFor(reason));
      })();
    },
    [adoptStoredSession, clearLocalSession],
  );

  // How the client rotates tokens: re-read storage, rotate under the cross-tab lock (web), and
  // persist the merged session before the lock is released (`applyAuth`).
  const tokenStore = useMemo<TokenStore>(
    () => ({
      read: async () => {
        const stored = await readSession();
        return stored && { accessToken: stored.accessToken, refreshToken: stored.refreshToken };
      },
      write: applyAuth,
      withRefreshLock,
      refreshGrace,
    }),
    [applyAuth],
  );

  useEffect(() => subscribeSession(adoptStoredSession), [adoptStoredSession]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readSession();
      // Null when the stored session holds no unwrapped keys: the gate then asks to unlock.
      const restoredKeyring = keyringFromSession(stored);
      const client = await createApiClient({
        token: stored?.accessToken,
        refreshToken: stored?.refreshToken,
        keyring: restoredKeyring,
        tokenStore,
        onAuthExpired: endSession,
        onUpgradeRequired: flagUpgradeRequired,
      });
      if (cancelled) return;
      installClient(client);
      commitSession(stored);
      commitKeyring(restoredKeyring);
      setSessionRestored(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [tokenStore, endSession, flagUpgradeRequired, installClient, commitSession, commitKeyring]);

  /** Persist the server override, then rebuild the client (which re-resolves the URL from storage). */
  const changeServerUrl = useCallback(
    async (url: string) => {
      await setServerUrlOverride(url);
      installClient(
        await createApiClient({
          tokenStore,
          onAuthExpired: endSession,
          onUpgradeRequired: flagUpgradeRequired,
        }),
      );
    },
    [tokenStore, endSession, flagUpgradeRequired, installClient],
  );

  // Refresh the stored user once per cold start.
  const userId = session?.user.id;
  useEffect(() => {
    if (!api || !userId) return;
    let cancelled = false;
    void api
      .me()
      .then((user) => {
        if (cancelled) return;
        const prev = sessionRef.current;
        if (!prev || prev.user.id !== user.id) return;
        // Set once on the server: an answer computed before this device registered it is stale.
        const hasRecoveryKey = prev.user.has_recovery_key === true || user.has_recovery_key;
        if (
          prev.user.is_admin === user.is_admin &&
          prev.user.has_recovery_key === hasRecoveryKey &&
          prev.user.has_password === user.has_password
        ) {
          return;
        }
        const next = { ...prev, user: { ...user, has_recovery_key: hasRecoveryKey } };
        commitSession(next);
        void writeSession(next).catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, userId, commitSession]);

  /**
   * Move an account that signed in with an older KDF to the current one: re-wrap the DEK and
   * private key under the new MEK and have the server swap both (`buildKdfUpgrade`). The server
   * applies it atomically, so a failure leaves the old KDF working and the next sign-in retries.
   */
  const upgradeKdf = useCallback(
    async (
      client: ApiClient,
      email: string,
      userId: string,
      password: string,
      credential: ResolvedCredential,
      keys: { dek: Uint8Array; privateKey: Uint8Array; rootKey: Uint8Array | null },
    ) => {
      let payload: Awaited<ReturnType<typeof buildKdfUpgrade>>;
      try {
        payload = await buildKdfUpgrade(
          {
            salt: credential.salt,
            dek: keys.dek,
            privateKey: keys.privateKey,
            ...(keys.rootKey ? { root: { userId, rootKey: keys.rootKey } } : {}),
          },
          password,
          credential.authHash,
        );
        await client.changePassword(payload);
      } catch (err) {
        console.warn("[atlas-kdf] could not move the account to the current KDF:", err);
        return;
      }
      void writeCachedSalt(email, { salt: credential.salt, kdf: CURRENT_KDF });
      // Into the session as it is now: the request may have rotated the tokens.
      const current = sessionRef.current;
      if (!current || current.user.id !== userId) return;
      let next: Session = {
        ...current,
        encryptedDek: payload.encrypted_dek,
        encryptedPrivateKey: payload.encrypted_private_key,
        kdf: CURRENT_KDF,
      };
      if (payload.encrypted_root_key) next.encryptedRootKey = payload.encrypted_root_key;
      // Without the root slot the server dropped the root; the next sign-in re-creates it.
      else if (current.hasRootKey) next = withRootState(next, DROPPED_ROOT);
      commitSession(next);
      try {
        await writeSession(next);
      } catch (err) {
        // The stored blobs still open with the old KDF, which the session then still names.
        console.warn("[atlas-kdf] could not persist the upgraded key blobs:", err);
      }
    },
    [commitSession],
  );

  /** Fold a root key state into the session as it is now, and persist it. */
  const applyRootState = useCallback(
    async (userId: string, state: RootKeyState) => {
      const current = sessionRef.current;
      if (!current || current.user.id !== userId) return;
      const next = withRootState(current, state);
      commitSession(next);
      await writeSession(next).catch((err) =>
        console.warn("[atlas-root] could not persist the root key state:", err),
      );
    },
    [commitSession],
  );

  /**
   * After the password proved itself (sign-in or unlock): migrate an account without a root key,
   * or fill its empty recovery slot (`ensureRootKey`). Best effort, since the account works on
   * the legacy wraps meanwhile and the next sign-in retries. Resolves the root key, when known.
   */
  const settleRootKey = useCallback(
    async (
      client: ApiClient,
      userId: string,
      credential: { authHash: string; mek: Uint8Array },
      keys: AccountKeys,
      state: RootKeyState,
    ): Promise<Uint8Array | null> => {
      try {
        const result = await ensureRootKey(client, {
          userId,
          authHash: credential.authHash,
          mek: credential.mek,
          dek: keys.dek,
          privateKey: keys.privateKey,
          rootKey: keys.rootKey,
          state,
        });
        if (!result) return keys.rootKey;
        await applyRootState(userId, result.state);
        return result.rootKey;
      } catch (err) {
        console.warn("[atlas-root] could not bring the account root key up to date:", err);
        return keys.rootKey;
      }
    },
    [applyRootState],
  );
  // Load the identity signing key: from the session's wrapped copy, else fetched, else created and
  // uploaded once. Retried with the next keyring if it fails (offline, say).
  useEffect(() => {
    if (!api || !keyring?.hasKeys() || keyring.getSigningKey()) return;
    let cancelled = false;
    const current = sessionRef.current;
    void ensureSigningKey(api, keyring, {
      publicKey: current?.signingPublicKey,
      wrapped: current?.encryptedSigningKey,
    })
      .then(async ({ publicKey, secretKey }) => {
        const prev = sessionRef.current;
        if (cancelled || !prev || keyringRef.current !== keyring) return;
        const next: Session = {
          ...prev,
          signingPublicKey: publicKey,
          signingKey: bytesToHex(secretKey),
        };
        commitSession(next);
        await writeSession(next).catch((err) =>
          console.warn("[atlas] could not persist the signing key:", err),
        );
      })
      .catch((err) => {
        // A superseded keyring (logout, lock, unmount) retries on its own; its failure is stale.
        if (!cancelled) console.warn("[atlas-e2ee] could not load the signing key:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [api, keyring, commitSession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const client = apiRef.current;
      if (!client) return;
      // A server too old for this app fails here with a clear error, before any credential work.
      await ensureServerCompatible(client);
      const normalizedEmail = email.trim().toLowerCase();

      // Signing in over a session that cannot unlock (the unlock screen's fallback): end its device
      // family on the server first, so its tokens do not stay live next to the new session's.
      const previous = sessionRef.current;
      if (previous) {
        await client.logout(previous.refreshToken).catch(() => {});
        client.setTokens(undefined, undefined);
      }

      const credential = await resolveLoginCredential(client, normalizedEmail, password);
      const deviceName = await detectDeviceName().catch(() => undefined);
      const installKey = await getInstallKey();

      const auth = await client.login(normalizedEmail, credential.authHash, deviceName, installKey);

      // The salt and KDF that produced the credential we just logged in with — safe to cache.
      void writeCachedSalt(normalizedEmail, { salt: credential.salt, kdf: credential.kdf });

      // Every account that can sign in has wrapped keys; one without them predates encryption.
      if (!auth.encrypted_dek || !auth.encrypted_private_key) throw legacyAccountError();
      const keys = openAuthKeys(auth, credential.mek);
      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(keys.dek);
      next.privateKey = bytesToHex(keys.privateKey);
      // The blobs just opened with this KDF's key, whatever the response named.
      next.kdf = credential.kdf;

      await writeSession(next);

      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(keyringOf(keys, auth.public_key));
      commitSession(next);

      // Before a KDF upgrade: the migration proves the credential this sign-in derived, and the
      // upgrade then re-wraps the root it made.
      const rootKey = await settleRootKey(
        client,
        next.user.id,
        credential,
        keys,
        rootStateOf(next),
      );
      if (credential.serverNamesKdf && credential.kdf.version < CURRENT_KDF.version) {
        await upgradeKdf(client, normalizedEmail, next.user.id, password, credential, {
          ...keys,
          rootKey,
        });
      }
    },
    [commitKeyring, commitSession, upgradeKdf, settleRootKey],
  );

  const signup = useCallback(
    async (email: string, password: string, displayName = "", invite?: string) => {
      const client = apiRef.current;
      if (!client) return;
      await ensureServerCompatible(client);
      const normalizedEmail = email.trim().toLowerCase();
      // The lookup says whether this server stores a KDF per account (an unknown address gets the
      // current one); one that does not needs a version-1 credential.
      const kdf = kdfForNewCredential(await client.getSalt(normalizedEmail));
      const salt = generateSalt();
      const { authHash, mek } = await deriveAuthAndMekAsync(password, salt, kdf);
      const dek = generateDek();
      const keypair = generateUserKeypair();
      const signing = generateSigningKeypair();
      const phrase = generateRecoveryPhrase();
      const recovery = deriveRecoveryKeys(phrase, salt);

      const encryptedDek = wrapKey(dek, mek);
      const encryptedPrivateKey = wrapKey(keypair.secretKey, mek);
      const recoveryEncryptedDek = wrapKey(dek, recovery.wrapKey);
      const recoveryEncryptedPrivateKey = wrapKey(keypair.secretKey, recovery.wrapKey);
      // The account root key over the DEK; the legacy wraps above stay for older clients.
      const root = buildSignupRoot({
        mek,
        recoveryWrapKey: recovery.wrapKey,
        dek,
        privateKey: keypair.secretKey,
      });

      const deviceName = await detectDeviceName().catch(() => undefined);
      const installKey = await getInstallKey();

      const auth = await client.signup({
        email: normalizedEmail,
        password: authHash,
        displayName,
        invite,
        deviceName,
        installKey,
        salt,
        publicKey: keypair.publicKey,
        recoveryPublicKey: recovery.auth.publicKey,
        encryptedDek,
        encryptedPrivateKey,
        recoveryEncryptedDek,
        recoveryEncryptedPrivateKey,
        kdf,
        signingPublicKey: signing.publicKey,
        encryptedSigningKey: wrapSigningKey(signing.secretKey, dek),
        root,
      });
      void writeCachedSalt(normalizedEmail, { salt, kdf });

      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(dek);
      next.privateKey = bytesToHex(keypair.secretKey);
      next.kdf = kdf;
      next.signingKey = bytesToHex(signing.secretKey);

      const activeKeyring = new Keyring({
        dek,
        privateKey: keypair.secretKey,
        publicKey: keypair.publicKey,
        signingKey: signing.secretKey,
      });

      await writeSession(next);
      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(activeKeyring);
      setRecoveryPhrase(phrase);
      commitSession(next);
    },
    [commitKeyring, commitSession],
  );

  /** Record that the account's recovery key is registered, in the session as it is now. */
  const markRecoveryKeyRegistered = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.user.has_recovery_key === true) return;
    const next: Session = { ...current, user: { ...current.user, has_recovery_key: true } };
    commitSession(next);
    try {
      await writeSession(next);
    } catch (err) {
      console.warn("[atlas] could not persist the recovery-key flag:", err);
    }
  }, [commitSession]);

  const recoverAccount = useCallback(
    async (email: string, phrase: string, newPassword: string) => {
      const client = apiRef.current;
      if (!client) return;
      const normalizedEmail = email.trim().toLowerCase();
      const newKdf = kdfForNewCredential(await client.getSalt(normalizedEmail));
      const recKeys = await client.getRecoveryKeys(normalizedEmail);
      // Throws RecoveryPhraseError for a phrase that cannot open the blobs, before any POST.
      const payload = await buildRecoveryRequest(
        recKeys,
        phrase,
        newPassword,
        normalizedEmail,
        newKdf,
      );
      await client.recoverAccount(payload);
      await login(normalizedEmail, newPassword);
      // A version-1 account answered with its device key; with the phrase at hand, register the
      // phrase-derived key so recovery answers to the phrase alone from now on. Best effort: the
      // account is recovered either way, and the confirmation prompt asks again if this fails.
      if (recKeys.recovery_key_version === 1 && recKeys.salt) {
        try {
          await client.registerRecoveryKey({
            current_password: payload.new_auth_hash,
            recovery_public_key: deriveRecoveryKeys(phrase, recKeys.salt).auth.publicKey,
          });
          await markRecoveryKeyRegistered();
        } catch (err) {
          console.warn("[atlas] could not register the recovery key after recovery:", err);
        }
      }
    },
    [login, markRecoveryKeyRegistered],
  );

  const registerRecoveryKey = useCallback(
    async (phrase: string, password: string) => {
      const client = apiRef.current;
      const current = sessionRef.current;
      const keyring = keyringRef.current;
      if (!client || !current || !keyring?.hasKeys()) {
        throw new Error("unlock the session before confirming the recovery phrase");
      }
      const { salt, kdf } = await accountCredentialKdf(client, current);
      const recoveryKeys = await client.getRecoveryKeys(current.user.email);
      const body = await buildRecoveryKeyRegistration(
        recoveryKeys,
        { salt, kdf, dek: keyring.getDek() },
        phrase,
        password,
      );
      try {
        await client.registerRecoveryKey(body);
      } catch (err) {
        // Set once, to another key: asking again could never succeed.
        if (apiErrorCode(err) === "recovery_key_already_set") await markRecoveryKeyRegistered();
        throw err;
      }
      await markRecoveryKeyRegistered();
      // The root key's recovery slot can now be sealed to this key: the next sign-in or unlock
      // does it (`ensureRootKey`), with the password it proves.
      if (current.hasRootKey && !current.hasRecoveryRootKey) {
        await applyRootState(current.user.id, {
          recoveryPublicKey: body.recovery_public_key,
          hasRecoveryRootKey: false,
        });
      }
    },
    [markRecoveryKeyRegistered, applyRootState],
  );

  const replaceRecoveryPhrase = useCallback(
    async (password: string | PasskeyProof) => {
      const client = apiRef.current;
      const current = sessionRef.current;
      const keyring = keyringRef.current;
      const privateKey = keyring?.getPrivateKey();
      if (!client || !current || !keyring?.hasKeys() || !privateKey) {
        throw new Error("unlock the session before replacing the recovery phrase");
      }
      const { salt, kdf } = await accountCredentialKdf(client, current);
      const rootState = await currentRootState(client, current);
      const { phrase, payload } = await buildRecoveryPhraseReplacement(
        {
          salt,
          kdf,
          dek: keyring.getDek(),
          privateKey,
          root:
            typeof password !== "string" && password.rootKey
              ? { userId: current.user.id, rootKey: password.rootKey }
              : rootState.encryptedRootKey
                ? { userId: current.user.id, encryptedRootKey: rootState.encryptedRootKey }
                : undefined,
        },
        password,
      );
      await client.replaceRecoveryKey(payload);
      // The account now has a phrase-derived recovery key, whether or not it had one before.
      await markRecoveryKeyRegistered();
      // The old phrase's root slot is gone; the new one holds the root when it could be opened.
      await applyRootState(current.user.id, {
        ...rootState,
        recoveryPublicKey: payload.recovery_public_key,
        hasRecoveryRootKey: payload.recovery_encrypted_root_key !== undefined,
      });
      return phrase;
    },
    [markRecoveryKeyRegistered, applyRootState],
  );

  /**
   * Delete the signed-out user's local database: it holds their synced data decrypted. Runs after
   * the session is cleared, so the store has let go of it.
   */
  const wipe = useCallback(
    async (userId: string | undefined) => {
      if (!userId) return;
      await wipeLocalData(userId).catch((err) =>
        console.warn("[atlas] could not delete the local data:", err),
      );
    },
    [wipeLocalData],
  );

  /** Sign out and delete this device's copy of the user's data (the UI warns about unsynced changes first). */
  const logout = useCallback(async () => {
    const userId = sessionRef.current?.user.id;
    try {
      await apiRef.current?.logout();
    } finally {
      await dropSession().catch(() => {});
      clearLocalSession();
      await wipe(userId);
    }
  }, [clearLocalSession, wipe]);

  /**
   * Rotate the account's password. `buildE2eePasswordChange` re-wraps the DEK and private key under
   * the new MEK so the server swaps hash and blobs atomically. The raw keys are unchanged, so the
   * keyring stays valid.
   */
  const changePassword = useCallback(
    async (currentPassword: string | PasskeyProof, newPassword: string) => {
      const client = apiRef.current;
      if (!client || !session) return;
      // The re-wrap needs the session's key material (restored on every login/signup/unlock); a
      // session without it cannot re-wrap.
      if (!session.dek || !session.privateKey) {
        throw new Error("sign in again to change the password: key material is missing");
      }
      // The current credential derives with the account's KDF; the new one with the current KDF.
      const { salt, kdf, newKdf } = await accountCredentialKdf(client, session);
      const rootState = await currentRootState(client, session);
      const passkey = typeof currentPassword === "string" ? null : currentPassword;
      const payload = await buildE2eePasswordChange(
        {
          salt,
          kdf,
          dek: hexToBytes(session.dek),
          privateKey: hexToBytes(session.privateKey),
          // A passkey proof brings the root itself; a password opens the password slot.
          root: passkey?.rootKey
            ? { userId: session.user.id, rootKey: passkey.rootKey }
            : rootState.encryptedRootKey
              ? { userId: session.user.id, encryptedRootKey: rootState.encryptedRootKey }
              : undefined,
        },
        currentPassword,
        newPassword,
        newKdf,
      );
      // Sent as built: `new_password` must stay the derived hash login will send, and the server
      // names the device from the access token.
      await client.changePassword(payload);
      void writeCachedSalt(session.user.email, { salt, kdf: newKdf });
      // Persist the re-wrapped blobs into the session as it is now (the request may have rotated
      // the tokens); the raw keys and the salt are unchanged.
      const current = sessionRef.current;
      if (!current) return;
      const next: Session = withRootState(
        {
          ...current,
          // A passkey-only account has a password from now on.
          user: { ...current.user, has_password: true },
          encryptedDek: payload.encrypted_dek,
          encryptedPrivateKey: payload.encrypted_private_key,
          kdf: newKdf,
        },
        // Without a root slot in the request the server dropped the root (re-created at the next
        // sign-in); with one, the slot moved to the new password.
        payload.encrypted_root_key
          ? { ...rootState, encryptedRootKey: payload.encrypted_root_key }
          : rootState.hasRootKey
            ? DROPPED_ROOT
            : {},
      );
      await writeSession(next);
      commitSession(next);
    },
    [session, commitSession],
  );

  /**
   * Schedule account deletion. The password is verified server-side, so the credential resolves as
   * at login. The session is torn down only after the server accepts, so a typo leaves the user
   * signed in.
   */
  const deleteAccount = useCallback(
    async (password: string | PasskeyProof) => {
      const client = apiRef.current;
      if (!client || !session) return;
      await client.deleteAccount(await accountProofOf(client, session, password));
      await dropSession().catch(() => {});
      clearLocalSession();
      // The account is gone: nothing of it stays on the device, synced or not.
      await wipe(session.user.id);
    },
    [session, clearLocalSession, wipe],
  );

  const cancelAccountDeletion = useCallback(
    async (email: string, password: string) => {
      const client = apiRef.current;
      if (!client) return;
      const normalizedEmail = email.trim().toLowerCase();
      const { authHash, mek, kdf } = await resolveLoginCredential(
        client,
        normalizedEmail,
        password,
      );

      const auth = await client.cancelAccountDeletion({
        email: normalizedEmail,
        password: authHash,
        install_key: await getInstallKey(),
      });
      if (!auth.encrypted_dek || !auth.encrypted_private_key) throw legacyAccountError();
      const keys = openAuthKeys(auth, mek);
      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(keys.dek);
      next.privateKey = bytesToHex(keys.privateKey);
      next.kdf = kdf;

      await writeSession(next);
      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(keyringOf(keys, auth.public_key));
      commitSession(next);
      await settleRootKey(client, next.user.id, { authHash, mek }, keys, rootStateOf(next));
    },
    [commitKeyring, commitSession, settleRootKey],
  );

  const unlock = useCallback(
    async (password: string): Promise<boolean> => {
      const locked = sessionRef.current;
      if (!locked?.salt || !locked.encryptedDek || !locked.encryptedPrivateKey) {
        throw new Error("this session holds no wrapped keys; sign in again");
      }
      // The session keeps the KDF with the blobs; one stored before it did holds version-1 blobs.
      const credential = await deriveAuthAndMekAsync(
        password,
        locked.salt,
        locked.kdf ?? LEGACY_KDF,
      );
      let keys: AccountKeys;
      try {
        keys = openAccountKeys({
          userId: locked.user.id,
          mek: credential.mek,
          encryptedRootKey: locked.encryptedRootKey,
          appKeys: locked.appKeys,
          encryptedDek: locked.encryptedDek,
          encryptedPrivateKey: locked.encryptedPrivateKey,
        });
      } catch {
        return false; // AES-GCM refuses a key derived from the wrong password
      }
      const { dek, privateKey } = keys;
      // Merge into the session as it is now: tokens may have rotated during the derivation.
      const current = sessionRef.current;
      if (!current || current.user.id !== locked.user.id) return true; // signed out meanwhile
      const publicKey = current.publicKey ?? getPublicKey(privateKey);
      const next: Session = {
        ...current,
        publicKey,
        dek: bytesToHex(dek),
        privateKey: bytesToHex(privateKey),
      };
      try {
        await writeSession(next);
      } catch (err) {
        // Unlocked for this run regardless; the next cold start asks again.
        console.warn("[atlas] could not persist the unlocked keys:", err);
      }
      commitKeyring(new Keyring({ dek, privateKey, publicKey }));
      commitSession(next);
      // Migrate (or repair) the root key in the background: an unlock may well be offline.
      const client = apiRef.current;
      if (client) {
        void settleRootKey(client, next.user.id, credential, keys, rootStateOf(next));
      }
      return true;
    },
    [commitKeyring, commitSession, settleRootKey],
  );

  const verifyPassword = useCallback(async (password: string): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current?.salt || !current.encryptedDek) {
      throw new Error("this session holds no wrapped keys to check the password against");
    }
    const keyring = keyringRef.current;
    return verifyAccountPassword(
      { salt: current.salt, kdf: current.kdf ?? LEGACY_KDF, encryptedDek: current.encryptedDek },
      password,
      keyring?.hasKeys() ? keyring.getDek() : undefined,
    );
  }, []);

  // --- Passkeys ------------------------------------------------------------------------------

  const passkeyAuthenticator = useMemo(() => getPasskeyAuthenticator(), []);

  const requireAuthenticator = useCallback((): PasskeyAuthenticator => {
    if (!passkeyAuthenticator) throw new Error("this device cannot use passkeys");
    return passkeyAuthenticator;
  }, [passkeyAuthenticator]);

  /** Install a session a passkey opened, as a password sign-in or signup does. */
  const adoptPasskeySession = useCallback(
    async (client: ApiClient, auth: AuthResponse, keys: AccountKeys, signingKey?: Uint8Array) => {
      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(keys.dek);
      next.privateKey = bytesToHex(keys.privateKey);
      if (signingKey) next.signingKey = bytesToHex(signingKey);
      await writeSession(next);
      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(
        new Keyring({
          dek: keys.dek,
          privateKey: keys.privateKey,
          publicKey: auth.public_key,
          signingKey,
        }),
      );
      commitSession(next);
    },
    [commitKeyring, commitSession],
  );

  const loginWithPasskey = useCallback(
    async (email?: string) => {
      const client = apiRef.current;
      if (!client) return;
      const authenticator = requireAuthenticator();
      await ensureServerCompatible(client);
      await ensurePasskeysOffered(client);
      const previous = sessionRef.current;
      if (previous) {
        await client.logout(previous.refreshToken).catch(() => {});
        client.setTokens(undefined, undefined);
      }
      const options = await client.passkeyLoginOptions(email?.trim().toLowerCase() || undefined);
      const got = await authenticator.get(options);
      // Without the PRF output the passkey could sign in but never unlock: refuse before the server.
      if (!got.prfOutput) throw new PasskeyPrfUnsupportedError();
      const auth = await client.passkeyLogin({
        credential: withoutPrfOutput(got.credential, false),
        deviceName: await detectDeviceName().catch(() => undefined),
        installKey: await getInstallKey(),
      });
      let keys: AccountKeys;
      try {
        keys = openPasskeyAccountKeys(auth, got.prfOutput);
      } catch (err) {
        // A session that cannot decrypt is no use: end it rather than leave it live.
        await client.logout(auth.refresh_token).catch(() => {});
        throw err;
      }
      await adoptPasskeySession(client, auth, keys);
    },
    [requireAuthenticator, adoptPasskeySession],
  );

  const signupWithPasskey = useCallback(
    async (email: string, displayName = "", invite?: string) => {
      const client = apiRef.current;
      if (!client) return;
      const authenticator = requireAuthenticator();
      await ensureServerCompatible(client);
      await ensurePasskeysOffered(client);
      const normalizedEmail = email.trim().toLowerCase();
      const salt = generateSalt();
      const dek = generateDek();
      const keypair = generateUserKeypair();
      const signing = generateSigningKeypair();
      const phrase = generateRecoveryPhrase();
      const recovery = deriveRecoveryKeys(phrase, salt);
      const deviceName = await detectDeviceName().catch(() => undefined);
      const built = await buildPasskeySignup(client, authenticator, {
        email: normalizedEmail,
        displayName,
        passkeyName: deviceName,
        recoveryWrapKey: recovery.wrapKey,
        dek,
        privateKey: keypair.secretKey,
      });
      const auth = await client.signup({
        email: normalizedEmail,
        passkey: built.passkey,
        displayName,
        invite,
        deviceName,
        installKey: await getInstallKey(),
        salt,
        publicKey: keypair.publicKey,
        recoveryPublicKey: recovery.auth.publicKey,
        recoveryEncryptedDek: wrapKey(dek, recovery.wrapKey),
        recoveryEncryptedPrivateKey: wrapKey(keypair.secretKey, recovery.wrapKey),
        // The KDF a password added later derives with.
        kdf: CURRENT_KDF,
        signingPublicKey: signing.publicKey,
        encryptedSigningKey: wrapSigningKey(signing.secretKey, dek),
        root: {
          userId: built.userId,
          recoveryEncryptedRootKey: built.recoveryEncryptedRootKey,
          appKeys: built.appKeys,
        },
      });
      await adoptPasskeySession(
        client,
        auth,
        { dek, privateKey: keypair.secretKey, rootKey: built.rootKey, source: "root" },
        signing.secretKey,
      );
      setRecoveryPhrase(phrase);
    },
    [requireAuthenticator, adoptPasskeySession],
  );

  const confirmWithPasskey = useCallback(async (): Promise<PasskeyProof> => {
    const client = apiRef.current;
    const current = sessionRef.current;
    if (!client || !current) throw new Error("sign in first");
    const { reauthToken, rootKey } = await reauthenticateWithPasskey(
      client,
      requireAuthenticator(),
      current.user.id,
    );
    return { reauthToken, rootKey };
  }, [requireAuthenticator]);

  const unlockWithPasskey = useCallback(async (): Promise<boolean> => {
    const locked = sessionRef.current;
    const client = apiRef.current;
    if (!locked || !client) return false;
    const { rootKey } = await confirmWithPasskey();
    if (!rootKey) return false;
    let appKeys = locked.appKeys;
    if (!appKeys?.length) appKeys = (await client.getRootKey()).app_keys;
    let todo: ReturnType<typeof openTodoAppKey>;
    try {
      todo = openTodoAppKey(rootKey, locked.user.id, appKeys);
    } catch {
      return false;
    }
    if (!todo.privateKey) return false;
    const current = sessionRef.current;
    if (!current || current.user.id !== locked.user.id) return true;
    const publicKey = current.publicKey ?? getPublicKey(todo.privateKey);
    const next: Session = {
      ...current,
      publicKey,
      dek: bytesToHex(todo.dek),
      privateKey: bytesToHex(todo.privateKey),
    };
    await writeSession(next).catch((err) =>
      console.warn("[atlas] could not persist the unlocked keys:", err),
    );
    commitKeyring(new Keyring({ dek: todo.dek, privateKey: todo.privateKey, publicKey }));
    commitSession(next);
    return true;
  }, [confirmWithPasskey, commitKeyring, commitSession]);

  const addPasskey = useCallback(
    async (name: string, proof: string | PasskeyProof) => {
      const client = apiRef.current;
      const current = sessionRef.current;
      if (!client || !current) return;
      let rootKey: Uint8Array;
      let accountProof: AccountProof;
      if (typeof proof === "string") {
        // The password proves the holder and opens the root's password slot.
        const { salt, kdf } = await accountCredentialKdf(client, current);
        const credential = await deriveAuthAndMekAsync(proof, salt, kdf);
        const rootState = await currentRootState(client, current);
        if (!rootState.encryptedRootKey) throw new Error("the account has no root key yet");
        try {
          rootKey = unwrapRootKey(
            rootState.encryptedRootKey,
            credential.mek,
            current.user.id,
            "password",
          );
        } catch {
          throw new ApiError(403, "invalid credentials", { code: "invalid_credentials" });
        }
        accountProof = { current_password: credential.authHash };
      } else {
        if (!proof.rootKey) throw new PasskeyPrfUnsupportedError();
        rootKey = proof.rootKey;
        accountProof = { reauth_token: proof.reauthToken };
      }
      await addPasskeyFlow(client, requireAuthenticator(), {
        rootKey,
        userId: current.user.id,
        name,
        proof: accountProof,
      });
    },
    [requireAuthenticator],
  );

  const removePasskey = useCallback(async (id: string, proof: string | PasskeyProof) => {
    const client = apiRef.current;
    const current = sessionRef.current;
    if (!client || !current) return;
    await client.removePasskey(id, await accountProofOf(client, current, proof));
  }, []);

  const removePassword = useCallback(
    async (proof: string | PasskeyProof) => {
      const client = apiRef.current;
      const current = sessionRef.current;
      if (!client || !current) return;
      await client.removePassword(await accountProofOf(client, current, proof));
      const latest = sessionRef.current;
      if (!latest) return;
      // Every password-derived wrap is gone on the server; this session keeps its unwrapped keys.
      const next: Session = { ...latest, user: { ...latest.user, has_password: false } };
      delete next.encryptedDek;
      delete next.encryptedPrivateKey;
      delete next.encryptedRootKey;
      await writeSession(next).catch(() => {});
      commitSession(next);
    },
    [commitSession],
  );

  const value = useMemo<AuthContextValue | null>(
    () =>
      api
        ? {
            session,
            sessionRestored,
            api,
            keyring,
            recoveryPhrase,
            dismissRecoveryPhrase,
            changeServerUrl,
            login,
            signup,
            recoverAccount,
            registerRecoveryKey,
            replaceRecoveryPhrase,
            changePassword,
            deleteAccount,
            cancelAccountDeletion,
            logout,
            unlock,
            verifyPassword,
            upgradeRequired,
            retryAfterUpgrade,
            signOutNotice,
            passkeyAuthenticator,
            loginWithPasskey,
            signupWithPasskey,
            confirmWithPasskey,
            unlockWithPasskey,
            addPasskey,
            removePasskey,
            removePassword,
          }
        : null,
    [
      session,
      sessionRestored,
      api,
      keyring,
      recoveryPhrase,
      dismissRecoveryPhrase,
      changeServerUrl,
      login,
      signup,
      recoverAccount,
      registerRecoveryKey,
      replaceRecoveryPhrase,
      changePassword,
      deleteAccount,
      cancelAccountDeletion,
      logout,
      unlock,
      verifyPassword,
      upgradeRequired,
      retryAfterUpgrade,
      signOutNotice,
      passkeyAuthenticator,
      loginWithPasskey,
      signupWithPasskey,
      confirmWithPasskey,
      unlockWithPasskey,
      addPasskey,
      removePasskey,
      removePassword,
    ],
  );

  // The skeleton is delay-gated: a resolve inside 300 ms shows nothing instead of a placeholder flash.
  if (!value) {
    return (
      <SkeletonGate active>
        <AppSkeleton />
      </SkeletonGate>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
