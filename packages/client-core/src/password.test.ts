import { describe, expect, it } from "vitest";
import {
  buildE2eePasswordChange,
  buildKdfUpgrade,
  buildRecoveryKeyRegistration,
  buildRecoveryPhraseReplacement,
  buildRecoveryRequest,
  RecoveryPhraseError,
  verifyAccountPassword,
} from "./password";
import {
  LEGACY_KDF,
  bytesToHex,
  deriveAuthAndMekAsync,
  deriveRecoveryAuthKeypair,
  deriveRecoveryKey,
  generateDek,
  generateRecoveryPhrase,
  generateSalt,
  generateUserKeypair,
  randomBytes,
  sealKey,
  unwrapKey,
  validateRecoveryPhrase,
  wrapKey,
  type Argon2idKdf,
  type PasswordKdf,
} from "./crypto";
import type { RecoveryKeysResponse } from "./types";

/**
 * A version-2 KDF far below the bounds a server may name, so these tests run the Argon2id path in
 * milliseconds; the derivation only ever takes it from its caller.
 */
const TEST_ARGON2ID: Argon2idKdf = { version: 2, memoryKib: 256, iterations: 1, parallelism: 1 };
const TEST_ARGON2ID_WIRE = {
  kdf_version: 2,
  kdf_params: { iterations: 1, memory_kib: 256, parallelism: 1 },
};

describe("buildE2eePasswordChange", () => {
  // Full PBKDF2 derivations before the expects: on a loaded CI runner (all test jobs share it)
  // this crossed vitest's 5s default and timed out, so give the KDF room to breathe.
  it("re-wraps the key material under the new password and KDF, keeping the salt", async () => {
    const salt = generateSalt();
    const dek = generateDek();
    const privateKey = generateDek();

    const payload = await buildE2eePasswordChange(
      { salt, kdf: LEGACY_KDF, dek, privateKey },
      "old password",
      "new password",
      TEST_ARGON2ID,
    );

    // The current credential is what login would derive from the old password with the account's
    // KDF, so the server's stored hash verifies it exactly as at login.
    expect(payload.current_password).toBe(
      (await deriveAuthAndMekAsync("old password", salt, LEGACY_KDF)).authHash,
    );
    const next = await deriveAuthAndMekAsync("new password", salt, TEST_ARGON2ID);
    expect(payload.new_password).toBe(next.authHash);
    expect(payload).toMatchObject(TEST_ARGON2ID_WIRE);

    // The wrapped blobs unwrap with the NEW MEK to the original keys...
    expect(unwrapKey(payload.encrypted_dek, next.mek)).toEqual(dek);
    expect(unwrapKey(payload.encrypted_private_key, next.mek)).toEqual(privateKey);

    // ...and not with the old one: the point of the exercise.
    const old = await deriveAuthAndMekAsync("old password", salt, LEGACY_KDF);
    expect(() => unwrapKey(payload.encrypted_dek, old.mek)).toThrow();
    expect(() => unwrapKey(payload.encrypted_private_key, old.mek)).toThrow();
  }, 30_000);

  it("sends exactly the fields the endpoint requires", async () => {
    // No device id, no recovery fields: the E2EE helper sends exactly what the endpoint requires.
    const salt = generateSalt();
    const payload = await buildE2eePasswordChange(
      { salt, kdf: TEST_ARGON2ID, dek: generateDek(), privateKey: generateDek() },
      "a",
      "b",
      TEST_ARGON2ID,
    );
    expect(Object.keys(payload).sort()).toEqual([
      "current_password",
      "encrypted_dek",
      "encrypted_private_key",
      "kdf_params",
      "kdf_version",
      "new_password",
    ]);
  });
});

describe("buildKdfUpgrade", () => {
  it("re-wraps only the password-derived layer under the new KDF, for the same password", async () => {
    // Cheap parameters of each version: this is about what is re-wrapped, not the KDF itself,
    // whose real parameters (kdf-vectors.test.ts) take many seconds in pure JS on a busy runner.
    const oldKdf: PasswordKdf = { version: 1, iterations: 1_000 };
    const newKdf: PasswordKdf = { version: 2, memoryKib: 64, iterations: 1, parallelism: 1 };
    const salt = generateSalt();
    const dek = generateDek();
    const privateKey = generateDek();
    const signedIn = await deriveAuthAndMekAsync("the password", salt, oldKdf);

    const payload = await buildKdfUpgrade(
      { salt, dek, privateKey },
      "the password",
      signedIn.authHash,
      newKdf,
    );

    expect(Object.keys(payload).sort()).toEqual([
      "current_password",
      "encrypted_dek",
      "encrypted_private_key",
      "kdf_params",
      "kdf_upgrade",
      "kdf_version",
      "new_password",
    ]);
    // The credential the sign-in proved, not a second derivation of it.
    expect(payload.current_password).toBe(signedIn.authHash);
    expect(payload).toMatchObject({
      kdf_version: 2,
      kdf_params: { iterations: 1, memory_kib: 64, parallelism: 1 },
      kdf_upgrade: true,
    });
    const upgraded = await deriveAuthAndMekAsync("the password", salt, newKdf);
    expect(payload.new_password).toBe(upgraded.authHash);
    expect(payload.new_password).not.toBe(signedIn.authHash);
    expect(unwrapKey(payload.encrypted_dek, upgraded.mek)).toEqual(dek);
    expect(unwrapKey(payload.encrypted_private_key, upgraded.mek)).toEqual(privateKey);
    expect(() => unwrapKey(payload.encrypted_dek, signedIn.mek)).toThrow();
  });
});

describe("buildRecoveryRequest", () => {
  /**
   * A recovery-keys response exactly as the server hands it out, plus the secrets behind it.
   * Version 2 seals the challenge to the phrase-derived recovery key, version 1 (an account that
   * has not registered one yet) to the account's own public key.
   */
  function recoverableAccount(version: 1 | 2 = 1) {
    const salt = generateSalt();
    const phrase = generateRecoveryPhrase();
    const dek = generateDek();
    const keypair = generateUserKeypair();
    const recoveryKey = deriveRecoveryKey(phrase, salt);
    const recipient =
      version === 2 ? deriveRecoveryAuthKeypair(phrase, salt).publicKey : keypair.publicKey;
    const nonce = randomBytes(32);
    const response: RecoveryKeysResponse = {
      salt,
      recovery_encrypted_dek: wrapKey(dek, recoveryKey),
      recovery_encrypted_private_key: wrapKey(keypair.secretKey, recoveryKey),
      recovery_key_version: version,
      challenge: { token: "challenge-token", sealed: sealKey(nonce, recipient) },
    };
    return { salt, phrase, dek, keypair, nonce, response };
  }

  it("answers a version-2 challenge with the phrase-derived recovery key", async () => {
    const acct = recoverableAccount(2);

    const payload = await buildRecoveryRequest(
      acct.response,
      acct.phrase,
      "new password",
      "a@b.dev",
      TEST_ARGON2ID,
    );

    expect(payload.challenge_response).toBe(bytesToHex(acct.nonce));
    const next = await deriveAuthAndMekAsync("new password", acct.salt, TEST_ARGON2ID);
    expect(unwrapKey(payload.encrypted_dek, next.mek)).toEqual(acct.dek);
    expect(unwrapKey(payload.encrypted_private_key, next.mek)).toEqual(acct.keypair.secretKey);
  });

  it("does not answer a version-2 challenge with the account's private key", async () => {
    // The whole point of version 2: a device key (held by every signed-in device) is not the phrase.
    const acct = recoverableAccount(2);
    const sealedToDevice: RecoveryKeysResponse = {
      ...acct.response,
      challenge: { token: "t", sealed: sealKey(acct.nonce, acct.keypair.publicKey) },
    };
    await expect(
      buildRecoveryRequest(sealedToDevice, acct.phrase, "new password", "a@b.dev", TEST_ARGON2ID),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });

  it("proves the private key and re-wraps the keys under the new password with the SAME salt", async () => {
    const acct = recoverableAccount();

    const payload = await buildRecoveryRequest(
      acct.response,
      acct.phrase,
      "new password",
      "a@b.dev",
      TEST_ARGON2ID,
    );

    expect(Object.keys(payload).sort()).toEqual([
      "challenge_response",
      "challenge_token",
      "email",
      "encrypted_dek",
      "encrypted_private_key",
      "kdf_params",
      "kdf_version",
      "new_auth_hash",
    ]);
    expect(payload).toMatchObject(TEST_ARGON2ID_WIRE);
    expect(payload.email).toBe("a@b.dev");
    expect(payload.challenge_token).toBe("challenge-token");
    // The unsealed nonce, lowercase hex: the server compares it byte for byte.
    expect(payload.challenge_response).toBe(bytesToHex(acct.nonce));
    expect(payload.challenge_response).toMatch(/^[0-9a-f]{64}$/);

    // The salt is immutable: login derives from (password, existing salt), so must the new hash.
    const next = await deriveAuthAndMekAsync("new password", acct.salt, TEST_ARGON2ID);
    expect(payload.new_auth_hash).toBe(next.authHash);
    expect(unwrapKey(payload.encrypted_dek, next.mek)).toEqual(acct.dek);
    expect(unwrapKey(payload.encrypted_private_key, next.mek)).toEqual(acct.keypair.secretKey);
  });

  it("rejects a wrong phrase with a RecoveryPhraseError before building anything", async () => {
    const acct = recoverableAccount();

    // A valid BIP-39 phrase that simply is not this account's: AES-GCM refuses to unwrap.
    await expect(
      buildRecoveryRequest(
        acct.response,
        generateRecoveryPhrase(),
        "new password",
        "a@b.dev",
        TEST_ARGON2ID,
      ),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
    // Not a BIP-39 phrase at all (typo'd word / bad checksum).
    await expect(
      buildRecoveryRequest(
        acct.response,
        "not a real phrase",
        "new password",
        "a@b.dev",
        TEST_ARGON2ID,
      ),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });

  it("treats the server's undecryptable dummy answer exactly like a wrong phrase", async () => {
    // Unknown and legacy addresses get well-formed but meaningless blobs (anti-enumeration), so
    // the client must fail the same way it does for a wrong phrase on a real account.
    const acct = recoverableAccount();
    const dummy = "00112233445566778899aabbccddeeff";
    const response: RecoveryKeysResponse = {
      salt: dummy,
      recovery_encrypted_dek: { iv: dummy, ct: dummy },
      recovery_encrypted_private_key: { iv: dummy, ct: dummy },
      challenge: acct.response.challenge,
    };
    await expect(
      buildRecoveryRequest(response, acct.phrase, "new password", "a@b.dev", TEST_ARGON2ID),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });
});

describe("buildRecoveryKeyRegistration", () => {
  async function account() {
    const salt = generateSalt();
    const phrase = generateRecoveryPhrase();
    const dek = generateDek();
    const keypair = generateUserKeypair();
    const recoveryKey = deriveRecoveryKey(phrase, salt);
    const recoveryKeys: RecoveryKeysResponse = {
      salt,
      recovery_encrypted_dek: wrapKey(dek, recoveryKey),
      recovery_encrypted_private_key: wrapKey(keypair.secretKey, recoveryKey),
      recovery_key_version: 1,
    };
    return { salt, phrase, dek, recoveryKeys };
  }

  it("proves the phrase against the account's recovery blob and sends the phrase-derived key", async () => {
    const acct = await account();

    const body = await buildRecoveryKeyRegistration(
      acct.recoveryKeys,
      { salt: acct.salt, kdf: TEST_ARGON2ID, dek: acct.dek },
      acct.phrase,
      "the password",
    );

    expect(Object.keys(body).sort()).toEqual(["current_password", "recovery_public_key"]);
    expect(body.current_password).toBe(
      (await deriveAuthAndMekAsync("the password", acct.salt, TEST_ARGON2ID)).authHash,
    );
    expect(body.recovery_public_key).toBe(
      deriveRecoveryAuthKeypair(acct.phrase, acct.salt).publicKey,
    );
  });

  it("refuses a phrase that does not open the account's recovery blob", async () => {
    const acct = await account();
    await expect(
      buildRecoveryKeyRegistration(
        acct.recoveryKeys,
        { salt: acct.salt, kdf: TEST_ARGON2ID, dek: acct.dek },
        generateRecoveryPhrase(),
        "the password",
      ),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
    await expect(
      buildRecoveryKeyRegistration(
        acct.recoveryKeys,
        { salt: acct.salt, kdf: TEST_ARGON2ID, dek: acct.dek },
        "not a phrase",
        "the password",
      ),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });

  it("refuses a blob that opens to another key than this session's DEK", async () => {
    // A blob that is not this account's (the server's dummy, or a mixed-up answer) must not
    // register a key: the phrase would then recover some other DEK, not this account's data.
    const acct = await account();
    await expect(
      buildRecoveryKeyRegistration(
        acct.recoveryKeys,
        { salt: acct.salt, kdf: TEST_ARGON2ID, dek: generateDek() },
        acct.phrase,
        "the password",
      ),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });
});

describe("buildRecoveryPhraseReplacement", () => {
  function account() {
    const salt = generateSalt();
    const keypair = generateUserKeypair();
    return {
      salt,
      material: { salt, kdf: TEST_ARGON2ID, dek: generateDek(), privateKey: keypair.secretKey },
    };
  }

  it("makes a new phrase and wraps the keys under it the way signup does", async () => {
    const acct = account();

    const { phrase, payload } = await buildRecoveryPhraseReplacement(acct.material, "the password");

    expect(validateRecoveryPhrase(phrase)).toBe(true);
    expect(Object.keys(payload).sort()).toEqual([
      "current_password",
      "recovery_encrypted_dek",
      "recovery_encrypted_private_key",
      "recovery_public_key",
    ]);
    expect(payload.current_password).toBe(
      (await deriveAuthAndMekAsync("the password", acct.salt, TEST_ARGON2ID)).authHash,
    );
    expect(payload.recovery_public_key).toBe(
      deriveRecoveryAuthKeypair(phrase, acct.salt).publicKey,
    );
    const recoveryKey = deriveRecoveryKey(phrase, acct.salt);
    expect(unwrapKey(payload.recovery_encrypted_dek, recoveryKey)).toEqual(acct.material.dek);
    expect(unwrapKey(payload.recovery_encrypted_private_key, recoveryKey)).toEqual(
      acct.material.privateKey,
    );
  });

  it("recovers the account with the new phrase and not with another", async () => {
    const acct = account();
    const { phrase, payload } = await buildRecoveryPhraseReplacement(acct.material, "pw");
    const other = await buildRecoveryPhraseReplacement(acct.material, "pw");
    expect(other.phrase).not.toBe(phrase);

    // What `GET /auth/recovery-keys` answers once the server stored the payload.
    const nonce = randomBytes(32);
    const recoveryKeys: RecoveryKeysResponse = {
      salt: acct.salt,
      recovery_encrypted_dek: payload.recovery_encrypted_dek,
      recovery_encrypted_private_key: payload.recovery_encrypted_private_key,
      recovery_key_version: 2,
      challenge: { token: "t", sealed: sealKey(nonce, payload.recovery_public_key) },
    };
    const recovered = await buildRecoveryRequest(
      recoveryKeys,
      phrase,
      "new password",
      "a@b.dev",
      TEST_ARGON2ID,
    );
    expect(recovered.challenge_response).toBe(bytesToHex(nonce));
    await expect(
      buildRecoveryRequest(recoveryKeys, other.phrase, "new password", "a@b.dev", TEST_ARGON2ID),
    ).rejects.toBeInstanceOf(RecoveryPhraseError);
  });
});

describe("verifyAccountPassword", () => {
  async function account(password: string) {
    const salt = generateSalt();
    const dek = generateDek();
    const { mek } = await deriveAuthAndMekAsync(password, salt, TEST_ARGON2ID);
    return { material: { salt, kdf: TEST_ARGON2ID, encryptedDek: wrapKey(dek, mek) }, dek };
  }

  it("accepts the password that wraps the session's DEK", async () => {
    const { material, dek } = await account("correct horse");
    expect(await verifyAccountPassword(material, "correct horse")).toBe(true);
    expect(await verifyAccountPassword(material, "correct horse", dek)).toBe(true);
  });

  it("refuses any other password", async () => {
    const { material, dek } = await account("correct horse");
    expect(await verifyAccountPassword(material, "correct horsE", dek)).toBe(false);
    expect(await verifyAccountPassword(material, "", dek)).toBe(false);
  });

  it("refuses a blob that does not hold the unlocked DEK", async () => {
    const { material } = await account("correct horse");
    expect(await verifyAccountPassword(material, "correct horse", generateDek())).toBe(false);
  });
});
