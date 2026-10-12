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
  deriveAuthAndMekAsync,
  deriveRecoveryKeys,
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
  reconcileStoredSession,
  sameKdf,
  unwrapKey,
  verifyAccountPassword,
  wrapKey,
  wrapSigningKey,
  type ApiClient,
  type AuthResponse,
  type PasswordKdf,
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
  replaceRecoveryPhrase: (password: string) => Promise<string>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /** Schedule the account's deletion; once the server accepts, sign out and delete the local data. */
  deleteAccount: (password: string) => Promise<void>;
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
        if (prev.user.is_admin === user.is_admin && prev.user.has_recovery_key === hasRecoveryKey) {
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
      keys: { dek: Uint8Array; privateKey: Uint8Array },
    ) => {
      let payload: Awaited<ReturnType<typeof buildKdfUpgrade>>;
      try {
        payload = await buildKdfUpgrade(
          { salt: credential.salt, ...keys },
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
      const next: Session = {
        ...current,
        encryptedDek: payload.encrypted_dek,
        encryptedPrivateKey: payload.encrypted_private_key,
        kdf: CURRENT_KDF,
      };
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
      const dek = unwrapKey(auth.encrypted_dek, credential.mek);
      const privKey = unwrapKey(auth.encrypted_private_key, credential.mek);
      const activeKeyring = new Keyring({ dek, privateKey: privKey, publicKey: auth.public_key });
      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(dek);
      next.privateKey = bytesToHex(privKey);
      // The blobs just opened with this KDF's key, whatever the response named.
      next.kdf = credential.kdf;

      await writeSession(next);

      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(activeKeyring);
      commitSession(next);

      if (credential.serverNamesKdf && credential.kdf.version < CURRENT_KDF.version) {
        await upgradeKdf(client, normalizedEmail, next.user.id, password, credential, {
          dek,
          privateKey: privKey,
        });
      }
    },
    [commitKeyring, commitSession, upgradeKdf],
  );

  const signup = useCallback(
    async (email: string, password: string, displayName = "", invite?: string) => {
      const client = apiRef.current;
      if (!client) return;
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
    },
    [markRecoveryKeyRegistered],
  );

  const replaceRecoveryPhrase = useCallback(
    async (password: string) => {
      const client = apiRef.current;
      const current = sessionRef.current;
      const keyring = keyringRef.current;
      const privateKey = keyring?.getPrivateKey();
      if (!client || !current || !keyring?.hasKeys() || !privateKey) {
        throw new Error("unlock the session before replacing the recovery phrase");
      }
      const { salt, kdf } = await accountCredentialKdf(client, current);
      const { phrase, payload } = await buildRecoveryPhraseReplacement(
        { salt, kdf, dek: keyring.getDek(), privateKey },
        password,
      );
      await client.replaceRecoveryKey(payload);
      // The account now has a phrase-derived recovery key, whether or not it had one before.
      await markRecoveryKeyRegistered();
      return phrase;
    },
    [markRecoveryKeyRegistered],
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
    async (currentPassword: string, newPassword: string) => {
      const client = apiRef.current;
      if (!client || !session) return;
      // The re-wrap needs the session's key material (restored on every login/signup/unlock); a
      // session without it cannot re-wrap.
      if (!session.dek || !session.privateKey) {
        throw new Error("sign in again to change the password: key material is missing");
      }
      // The current credential derives with the account's KDF; the new one with the current KDF.
      const { salt, kdf, newKdf } = await accountCredentialKdf(client, session);
      const payload = await buildE2eePasswordChange(
        { salt, kdf, dek: hexToBytes(session.dek), privateKey: hexToBytes(session.privateKey) },
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
      const next: Session = {
        ...current,
        encryptedDek: payload.encrypted_dek,
        encryptedPrivateKey: payload.encrypted_private_key,
        kdf: newKdf,
      };
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
    async (password: string) => {
      const client = apiRef.current;
      if (!client || !session) return;
      const { authHash } = await resolveLoginCredential(client, session.user.email, password);
      await client.deleteAccount(authHash);
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
      const dek = unwrapKey(auth.encrypted_dek, mek);
      const privKey = unwrapKey(auth.encrypted_private_key, mek);
      const activeKeyring = new Keyring({ dek, privateKey: privKey, publicKey: auth.public_key });
      const next = sessionFromAuth(auth);
      next.dek = bytesToHex(dek);
      next.privateKey = bytesToHex(privKey);
      next.kdf = kdf;

      await writeSession(next);
      client.setTokens(next.accessToken, next.refreshToken);
      commitKeyring(activeKeyring);
      commitSession(next);
    },
    [commitKeyring, commitSession],
  );

  const unlock = useCallback(
    async (password: string): Promise<boolean> => {
      const locked = sessionRef.current;
      if (!locked?.salt || !locked.encryptedDek || !locked.encryptedPrivateKey) {
        throw new Error("this session holds no wrapped keys; sign in again");
      }
      // The session keeps the KDF with the blobs; one stored before it did holds version-1 blobs.
      const { mek } = await deriveAuthAndMekAsync(password, locked.salt, locked.kdf ?? LEGACY_KDF);
      let dek: Uint8Array;
      let privateKey: Uint8Array;
      try {
        dek = unwrapKey(locked.encryptedDek, mek);
        privateKey = unwrapKey(locked.encryptedPrivateKey, mek);
      } catch {
        return false; // AES-GCM refuses a key derived from the wrong password
      }
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
      return true;
    },
    [commitKeyring, commitSession],
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
