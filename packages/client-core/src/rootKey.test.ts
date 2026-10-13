import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  buildRootKeyMigration,
  buildSignupRoot,
  ensureRootKey,
  openAccountKeys,
  openTodoAppKey,
  todoAppKeyRow,
} from "./rootKey";
import {
  buildE2eePasswordChange,
  buildKdfUpgrade,
  buildRecoveryPhraseReplacement,
  buildRecoveryRequest,
} from "./password";
import {
  deriveAuthAndMekAsync,
  deriveRecoveryKeys,
  generateAccountId,
  generateDek,
  generateRecoveryPhrase,
  generateRootKey,
  generateSalt,
  generateUserKeypair,
  openRecoverySlot,
  randomBytes,
  sealKey,
  sealRootKey,
  unsealRootKey,
  unwrapAppKey,
  unwrapRootKey,
  wrapKey,
  wrapRootKey,
  type Argon2idKdf,
} from "./crypto";
import type { RecoveryKeysResponse, RootKeyResponse } from "./types";

const TEST_KDF: Argon2idKdf = { version: 2, memoryKib: 256, iterations: 1, parallelism: 1 };

/** A migrated account: root, its password slot under `password`, legacy wraps alongside. */
async function account(password = "pw") {
  const userId = generateAccountId();
  const salt = generateSalt();
  const { authHash, mek } = await deriveAuthAndMekAsync(password, salt, TEST_KDF);
  const dek = generateDek();
  const keypair = generateUserKeypair();
  const rootKey = generateRootKey();
  return {
    userId,
    salt,
    authHash,
    mek,
    dek,
    privateKey: keypair.secretKey,
    rootKey,
    encryptedRootKey: wrapRootKey(rootKey, mek, userId, "password"),
    appKeys: [todoAppKeyRow(rootKey, userId, { dek, privateKey: keypair.secretKey })],
    encryptedDek: wrapKey(dek, mek),
    encryptedPrivateKey: wrapKey(keypair.secretKey, mek),
  };
}

describe("openAccountKeys", () => {
  it("prefers the root path, and gives the root back", async () => {
    const a = await account();
    const keys = openAccountKeys({ ...a, encryptedDek: undefined, encryptedPrivateKey: undefined });
    expect(keys.source).toBe("root");
    expect(keys.dek).toEqual(a.dek);
    expect(keys.privateKey).toEqual(a.privateKey);
    expect(keys.rootKey).toEqual(a.rootKey);
  });

  it("falls back to the legacy wraps for an unmigrated account or a stale slot", async () => {
    const a = await account();
    const legacy = openAccountKeys({ ...a, encryptedRootKey: undefined, appKeys: undefined });
    expect(legacy).toMatchObject({ source: "legacy", rootKey: null });
    expect(legacy.dek).toEqual(a.dek);

    // A slot under an older password (a client predating root keys changed it).
    const stale = wrapRootKey(a.rootKey, randomBytes(32), a.userId, "password");
    const keys = openAccountKeys({ ...a, encryptedRootKey: stale });
    expect(keys.source).toBe("legacy");
    expect(keys.dek).toEqual(a.dek);
  });

  it("throws for a wrong password", async () => {
    const a = await account();
    expect(() => openAccountKeys({ ...a, mek: randomBytes(32) })).toThrow();
  });
});

describe("buildSignupRoot", () => {
  it("wraps one root under the MEK and the phrase, over the DEK as the todo key", () => {
    const mek = randomBytes(32);
    const recoveryWrapKey = randomBytes(32);
    const dek = generateDek();
    const privateKey = generateDek();
    const root = buildSignupRoot({ mek, recoveryWrapKey, dek, privateKey });
    const viaPassword = unwrapRootKey(root.encryptedRootKey, mek, root.userId, "password");
    const viaPhrase = unwrapRootKey(
      root.recoveryEncryptedRootKey,
      recoveryWrapKey,
      root.userId,
      "recovery",
    );
    expect(viaPhrase).toEqual(viaPassword);
    const todo = openTodoAppKey(viaPassword, root.userId, root.appKeys);
    expect(todo.dek).toEqual(dek);
    expect(todo.privateKey).toEqual(privateKey);
  });
});

describe("ensureRootKey", () => {
  function fakeApi(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      migrateRootKey: vi.fn(async (_payload: unknown) => {}),
      getRootKey: vi.fn(async (): Promise<RootKeyResponse> => {
        throw new Error("not expected");
      }),
      putRecoveryRootKey: vi.fn(async (_payload: unknown) => {}),
      ...overrides,
    };
  }

  it("migrates an account without a root, sealing the recovery slot to its recovery key", async () => {
    const a = await account();
    const recovery = generateUserKeypair();
    const api = fakeApi();
    const result = await ensureRootKey(api, {
      ...a,
      rootKey: null,
      state: { hasRootKey: false, recoveryPublicKey: recovery.publicKey },
    });
    expect(api.migrateRootKey).toHaveBeenCalledOnce();
    const payload = api.migrateRootKey.mock.calls[0]![0] as unknown as ReturnType<
      typeof buildRootKeyMigration
    >["payload"];
    expect(payload.current_password).toBe(a.authHash);
    expect(payload.recovery_public_key).toBe(recovery.publicKey);
    const root = unwrapRootKey(payload.encrypted_root_key, a.mek, a.userId, "password");
    expect(root).toEqual(result!.rootKey);
    expect(
      unsealRootKey(payload.recovery_encrypted_root_key!, recovery.secretKey, a.userId),
    ).toEqual(root);
    // The DEK is the todo key, unchanged.
    expect(openTodoAppKey(root, a.userId, payload.app_keys).dek).toEqual(a.dek);
    expect(result!.state).toMatchObject({ hasRootKey: true, hasRecoveryRootKey: true });
  });

  it("leaves the recovery slot empty for an account without a recovery key", async () => {
    const a = await account();
    const api = fakeApi();
    const result = await ensureRootKey(api, { ...a, rootKey: null, state: { hasRootKey: false } });
    const payload = api.migrateRootKey.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(payload.recovery_encrypted_root_key).toBeUndefined();
    expect(result!.state.hasRecoveryRootKey).toBe(false);
  });

  it("loads the winner's root when another device migrated first", async () => {
    const a = await account();
    const api = fakeApi({
      migrateRootKey: vi.fn(async () => {
        throw new ApiError(409, "exists", { code: "root_key_exists" });
      }),
      getRootKey: vi.fn(async (): Promise<RootKeyResponse> => ({
        has_root_key: true,
        encrypted_root_key: a.encryptedRootKey,
        has_recovery_root_key: true,
        recovery_public_key: null,
        app_keys: a.appKeys,
      })),
    });
    const result = await ensureRootKey(api, { ...a, rootKey: null, state: { hasRootKey: false } });
    expect(result!.rootKey).toEqual(a.rootKey);
    expect(result!.state.appKeys).toEqual(a.appKeys);
  });

  it("passes other migration failures on", async () => {
    const a = await account();
    const api = fakeApi({
      migrateRootKey: vi.fn(async () => {
        throw new ApiError(403, "invalid_credentials", { code: "invalid_credentials" });
      }),
    });
    await expect(
      ensureRootKey(api, { ...a, rootKey: null, state: { hasRootKey: false } }),
    ).rejects.toThrow(ApiError);
  });

  it("fills an empty recovery slot, and does nothing otherwise", async () => {
    const a = await account();
    const recovery = generateUserKeypair();
    const api = fakeApi();
    const state = {
      hasRootKey: true,
      hasRecoveryRootKey: false,
      recoveryPublicKey: recovery.publicKey,
    };
    const result = await ensureRootKey(api, { ...a, state });
    const body = api.putRecoveryRootKey.mock.calls[0]![0] as unknown as {
      recovery_encrypted_root_key: Parameters<typeof unsealRootKey>[0];
    };
    expect(unsealRootKey(body.recovery_encrypted_root_key, recovery.secretKey, a.userId)).toEqual(
      a.rootKey,
    );
    expect(result!.state.hasRecoveryRootKey).toBe(true);

    expect(
      await ensureRootKey(fakeApi(), {
        ...a,
        state: { hasRootKey: true, hasRecoveryRootKey: true },
      }),
    ).toBeNull();
    // A server predating root keys says nothing: nothing is attempted.
    const old = fakeApi();
    expect(await ensureRootKey(old, { ...a, rootKey: null, state: {} })).toBeNull();
    expect(old.migrateRootKey).not.toHaveBeenCalled();
  });
});

describe("credential changes keep the root slot in step", () => {
  it("a password change re-wraps the root under the new MEK", async () => {
    const a = await account("old");
    const payload = await buildE2eePasswordChange(
      {
        salt: a.salt,
        kdf: TEST_KDF,
        dek: a.dek,
        privateKey: a.privateKey,
        root: { userId: a.userId, encryptedRootKey: a.encryptedRootKey },
      },
      "old",
      "new",
      TEST_KDF,
    );
    const { mek } = await deriveAuthAndMekAsync("new", a.salt, TEST_KDF);
    expect(unwrapRootKey(payload.encrypted_root_key!, mek, a.userId, "password")).toEqual(
      a.rootKey,
    );
  });

  it("a password change sends no root slot when the stored one does not open", async () => {
    const a = await account("old");
    const payload = await buildE2eePasswordChange(
      {
        salt: a.salt,
        kdf: TEST_KDF,
        dek: a.dek,
        privateKey: a.privateKey,
        root: {
          userId: a.userId,
          encryptedRootKey: wrapRootKey(a.rootKey, randomBytes(32), a.userId, "password"),
        },
      },
      "old",
      "new",
      TEST_KDF,
    );
    expect(payload.encrypted_root_key).toBeUndefined();
  });

  it("a KDF upgrade re-wraps the root it was given", async () => {
    const a = await account();
    const next: Argon2idKdf = { ...TEST_KDF, iterations: 2 };
    const payload = await buildKdfUpgrade(
      {
        salt: a.salt,
        dek: a.dek,
        privateKey: a.privateKey,
        root: { userId: a.userId, rootKey: a.rootKey },
      },
      "pw",
      a.authHash,
      next,
    );
    const { mek } = await deriveAuthAndMekAsync("pw", a.salt, next);
    expect(unwrapRootKey(payload.encrypted_root_key!, mek, a.userId, "password")).toEqual(
      a.rootKey,
    );
  });

  it("a new phrase gets the root in its recovery slot", async () => {
    const a = await account("pw");
    const { phrase, payload } = await buildRecoveryPhraseReplacement(
      {
        salt: a.salt,
        kdf: TEST_KDF,
        dek: a.dek,
        privateKey: a.privateKey,
        root: { userId: a.userId, encryptedRootKey: a.encryptedRootKey },
      },
      "pw",
    );
    const keys = deriveRecoveryKeys(phrase, a.salt);
    expect(
      unwrapRootKey(payload.recovery_encrypted_root_key!, keys.wrapKey, a.userId, "recovery"),
    ).toEqual(a.rootKey);
  });
});

describe("buildRecoveryRequest with a root key", () => {
  /** A version-2 recovery lookup for a migrated account; `slot` picks the recovery slot's form. */
  async function lookup(slot: "phrase" | "sealed" | "dummy" | "planted") {
    const a = await account();
    const phrase = generateRecoveryPhrase();
    const keys = deriveRecoveryKeys(phrase, a.salt);
    const nonce = randomBytes(32);
    const slots = {
      phrase: {
        ...wrapRootKey(a.rootKey, keys.wrapKey, a.userId, "recovery"),
        epk: "ab".repeat(32),
      },
      sealed: sealRootKey(a.rootKey, keys.auth.publicKey, a.userId),
      dummy: { v: 1 as const, iv: "AAAAAAAAAAAAAAAA", ct: "A".repeat(64), epk: "cd".repeat(32) },
      // Anyone can seal to the recovery public key: a root the server chose.
      planted: sealRootKey(generateRootKey(), keys.auth.publicKey, a.userId),
    };
    const response: RecoveryKeysResponse = {
      salt: a.salt,
      recovery_encrypted_dek: wrapKey(a.dek, keys.wrapKey),
      recovery_encrypted_private_key: wrapKey(a.privateKey, keys.wrapKey),
      recovery_key_version: 2,
      challenge: { token: "t", sealed: sealKey(nonce, keys.auth.publicKey) },
      user_id: a.userId,
      recovery_encrypted_root_key: slots[slot],
      todo_app_key: a.appKeys[0]!.wrapped_key,
    };
    return { a, phrase, keys, response };
  }

  for (const form of ["phrase", "sealed"] as const) {
    it(`keeps a root recovered from a ${form}-form slot`, async () => {
      const { a, phrase, keys, response } = await lookup(form);
      const payload = await buildRecoveryRequest(response, phrase, "new", "e@x.io", TEST_KDF);
      const { mek } = await deriveAuthAndMekAsync("new", a.salt, TEST_KDF);
      expect(unwrapRootKey(payload.encrypted_root_key!, mek, a.userId, "password")).toEqual(
        a.rootKey,
      );
      expect(payload.app_keys).toBeUndefined();
      // The slot comes back in the phrase form, which only the phrase could have made.
      expect(
        unwrapRootKey(payload.recovery_encrypted_root_key!, keys.wrapKey, a.userId, "recovery"),
      ).toEqual(a.rootKey);
    });
  }

  for (const form of ["dummy", "planted"] as const) {
    it(`starts a new root over the same DEK when the slot is ${form}`, async () => {
      const { a, phrase, keys, response } = await lookup(form);
      const payload = await buildRecoveryRequest(response, phrase, "new", "e@x.io", TEST_KDF);
      const { mek } = await deriveAuthAndMekAsync("new", a.salt, TEST_KDF);
      const root = unwrapRootKey(payload.encrypted_root_key!, mek, a.userId, "password");
      expect(root).not.toEqual(a.rootKey);
      expect(unwrapAppKey(payload.app_keys![0]!.wrapped_key, root, a.userId, "todo")).toEqual(
        a.dek,
      );
      expect(
        openRecoverySlot(
          payload.recovery_encrypted_root_key!,
          { wrapKey: keys.wrapKey, secretKey: keys.auth.secretKey },
          a.userId,
        ),
      ).toEqual(root);
    });
  }

  it("adds nothing for a server predating root keys", async () => {
    const { phrase, response } = await lookup("phrase");
    delete response.user_id;
    const payload = await buildRecoveryRequest(response, phrase, "new", "e@x.io", TEST_KDF);
    expect(payload.encrypted_root_key).toBeUndefined();
    expect(payload.recovery_encrypted_root_key).toBeUndefined();
  });
});
