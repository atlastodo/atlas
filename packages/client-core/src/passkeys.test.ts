import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_KDF,
  bytesToBase64Url,
  decodeBase64Url,
  deriveAuthAndMekAsync,
  generateDek,
  generateUserKeypair,
  passkeyPrfInputBase64Url,
  randomBytes,
  unwrapRootKey,
} from "./crypto";
import {
  PasskeyPrfUnsupportedError,
  addPasskey,
  buildPasskeySignup,
  reauthenticateWithPasskey,
  signInWithPasskey,
  withoutPrfOutput,
  type PasskeyAuthenticator,
} from "./passkeys";
import { buildE2eePasswordChange, buildRecoveryPhraseReplacement } from "./password";
import type { ApiClient } from "./api";
import type {
  AppKeyRow,
  PasskeyAssertionResponse,
  PasskeyRegistrationPayload,
  AuthResponse,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
  PasskeySlotView,
} from "./types";

type LoginReq = Parameters<ApiClient["passkeyLogin"]>[0];

/**
 * A software authenticator: each credential has its own PRF secret, and the PRF output is
 * HMAC-SHA256(secret, input), as hmac-secret computes it (bar the salt hashing).
 */
class FakeAuthenticator implements PasskeyAuthenticator {
  readonly secrets = new Map<string, Uint8Array>();
  prfAtCreate = true;
  prfAtGet = true;
  lastId = "";
  created: PasskeyCreationOptions[] = [];
  requested: PasskeyRequestOptions[] = [];

  private prf(id: string, input: string | undefined) {
    const secret = this.secrets.get(id);
    if (!secret || !input) return null;
    return hmac(sha256, secret, decodeBase64Url(input));
  }

  async create(options: PasskeyCreationOptions) {
    this.created.push(options);
    const id = bytesToBase64Url(randomBytes(16));
    this.secrets.set(id, randomBytes(32));
    this.lastId = id;
    const prfOutput = this.prfAtCreate ? this.prf(id, options.extensions?.prf?.eval?.first) : null;
    return {
      credential: {
        id,
        rawId: id,
        type: "public-key" as const,
        response: { clientDataJSON: "e30", attestationObject: "AA", transports: ["internal"] },
        clientExtensionResults: {
          prf: prfOutput
            ? { enabled: true, results: { first: bytesToBase64Url(prfOutput) } }
            : { enabled: this.prfAtGet },
        },
      },
      prfOutput,
    };
  }

  async get(options: PasskeyRequestOptions) {
    this.requested.push(options);
    const id = options.allowCredentials?.[0]?.id ?? this.lastId;
    const input =
      options.extensions?.prf?.evalByCredential?.[id]?.first ??
      options.extensions?.prf?.eval?.first;
    const prfOutput = this.prfAtGet ? this.prf(id, input) : null;
    return {
      credential: {
        id,
        rawId: id,
        type: "public-key" as const,
        response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" },
        clientExtensionResults: prfOutput
          ? { prf: { results: { first: bytesToBase64Url(prfOutput) } } }
          : {},
      },
      prfOutput,
    };
  }
}

const creationOptions = (): PasskeyCreationOptions => ({
  challenge: "Y2g",
  rp: { id: "todo.example.com", name: "Atlas Todo" },
  user: { id: "dQ", name: "a@example.com", displayName: "A" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  extensions: { prf: { eval: { first: passkeyPrfInputBase64Url() } } },
});

const requestOptions = (): PasskeyRequestOptions => ({
  challenge: "Y2g",
  rpId: "todo.example.com",
  extensions: { prf: { eval: { first: passkeyPrfInputBase64Url() } } },
});

async function signupAccount(authenticator: FakeAuthenticator) {
  const dek = generateDek();
  const keypair = generateUserKeypair();
  const recoveryWrapKey = randomBytes(32);
  const api = { passkeySignupOptions: vi.fn(async () => creationOptions()) };
  const signup = await buildPasskeySignup(api, authenticator, {
    email: "a@example.com",
    passkeyName: "Laptop",
    recoveryWrapKey,
    dek,
    privateKey: keypair.secretKey,
  });
  return { signup, dek, keypair, recoveryWrapKey, api };
}

/** What the server answers a passkey sign-in with, for the passkey the signup registered. */
function serverAuth(userId: string, slot: PasskeySlotView, appKeys: AppKeyRow[]): AuthResponse {
  return {
    access_token: "a",
    refresh_token: "r",
    expires_in: 900,
    device_id: "d",
    user: { id: userId, email: "a@example.com", display_name: "" },
    app_keys: appKeys,
    passkey: slot,
  };
}

describe("passkey signup and sign-in", () => {
  it("signs up passkey-only and unlocks the same keys at sign-in", async () => {
    const authenticator = new FakeAuthenticator();
    const { signup, dek, keypair, recoveryWrapKey, api } = await signupAccount(authenticator);
    expect(api.passkeySignupOptions).toHaveBeenCalledWith({
      userId: signup.userId,
      email: "a@example.com",
      displayName: undefined,
    });
    // The PRF output never leaves: only `enabled` is reported.
    expect(signup.passkey.credential.clientExtensionResults).toEqual({ prf: { enabled: true } });
    expect(signup.passkey.name).toBe("Laptop");
    expect(
      unwrapRootKey(signup.recoveryEncryptedRootKey, recoveryWrapKey, signup.userId, "recovery"),
    ).toEqual(signup.rootKey);

    const slot: PasskeySlotView = {
      id: "p1",
      credential_id: signup.passkey.credential.rawId,
      encrypted_root_key: signup.passkey.encrypted_root_key,
    };
    const login = {
      passkeyLoginOptions: vi.fn(async () => requestOptions()),
      passkeyLogin: vi.fn(async (_req: LoginReq) =>
        serverAuth(signup.userId, slot, signup.appKeys),
      ),
    };
    const { auth, keys } = await signInWithPasskey(login, authenticator, { deviceName: "Phone" });
    expect(auth.user.id).toBe(signup.userId);
    expect(keys.dek).toEqual(dek);
    expect(keys.privateKey).toEqual(keypair.secretKey);
    expect(keys.rootKey).toEqual(signup.rootKey);
    const sent = login.passkeyLogin.mock.calls[0]![0];
    expect(sent.credential.clientExtensionResults).toEqual({});
    expect(sent.deviceName).toBe("Phone");
  });

  it("asks for the PRF output with a get() when create() gave none", async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.prfAtCreate = false;
    const { signup } = await signupAccount(authenticator);
    expect(authenticator.requested).toHaveLength(1);
    expect(authenticator.requested[0]!.allowCredentials?.[0]?.id).toBe(
      signup.passkey.credential.rawId,
    );
    expect(signup.passkey.credential.clientExtensionResults).toEqual({ prf: { enabled: true } });
  });

  it("refuses a passkey without PRF", async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.prfAtCreate = false;
    authenticator.prfAtGet = false;
    await expect(signupAccount(authenticator)).rejects.toBeInstanceOf(PasskeyPrfUnsupportedError);
    // Without PRF at sign-in, nothing is sent.
    const login = {
      passkeyLoginOptions: vi.fn(async () => requestOptions()),
      passkeyLogin: vi.fn(),
    };
    await expect(signInWithPasskey(login, authenticator)).rejects.toBeInstanceOf(
      PasskeyPrfUnsupportedError,
    );
    expect(login.passkeyLogin).not.toHaveBeenCalled();
  });

  it("fails to open another passkey's slot", async () => {
    const authenticator = new FakeAuthenticator();
    const { signup } = await signupAccount(authenticator);
    const otherAuthenticator = new FakeAuthenticator();
    otherAuthenticator.secrets.set(signup.passkey.credential.rawId, randomBytes(32));
    otherAuthenticator.lastId = signup.passkey.credential.rawId;
    const slot: PasskeySlotView = {
      id: "p1",
      credential_id: signup.passkey.credential.rawId,
      encrypted_root_key: signup.passkey.encrypted_root_key,
    };
    const login = {
      passkeyLoginOptions: async () => requestOptions(),
      passkeyLogin: async () => serverAuth(signup.userId, slot, signup.appKeys),
    };
    await expect(signInWithPasskey(login, otherAuthenticator)).rejects.toThrow();
  });
});

describe("passkey proofs", () => {
  it("adds a passkey with a proof and re-authenticates with it", async () => {
    const authenticator = new FakeAuthenticator();
    const rootKey = randomBytes(32);
    const api = {
      passkeyRegisterOptions: vi.fn(async () => creationOptions()),
      registerPasskey: vi.fn(async (_payload: PasskeyRegistrationPayload) => ({
        id: "p2",
        credential_id: authenticator.lastId,
        name: "Key",
        transports: [],
        backup_eligible: false,
        backed_up: false,
        created_at: 0,
      })),
    };
    await addPasskey(api, authenticator, {
      rootKey,
      userId: "u1",
      name: "Key",
      proof: { current_password: "ab" },
    });
    const registered = api.registerPasskey.mock.calls[0]![0];
    expect(registered.current_password).toBe("ab");
    expect(registered.name).toBe("Key");

    const reauthApi = {
      passkeyReauthOptions: async () => requestOptions(),
      passkeyReauth: vi.fn(async (_credential: PasskeyAssertionResponse) => ({
        reauth_token: "tok",
        expires_in: 300,
        passkey: {
          id: "p2",
          credential_id: registered.credential.rawId,
          encrypted_root_key: registered.encrypted_root_key,
        },
      })),
    };
    const proof = await reauthenticateWithPasskey(reauthApi, authenticator, "u1");
    expect(proof.reauthToken).toBe("tok");
    expect(proof.rootKey).toEqual(rootKey);
    expect(reauthApi.passkeyReauth.mock.calls[0]![0].clientExtensionResults).toEqual({});
  });

  it("sets a password with a passkey proof, wrapping the root under the new password", async () => {
    const rootKey = randomBytes(32);
    const salt = "00".repeat(16);
    const payload = await buildE2eePasswordChange(
      {
        salt,
        kdf: LEGACY_KDF,
        dek: generateDek(),
        privateKey: generateUserKeypair().secretKey,
        root: { userId: "u1" },
      },
      { reauthToken: "tok", rootKey },
      "new password",
      LEGACY_KDF,
    );
    expect(payload.reauth_token).toBe("tok");
    expect(payload.current_password).toBeUndefined();
    const { mek, authHash } = await deriveAuthAndMekAsync("new password", salt, LEGACY_KDF);
    expect(payload.new_password).toBe(authHash);
    expect(unwrapRootKey(payload.encrypted_root_key!, mek, "u1", "password")).toEqual(rootKey);
  });

  it("replaces the recovery phrase with a passkey proof", async () => {
    const rootKey = randomBytes(32);
    const { payload } = await buildRecoveryPhraseReplacement(
      {
        salt: "00".repeat(16),
        kdf: LEGACY_KDF,
        dek: generateDek(),
        privateKey: generateUserKeypair().secretKey,
        root: { userId: "u1" },
      },
      { reauthToken: "tok", rootKey },
    );
    expect(payload.reauth_token).toBe("tok");
    expect(payload.current_password).toBeUndefined();
    expect(payload.recovery_encrypted_root_key).toBeDefined();
  });

  it("strips PRF results but keeps other extension outputs", () => {
    const stripped = withoutPrfOutput(
      { clientExtensionResults: { prf: { results: { first: "x" } }, credProps: { rk: true } } },
      true,
    );
    expect(stripped.clientExtensionResults).toEqual({
      credProps: { rk: true },
      prf: { enabled: true },
    });
  });
});
