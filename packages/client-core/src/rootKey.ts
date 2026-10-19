/**
 * The account root key, client side: opening an account's keys through it, and migrating an
 * account created before it. The crypto lives in `crypto/rootKey.ts`; this module is the flow.
 *
 * - {@link openAccountKeys}: prefer root → todo app key (the DEK) → the todo identity, fall back to
 *   the legacy MEK-wrapped DEK and private key, which every account still has.
 * - {@link ensureRootKey}: after a password sign-in or unlock, migrate an account that has no root
 *   (`POST /auth/root-key`, set once; a device that loses the race loads the winner's root), or
 *   fill a missing recovery slot. Best effort: the account works on the legacy wraps meanwhile.
 * - {@link enableApp}: give the account another app of the suite (journal): its own key and
 *   X25519 identity under the root, then the app enabled. Needs the root, so an account from
 *   before root keys must have migrated first (any password sign-in or unlock does it).
 */

import { apiErrorCode, type AccountAppView, type ApiClient } from "./api";
import {
  TODO_APP,
  generateAccountId,
  generateRootKey,
  generateUserKeypair,
  getPublicKey,
  randomBytes,
  sealRootKey,
  unwrapAppKey,
  unwrapAppPrivateKey,
  unwrapKey,
  unwrapRootKey,
  wrapAppKey,
  wrapAppPrivateKey,
  wrapRootKey,
  type EncryptedPayload,
  type RootKeyWrap,
} from "./crypto";
import type { AppKeyRow, MigrateRootKeyPayload } from "./types";

/** What a session knows about the account's root key (see `Session`). */
export interface RootKeyState {
  hasRootKey?: boolean;
  encryptedRootKey?: RootKeyWrap;
  appKeys?: AppKeyRow[];
  hasRecoveryRootKey?: boolean;
  recoveryPublicKey?: string;
}

export interface AccountKeys {
  /** The todo app key: the account's DEK. */
  dek: Uint8Array;
  privateKey: Uint8Array;
  /** The root key, when the password slot opened; never persisted. */
  rootKey: Uint8Array | null;
  /** Which path produced `dek`. */
  source: "root" | "legacy";
}

/** The todo app's row: the DEK under the root, and the X25519 identity under the DEK. */
export function todoAppKeyRow(
  rootKey: Uint8Array,
  userId: string,
  keys: { dek: Uint8Array; privateKey: Uint8Array },
): AppKeyRow {
  return {
    app: TODO_APP,
    wrapped_key: wrapAppKey(keys.dek, rootKey, userId, TODO_APP),
    wrapped_private_key: wrapAppPrivateKey(keys.privateKey, keys.dek, userId, TODO_APP),
  };
}

/** Open the todo key (and identity) from its row under `rootKey`; throws when it does not open. */
export function openTodoAppKey(
  rootKey: Uint8Array,
  userId: string,
  appKeys: AppKeyRow[] | undefined,
): { dek: Uint8Array; privateKey: Uint8Array | null } {
  const row = appKeys?.find((k) => k.app === TODO_APP);
  if (!row) throw new Error("the account has no todo app key");
  const dek = unwrapAppKey(row.wrapped_key, rootKey, userId, TODO_APP);
  const privateKey = row.wrapped_private_key
    ? unwrapAppPrivateKey(row.wrapped_private_key, dek, userId, TODO_APP)
    : null;
  return { dek, privateKey };
}

/**
 * The account's keys from what a session or auth response holds and the MEK the password derives.
 * Throws when neither path opens (a wrong password: AES-GCM refuses the key).
 */
export function openAccountKeys(input: {
  userId: string;
  mek: Uint8Array;
  encryptedRootKey?: RootKeyWrap;
  appKeys?: AppKeyRow[];
  encryptedDek?: EncryptedPayload;
  encryptedPrivateKey?: EncryptedPayload;
}): AccountKeys {
  let rootKey: Uint8Array | null = null;
  if (input.encryptedRootKey) {
    try {
      rootKey = unwrapRootKey(input.encryptedRootKey, input.mek, input.userId, "password");
      const todo = openTodoAppKey(rootKey, input.userId, input.appKeys);
      const privateKey =
        todo.privateKey ??
        (input.encryptedPrivateKey ? unwrapKey(input.encryptedPrivateKey, input.mek) : null);
      if (privateKey) return { dek: todo.dek, privateKey, rootKey, source: "root" };
    } catch {
      // A stale or damaged root slot: the legacy wraps still hold the same keys.
    }
  }
  if (!input.encryptedDek || !input.encryptedPrivateKey) {
    throw new Error("the account's keys are not wrapped for this password");
  }
  return {
    dek: unwrapKey(input.encryptedDek, input.mek),
    privateKey: unwrapKey(input.encryptedPrivateKey, input.mek),
    rootKey,
    source: "legacy",
  };
}

/**
 * The root key of a new account, as `ApiClient.signup` takes it: a fresh account id and root, the
 * root under the MEK and under the phrase-derived recovery key, and the DEK as the todo key.
 */
export function buildSignupRoot(input: {
  mek: Uint8Array;
  recoveryWrapKey: Uint8Array;
  dek: Uint8Array;
  privateKey: Uint8Array;
}): {
  userId: string;
  encryptedRootKey: RootKeyWrap;
  recoveryEncryptedRootKey: RootKeyWrap;
  appKeys: AppKeyRow[];
} {
  const userId = generateAccountId();
  const rootKey = generateRootKey();
  return {
    userId,
    encryptedRootKey: wrapRootKey(rootKey, input.mek, userId, "password"),
    recoveryEncryptedRootKey: wrapRootKey(rootKey, input.recoveryWrapKey, userId, "recovery"),
    appKeys: [todoAppKeyRow(rootKey, userId, input)],
  };
}

/**
 * The `POST /auth/root-key` body for an account without a root: a new root under the MEK, sealed
 * to the recovery public key when the account has one (the phrase is not at hand), and the DEK
 * as the todo app key under it.
 */
export function buildRootKeyMigration(input: {
  userId: string;
  authHash: string;
  mek: Uint8Array;
  dek: Uint8Array;
  privateKey: Uint8Array;
  recoveryPublicKey?: string;
}): { rootKey: Uint8Array; payload: MigrateRootKeyPayload } {
  const rootKey = generateRootKey();
  const payload: MigrateRootKeyPayload = {
    current_password: input.authHash,
    encrypted_root_key: wrapRootKey(rootKey, input.mek, input.userId, "password"),
    app_keys: [todoAppKeyRow(rootKey, input.userId, input)],
  };
  if (input.recoveryPublicKey) {
    payload.recovery_encrypted_root_key = sealRootKey(
      rootKey,
      input.recoveryPublicKey,
      input.userId,
    );
    payload.recovery_public_key = input.recoveryPublicKey;
  }
  return { rootKey, payload };
}

/**
 * Bring the account's root key up to date after the password proved itself (`authHash`, `mek`):
 * migrate an account the server says has none, or seal the root into an empty recovery slot.
 * Resolves the new root state to fold into the session, or null when nothing changed (also for a
 * server predating root keys, which says nothing). Rejects on network or server errors.
 */
export async function ensureRootKey(
  api: Pick<ApiClient, "migrateRootKey" | "getRootKey" | "putRecoveryRootKey">,
  input: {
    userId: string;
    authHash: string;
    mek: Uint8Array;
    dek: Uint8Array;
    privateKey: Uint8Array;
    rootKey: Uint8Array | null;
    state: RootKeyState;
  },
): Promise<{ rootKey: Uint8Array; state: RootKeyState } | null> {
  const { state } = input;
  if (state.hasRootKey === false) {
    const { rootKey, payload } = buildRootKeyMigration({
      ...input,
      recoveryPublicKey: state.recoveryPublicKey,
    });
    try {
      await api.migrateRootKey(payload);
    } catch (err) {
      if (apiErrorCode(err) !== "root_key_exists") throw err;
      // Another device migrated first: its root is the account's.
      const stored = await api.getRootKey();
      if (!stored.encrypted_root_key)
        throw new Error("the account's root key has no password slot");
      return {
        rootKey: unwrapRootKey(stored.encrypted_root_key, input.mek, input.userId, "password"),
        state: {
          hasRootKey: true,
          encryptedRootKey: stored.encrypted_root_key,
          appKeys: stored.app_keys,
          hasRecoveryRootKey: stored.has_recovery_root_key,
          recoveryPublicKey: stored.recovery_public_key ?? undefined,
        },
      };
    }
    return {
      rootKey,
      state: {
        hasRootKey: true,
        encryptedRootKey: payload.encrypted_root_key,
        appKeys: payload.app_keys,
        hasRecoveryRootKey: payload.recovery_encrypted_root_key !== undefined,
        recoveryPublicKey: state.recoveryPublicKey,
      },
    };
  }
  if (
    state.hasRootKey === true &&
    input.rootKey &&
    state.hasRecoveryRootKey === false &&
    state.recoveryPublicKey
  ) {
    try {
      await api.putRecoveryRootKey({
        current_password: input.authHash,
        recovery_public_key: state.recoveryPublicKey,
        recovery_encrypted_root_key: sealRootKey(
          input.rootKey,
          state.recoveryPublicKey,
          input.userId,
        ),
      });
    } catch (err) {
      if (apiErrorCode(err) !== "key_already_stored") throw err;
    }
    return { rootKey: input.rootKey, state: { ...state, hasRecoveryRootKey: true } };
  }
  return null;
}

/** A non-todo app's keys: its 32-byte key and its X25519 identity. */
export interface AppKeys {
  app: string;
  appKey: Uint8Array;
  privateKey: Uint8Array;
  /** The identity's public key (hex). */
  publicKey: string;
}

/** {@link enableApp} needs the root key, which an account from before root keys does not have yet. */
export class RootKeyRequiredError extends Error {
  constructor() {
    super(
      "enabling an app needs the account root key: sign in with the password once so the account migrates",
    );
    this.name = "RootKeyRequiredError";
  }
}

function checkApp(app: string): void {
  if (app === TODO_APP) throw new Error("todo's key is the account's DEK; it is always enabled");
}

/** A new app key and identity, and the `account_app_keys` row wrapping them under the root. */
export function buildAppKey(
  rootKey: Uint8Array,
  userId: string,
  app: string,
): { keys: AppKeys; row: AppKeyRow } {
  checkApp(app);
  const appKey = randomBytes(32);
  const identity = generateUserKeypair();
  return {
    keys: { app, appKey, privateKey: identity.secretKey, publicKey: identity.publicKey },
    row: {
      app,
      wrapped_key: wrapAppKey(appKey, rootKey, userId, app),
      wrapped_private_key: wrapAppPrivateKey(identity.secretKey, appKey, userId, app),
    },
  };
}

/** Open an app's row under the root; throws when there is none or it does not open. */
export function openAppKey(
  rootKey: Uint8Array,
  userId: string,
  app: string,
  appKeys: AppKeyRow[] | undefined,
): AppKeys {
  checkApp(app);
  const row = appKeys?.find((k) => k.app === app);
  if (!row) throw new Error(`the account has no ${app} app key`);
  if (!row.wrapped_private_key) throw new Error(`the account's ${app} key has no identity`);
  const appKey = unwrapAppKey(row.wrapped_key, rootKey, userId, app);
  const privateKey = unwrapAppPrivateKey(row.wrapped_private_key, appKey, userId, app);
  return { app, appKey, privateKey, publicKey: getPublicKey(privateKey) };
}

/**
 * Enable another app of the suite for the account (`journal`): create its key and X25519 identity
 * under the root (`PUT /auth/app-keys/:app`), then enable it (`PUT /auth/apps/:app`). Resolves the
 * app's keys and the root state with the app's row folded in.
 *
 * Idempotent and safe when devices race: an app that already has a key is opened, not replaced;
 * the server sets a key once, and a device that loses the race (409 `key_already_stored`) loads
 * the stored row (`GET /auth/root-key`) and opens that. Enabling is idempotent on the server.
 *
 * Needs the unlocked root (`rootKey`): an account from before root keys must migrate first
 * ({@link ensureRootKey}, run at every password sign-in or unlock); without it this throws
 * {@link RootKeyRequiredError}. The session must be interactive (an API token gets 403).
 */
export async function enableApp(
  api: Pick<ApiClient, "putAppKey" | "getRootKey" | "enableAccountApp">,
  input: {
    userId: string;
    rootKey: Uint8Array | null;
    app: string;
    state?: RootKeyState;
  },
): Promise<{ keys: AppKeys; state: RootKeyState; app: AccountAppView }> {
  const { userId, rootKey, app } = input;
  checkApp(app);
  if (!rootKey || input.state?.hasRootKey === false) throw new RootKeyRequiredError();
  const state: RootKeyState = { ...input.state, appKeys: [...(input.state?.appKeys ?? [])] };
  const known = state.appKeys!.find((k) => k.app === app);
  let keys: AppKeys;
  if (known) {
    keys = openAppKey(rootKey, userId, app, state.appKeys);
  } else {
    const fresh = buildAppKey(rootKey, userId, app);
    try {
      await api.putAppKey(app, fresh.row);
      keys = fresh.keys;
      state.appKeys!.push(fresh.row);
    } catch (err) {
      if (apiErrorCode(err) !== "key_already_stored") throw err;
      // Another device keyed the app first: its key is the account's.
      const stored = await api.getRootKey();
      keys = openAppKey(rootKey, userId, app, stored.app_keys);
      state.appKeys = stored.app_keys;
    }
  }
  const view = await api.enableAccountApp(app);
  return { keys, state, app: view };
}
