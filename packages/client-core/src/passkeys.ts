/**
 * Passkeys, client side: the ceremonies against `/auth/passkeys/*` and what their PRF output
 * unlocks. The platform's WebAuthn (the browser's `navigator.credentials`, Android's Credential
 * Manager) sits behind {@link PasskeyAuthenticator}; the crypto is `crypto/passkey.ts`.
 *
 * - Every passkey must give a PRF output: it is what unlocks the root key. A registration whose
 *   `create()` returned none is followed by one `get()` of the new credential for it (some
 *   authenticators only evaluate PRF on assertions); still none is {@link PasskeyPrfUnsupportedError}.
 * - The PRF output never leaves the device: {@link withoutPrfOutput} strips it from what is sent.
 */

import type { ApiClient } from "./api";
import {
  TODO_APP,
  bytesToBase64Url,
  derivePasskeySlotKey,
  generateAccountId,
  generateRootKey,
  normalizeCredentialId,
  passkeySlot,
  randomBytes,
  unwrapRootKey,
  wrapRootKey,
  type RootKeyWrap,
} from "./crypto";
import { openTodoAppKey, todoAppKeyRow, type AccountKeys } from "./rootKey";
import type {
  AccountProof,
  AppKeyRow,
  AuthResponse,
  PasskeyAssertionResponse,
  PasskeyCreationOptions,
  PasskeyRegistrationResponse,
  PasskeyRequestOptions,
  PasskeySlotView,
  PasskeyView,
} from "./types";

export interface PasskeyCreateResult {
  credential: PasskeyRegistrationResponse;
  /** The PRF output for `extensions.prf.eval.first`, when the authenticator gave one at creation. */
  prfOutput: Uint8Array | null;
}

export interface PasskeyGetResult {
  credential: PasskeyAssertionResponse;
  /** The PRF output for the credential that answered, when the authenticator gave one. */
  prfOutput: Uint8Array | null;
}

/** The platform's WebAuthn, taking and giving WebAuthn JSON. */
export interface PasskeyAuthenticator {
  create(options: PasskeyCreationOptions): Promise<PasskeyCreateResult>;
  get(options: PasskeyRequestOptions): Promise<PasskeyGetResult>;
}

/** The passkey (or the browser, or the OS) cannot evaluate PRF, so it could not unlock. */
export class PasskeyPrfUnsupportedError extends Error {
  constructor() {
    super("this passkey does not support the PRF extension");
    this.name = "PasskeyPrfUnsupportedError";
  }
}

/** The user dismissed the passkey prompt, or it timed out. */
export class PasskeyCancelledError extends Error {
  constructor(cause?: unknown) {
    super("the passkey prompt was dismissed", { cause });
    this.name = "PasskeyCancelledError";
  }
}

/** The response as the server takes it: the PRF output removed, `enabled` kept on a registration. */
export function withoutPrfOutput<
  T extends { clientExtensionResults: Record<string, unknown> | undefined },
>(credential: T, registration: boolean): T {
  const { prf: _prf, ...rest } = credential.clientExtensionResults ?? {};
  return {
    ...credential,
    clientExtensionResults: registration ? { ...rest, prf: { enabled: true } } : rest,
  };
}

/** The PRF output of a credential just created: from `create()`, else from one `get()` of it. */
async function prfOfNewCredential(
  authenticator: PasskeyAuthenticator,
  options: PasskeyCreationOptions,
  created: PasskeyCreateResult,
): Promise<Uint8Array> {
  if (created.prfOutput) return created.prfOutput;
  const prf = created.credential.clientExtensionResults?.prf as { enabled?: boolean } | undefined;
  if (prf?.enabled === false) throw new PasskeyPrfUnsupportedError();
  const first = options.extensions?.prf?.eval?.first;
  if (!first) throw new PasskeyPrfUnsupportedError();
  // Only for the PRF output: the challenge is never verified, so a local one does.
  const got = await authenticator.get({
    challenge: bytesToBase64Url(randomBytes(32)),
    rpId: options.rp.id,
    timeout: options.timeout,
    userVerification: "required",
    allowCredentials: [
      {
        type: "public-key",
        id: created.credential.rawId,
        ...(created.credential.response.transports?.length
          ? { transports: created.credential.response.transports }
          : {}),
      },
    ],
    extensions: { prf: { eval: { first } } },
  });
  if (!got.prfOutput) throw new PasskeyPrfUnsupportedError();
  return got.prfOutput;
}

/** The key a passkey's PRF output gives its slot, and the slot's name. */
function slotKeyOf(prfOutput: Uint8Array, credentialId: string) {
  const id = normalizeCredentialId(credentialId);
  return { key: derivePasskeySlotKey(prfOutput, id), slot: passkeySlot(id) };
}

/**
 * Create a passkey for `options` and wrap `rootKey` in its slot: the registration and the wrap,
 * ready for `POST /auth/passkeys` or a passkey signup.
 */
export async function createPasskeySlot(
  authenticator: PasskeyAuthenticator,
  options: PasskeyCreationOptions,
  input: { rootKey: Uint8Array; userId: string },
): Promise<{ credential: PasskeyRegistrationResponse; encrypted_root_key: RootKeyWrap }> {
  const created = await authenticator.create(options);
  const prfOutput = await prfOfNewCredential(authenticator, options, created);
  const { key, slot } = slotKeyOf(prfOutput, created.credential.rawId);
  return {
    credential: withoutPrfOutput(created.credential, true),
    encrypted_root_key: wrapRootKey(input.rootKey, key, input.userId, slot),
  };
}

/** Add a passkey to the signed-in account (the root key must be at hand, `proof` fresh). */
export async function addPasskey(
  api: Pick<ApiClient, "passkeyRegisterOptions" | "registerPasskey">,
  authenticator: PasskeyAuthenticator,
  input: { rootKey: Uint8Array; userId: string; name?: string; proof: AccountProof },
): Promise<PasskeyView> {
  const options = await api.passkeyRegisterOptions();
  const slot = await createPasskeySlot(authenticator, options, input);
  return api.registerPasskey({ ...slot, name: input.name, ...input.proof });
}

/**
 * Everything a passkey signup sends besides the account keys: a fresh account id and root key,
 * the passkey (registered for that id) with the root in its slot, the root in the recovery slot and
 * the DEK as the todo app key under it. No password slot.
 */
export async function buildPasskeySignup(
  api: Pick<ApiClient, "passkeySignupOptions">,
  authenticator: PasskeyAuthenticator,
  input: {
    email: string;
    displayName?: string;
    passkeyName?: string;
    recoveryWrapKey: Uint8Array;
    dek: Uint8Array;
    privateKey: Uint8Array;
  },
): Promise<{
  userId: string;
  rootKey: Uint8Array;
  passkey: {
    credential: PasskeyRegistrationResponse;
    name?: string;
    encrypted_root_key: RootKeyWrap;
  };
  recoveryEncryptedRootKey: RootKeyWrap;
  appKeys: AppKeyRow[];
}> {
  const userId = generateAccountId();
  const rootKey = generateRootKey();
  const options = await api.passkeySignupOptions({
    userId,
    email: input.email,
    displayName: input.displayName,
  });
  const slot = await createPasskeySlot(authenticator, options, { rootKey, userId });
  return {
    userId,
    rootKey,
    passkey: { ...slot, name: input.passkeyName },
    recoveryEncryptedRootKey: wrapRootKey(rootKey, input.recoveryWrapKey, userId, "recovery"),
    appKeys: [todoAppKeyRow(rootKey, userId, input)],
  };
}

/** Open a passkey's root slot with its PRF output; throws when it does not open. */
export function openPasskeySlot(
  slot: PasskeySlotView,
  prfOutput: Uint8Array,
  userId: string,
): Uint8Array {
  const { key, slot: name } = slotKeyOf(prfOutput, slot.credential_id);
  return unwrapRootKey(slot.encrypted_root_key, key, userId, name);
}

/**
 * The account's keys after a passkey sign-in: root (from the passkey's slot) → todo app key (the
 * DEK) → the todo identity. Throws when the slot does not open or the account has no todo key.
 */
export function openPasskeyAccountKeys(
  auth: Pick<AuthResponse, "user" | "passkey" | "app_keys">,
  prfOutput: Uint8Array,
): AccountKeys {
  if (!auth.passkey) throw new Error("the sign-in carried no passkey slot");
  const rootKey = openPasskeySlot(auth.passkey, prfOutput, auth.user.id);
  const todo = openTodoAppKey(rootKey, auth.user.id, auth.app_keys);
  if (!todo.privateKey) throw new Error(`the ${TODO_APP} app key holds no identity`);
  return { dek: todo.dek, privateKey: todo.privateKey, rootKey, source: "root" };
}

/**
 * Sign in with a passkey (discoverable, or email-first): the session the server opened and the
 * keys the passkey unlocked. A passkey without PRF output fails before anything is sent.
 */
export async function signInWithPasskey(
  api: Pick<ApiClient, "passkeyLoginOptions" | "passkeyLogin">,
  authenticator: PasskeyAuthenticator,
  input: { email?: string; deviceName?: string; installKey?: string } = {},
): Promise<{ auth: AuthResponse; keys: AccountKeys }> {
  const options = await api.passkeyLoginOptions(input.email);
  const got = await authenticator.get(options);
  if (!got.prfOutput) throw new PasskeyPrfUnsupportedError();
  const auth = await api.passkeyLogin({
    credential: withoutPrfOutput(got.credential, false),
    deviceName: input.deviceName,
    installKey: input.installKey,
  });
  return { auth, keys: openPasskeyAccountKeys(auth, got.prfOutput) };
}

/**
 * Re-authenticate the signed-in account with one of its passkeys: the single-use proof (for
 * `reauth_token`) and, when the passkey gave a PRF output, the root key its slot opened (which also
 * unlocks a locked session).
 */
export async function reauthenticateWithPasskey(
  api: Pick<ApiClient, "passkeyReauthOptions" | "passkeyReauth">,
  authenticator: PasskeyAuthenticator,
  userId: string,
): Promise<{ reauthToken: string; rootKey: Uint8Array | null; passkey: PasskeySlotView }> {
  const options = await api.passkeyReauthOptions();
  const got = await authenticator.get(options);
  const res = await api.passkeyReauth(withoutPrfOutput(got.credential, false));
  let rootKey: Uint8Array | null = null;
  if (got.prfOutput) {
    try {
      rootKey = openPasskeySlot(res.passkey, got.prfOutput, userId);
    } catch {
      // A slot that does not open (a stale wrap): the proof still stands.
    }
  }
  return { reauthToken: res.reauth_token, rootKey, passkey: res.passkey };
}
