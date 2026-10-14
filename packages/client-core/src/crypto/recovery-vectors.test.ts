import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unsealKey, type SealedKey } from "./asym";
import { deriveRecoveryAuthKeypair, deriveRecoveryKey } from "./bip39";
import { bytesToHex, hexToBytes } from "./utils";

/**
 * The server seals the account-recovery challenge (`GET /auth/recovery-keys`) with its own Rust
 * implementation; these are the same vectors `crates/atlas-server/src/auth/recovery.rs` asserts.
 * If the two constructions ever drift, recovery fails for every account, so pin them together.
 */

interface Vector {
  name: string;
  recipient_secret_key: string;
  nonce: string;
  sealed: SealedKey;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/recovery_challenge_vectors.json", import.meta.url),
);
const { vectors } = JSON.parse(readFileSync(fixturePath, "utf8")) as { vectors: Vector[] };

describe("recovery challenge vectors", () => {
  it("has vectors to check", () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    it(`unseals the server-sealed nonce: ${v.name}`, () => {
      const nonce = unsealKey(v.sealed, hexToBytes(v.recipient_secret_key));
      expect(bytesToHex(nonce)).toBe(v.nonce);
    });
  }
});

/**
 * The phrase-derived recovery keypair the server seals version-2 challenges to. The server never
 * derives it (it only stores the public half), so this vector pins the client against an
 * independent computation (Node's `crypto`: PBKDF2-SHA512 for the BIP-39 seed, `hkdfSync`, and an
 * X25519 key object): changing the derivation would lock every account out of recovery.
 */
describe("recovery auth key vector", () => {
  const phrase = `${"abandon ".repeat(23)}art`;
  const salt = "000102030405060708090a0b0c0d0e0f";

  it("derives the X25519 recovery keypair from the phrase and the account salt", () => {
    const { secretKey, publicKey } = deriveRecoveryAuthKeypair(phrase, salt);
    expect(bytesToHex(secretKey)).toBe(
      "1ca22a71ab3e46ebc07b4595fdb6b7ee134264622ade0ff4ba1fef4b8ae4c9a2",
    );
    expect(publicKey).toBe("aa220e9ecb457515995ebfbfe9e7e87e67eeac5b41df7e34d68c2b1549535b3f");
  });

  it("tolerates the same phrase typed with other case and spacing", () => {
    const messy = `  ${phrase.toUpperCase().replace(/ /g, "   ")}\n`;
    expect(deriveRecoveryAuthKeypair(messy, salt).publicKey).toBe(
      deriveRecoveryAuthKeypair(phrase, salt).publicKey,
    );
  });

  it("is domain-separated from the key that wraps the recovery blobs", () => {
    expect(bytesToHex(deriveRecoveryKey(phrase, salt))).toBe(
      "d23581044de1b36f48012c0554e03b269d7bd28e38e450868a5347cd6403839e",
    );
    expect(bytesToHex(deriveRecoveryAuthKeypair(phrase, salt).secretKey)).not.toBe(
      bytesToHex(deriveRecoveryKey(phrase, salt)),
    );
  });

  it("refuses a phrase that is not valid BIP-39", () => {
    expect(() => deriveRecoveryAuthKeypair("abandon abandon abandon", salt)).toThrow();
  });
});

/** The same derivation as a shared fixture, which the Rust client asserts too. */
describe("recovery key vectors (test-vectors/recovery_key_vectors.json)", () => {
  const path = fileURLToPath(
    new URL("../../../../test-vectors/recovery_key_vectors.json", import.meta.url),
  );
  const fixture = JSON.parse(readFileSync(path, "utf8")) as {
    vectors: {
      name: string;
      phrase: string;
      salt: string;
      wrap_key: string;
      auth_secret_key: string;
      auth_public_key: string;
    }[];
    invalid: string[];
  };

  for (const v of fixture.vectors) {
    it(`derives the recovery keys: ${v.name}`, () => {
      expect(bytesToHex(deriveRecoveryKey(v.phrase, v.salt))).toBe(v.wrap_key);
      const auth = deriveRecoveryAuthKeypair(v.phrase, v.salt);
      expect(bytesToHex(auth.secretKey)).toBe(v.auth_secret_key);
      expect(auth.publicKey).toBe(v.auth_public_key);
    });
  }

  it("refuses the invalid phrases", () => {
    for (const phrase of fixture.invalid) {
      expect(() => deriveRecoveryKey(phrase, "00")).toThrow();
    }
  });
});
