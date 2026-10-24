import { describe, expect, it, test } from "vitest";
import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  decryptAesGcm,
  decryptJson,
  deriveAuthAndMek,
  deriveAuthAndMekAsync,
  deriveRecoveryKey,
  encryptAesGcm,
  encryptJson,
  generateDek,
  generatePek,
  generateRecoveryPhrase,
  generateSalt,
  generateUserKeypair,
  hexToBytes,
  Keyring,
  MissingScopeKey,
  sealKey,
  setPbkdf2Provider,
  unsealKey,
  unwrapKey,
  utf8ToBytes,
  validateRecoveryPhrase,
  wrapKey,
} from "./index";

describe("Crypto Utils", () => {
  test("hex encoding roundtrip", () => {
    const raw = new Uint8Array([0, 1, 2, 15, 16, 255]);
    const hex = bytesToHex(raw);
    expect(hex).toBe("0001020f10ff");
    expect(hexToBytes(hex)).toEqual(raw);
  });

  test("base64 encoding roundtrip", () => {
    const raw = utf8ToBytes("Zero Knowledge Test Payload 123! #%&");
    const b64 = bytesToBase64(raw);
    const decoded = base64ToBytes(b64);
    expect(bytesToUtf8(decoded)).toBe("Zero Knowledge Test Payload 123! #%&");
  });
});

describe("Key Derivation (KDF)", () => {
  test("salt generation produces 16 random bytes as hex", () => {
    const s1 = generateSalt();
    const s2 = generateSalt();
    expect(s1.length).toBe(32); // 16 bytes = 32 hex chars
    expect(s2.length).toBe(32);
    expect(s1).not.toBe(s2);
  });

  test("deriveAuthAndMek is deterministic", () => {
    const salt = generateSalt();
    const k1 = deriveAuthAndMek("super-secret-password", salt, 1000);
    const k2 = deriveAuthAndMek("super-secret-password", salt, 1000);

    expect(k1.authHash).toBe(k2.authHash);
    expect(bytesToHex(k1.mek)).toBe(bytesToHex(k2.mek));
    expect(k1.authHash.length).toBe(64); // 32 bytes hex
    expect(k1.mek.byteLength).toBe(32);
  });

  test("different passwords produce different keys", () => {
    const salt = generateSalt();
    const k1 = deriveAuthAndMek("passA", salt, 1000);
    const k2 = deriveAuthAndMek("passB", salt, 1000);

    expect(k1.authHash).not.toBe(k2.authHash);
    expect(bytesToHex(k1.mek)).not.toBe(bytesToHex(k2.mek));
  });

  test("deriveAuthAndMekAsync matches the pure-JS derivation (WebCrypto path)", async () => {
    // In Node the fast path is WebCrypto (no provider registered), so this is a real
    // cross-implementation check: OpenSSL's PBKDF2 must feed the same HKDF expansion.
    const salt = generateSalt();
    const sync = deriveAuthAndMek("super-secret-password", salt, 1000);
    const async = await deriveAuthAndMekAsync("super-secret-password", salt, {
      version: 1,
      iterations: 1000,
    });
    expect(async.authHash).toBe(sync.authHash);
    expect(bytesToHex(async.mek)).toBe(bytesToHex(sync.mek));
  });

  test("deriveAuthAndMekAsync honors a registered native provider", async () => {
    // Stand-in for quick-crypto: computes the same PBKDF2 via @noble, but through the provider
    // interface (and proves the provider is actually consulted, not bypassed).
    let calls = 0;
    setPbkdf2Provider(async (password, saltBytes, iterations, keyLength) => {
      calls++;
      return pbkdf2(sha256, password, saltBytes, { c: iterations, dkLen: keyLength });
    });
    try {
      const salt = generateSalt();
      const sync = deriveAuthAndMek("provider-check", salt, 1000);
      const async = await deriveAuthAndMekAsync("provider-check", salt, {
        version: 1,
        iterations: 1000,
      });
      expect(calls).toBe(1);
      expect(async.authHash).toBe(sync.authHash);
      expect(bytesToHex(async.mek)).toBe(bytesToHex(sync.mek));
    } finally {
      setPbkdf2Provider(null);
    }
  });

  test("deriveAuthAndMekAsync falls back to pure JS when the provider throws", async () => {
    // On-device reality: a missing/failing native module (Expo Go, Jest, a broken build) must slow
    // login down, never break it.
    setPbkdf2Provider(async () => {
      throw new Error("native module unavailable");
    });
    try {
      const salt = generateSalt();
      const sync = deriveAuthAndMek("fallback-check", salt, 1000);
      const async = await deriveAuthAndMekAsync("fallback-check", salt, {
        version: 1,
        iterations: 1000,
      });
      expect(async.authHash).toBe(sync.authHash);
      expect(bytesToHex(async.mek)).toBe(bytesToHex(sync.mek));
    } finally {
      setPbkdf2Provider(null);
    }
  });
});

describe("AES-256-GCM", () => {
  test("encrypt and decrypt roundtrip", () => {
    const key = generateDek();
    const message = "Secret todo: buy milk and bananas";
    const encrypted = encryptAesGcm(key, message);

    expect(encrypted.iv).toBeDefined();
    expect(encrypted.ct).toBeDefined();

    const decrypted = decryptAesGcm(key, encrypted);
    expect(bytesToUtf8(decrypted)).toBe(message);
  });

  test("encrypt and decrypt JSON", () => {
    const key = generateDek();
    const payload = {
      title: "Encrypted Task",
      priority: 1,
      completed: false,
      tags: ["work", "e2ee"],
    };
    const encrypted = encryptJson(key, payload);

    const decrypted = decryptJson<typeof payload>(key, encrypted);
    expect(decrypted).toEqual(payload);
  });

  test("tampered ciphertext throws authentication error", () => {
    const key = generateDek();
    const encrypted = encryptAesGcm(key, "sensitive notes");

    const ctBytes = base64ToBytes(encrypted.ct);
    ctBytes[0]! ^= 0x01; // flip 1 bit
    const tampered = { iv: encrypted.iv, ct: bytesToBase64(ctBytes) };

    expect(() => decryptAesGcm(key, tampered)).toThrow();
  });

  test("decryption with wrong key fails", () => {
    const key1 = generateDek();
    const key2 = generateDek();
    const encrypted = encryptAesGcm(key1, "sensitive notes");

    expect(() => decryptAesGcm(key2, encrypted)).toThrow();
  });
});

describe("BIP-39 Recovery Phrase", () => {
  test("generates 24 valid words", () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(" ");
    expect(words.length).toBe(24);
    expect(validateRecoveryPhrase(phrase)).toBe(true);
  });

  test("validates recovery phrase rejects invalid words or bad checksum", () => {
    expect(validateRecoveryPhrase("abandon abandon abandon")).toBe(false);
    expect(validateRecoveryPhrase("notaword word foo bar baz")).toBe(false);
  });

  test("deriveRecoveryKey is deterministic for phrase + salt", () => {
    const phrase = generateRecoveryPhrase();
    const salt = generateSalt();

    const rk1 = deriveRecoveryKey(phrase, salt);
    const rk2 = deriveRecoveryKey(phrase, salt);

    expect(rk1.byteLength).toBe(32);
    expect(bytesToHex(rk1)).toBe(bytesToHex(rk2));
  });
});

describe("Asymmetric X25519 & PEK Sealing", () => {
  test("generates user keypair", () => {
    const kp = generateUserKeypair();
    expect(kp.publicKey.length).toBe(64); // 32 bytes hex
    expect(kp.secretKey.byteLength).toBe(32);
  });

  test("seals and unseals project key between users", () => {
    const userA = generateUserKeypair();
    const userB = generateUserKeypair();
    const pek = generatePek();

    const sealed = sealKey(pek, userB.publicKey);

    const unsealed = unsealKey(sealed, userB.secretKey);
    expect(bytesToHex(unsealed)).toBe(bytesToHex(pek));

    // User A cannot unseal it with User A's secret key (wrong recipient)
    expect(() => unsealKey(sealed, userA.secretKey)).toThrow();
  });
});

describe("Envelope Key Wrapping", () => {
  test("wraps and unwraps DEK with MEK", () => {
    const mek = generateDek();
    const dek = generateDek();

    const wrapped = wrapKey(dek, mek);
    const unwrapped = unwrapKey(wrapped, mek);

    expect(bytesToHex(unwrapped)).toBe(bytesToHex(dek));
  });
});

describe("Keyring Session Manager", () => {
  test("manages DEK and project keys", () => {
    const keyring = new Keyring();
    expect(keyring.hasKeys()).toBe(false);

    const dek = generateDek();
    keyring.setDek(dek);
    expect(keyring.hasKeys()).toBe(true);
    expect(keyring.getDek()).toEqual(dek);

    const projId = "proj-123";
    const pek = generatePek();
    keyring.setProjectKey(projId, pek);

    expect(keyring.getKeyForScope(projId, true)).toEqual(pek);
    // An unshared project without one, and personal content, use the DEK
    expect(keyring.getKeyForScope("unknown-proj", false)).toEqual(dek);
    expect(keyring.getKeyForScope(undefined, false)).toEqual(dek);
    // A shared project without its key never falls back to the DEK
    expect(() => keyring.getKeyForScope("unknown-proj", true)).toThrow(MissingScopeKey);

    keyring.clear();
    expect(keyring.hasKeys()).toBe(false);
    expect(() => keyring.getDek()).toThrow();
  });
});

describe("invite preview", () => {
  it("opens only for the project and key it was sealed with, and hides the name's length", async () => {
    const { sealInvitePreview, openInvitePreview, generatePek } = await import("./index");
    const pek = generatePek();
    const preview = { name: "Groceries", icon: "cart", color: "#00ff00", kind: "list" };
    const sealed = sealInvitePreview(pek, "kid-1", "project-1", preview);
    expect(sealed).toMatchObject({ v: 1, kid: "kid-1" });
    expect(JSON.stringify(sealed)).not.toContain("Groceries");
    expect(openInvitePreview(pek, "project-1", sealed)).toEqual(preview);
    expect(() => openInvitePreview(pek, "project-2", sealed)).toThrow();
    expect(() => openInvitePreview(generatePek(), "project-1", sealed)).toThrow();
    expect(() => openInvitePreview(pek, "project-1", { ...sealed, kid: "kid-2" })).toThrow();
    const short = sealInvitePreview(pek, "kid-1", "project-1", { name: "A" });
    expect(short.ct.length).toBe(
      sealInvitePreview(pek, "kid-1", "project-1", { name: "Abcdefgh" }).ct.length,
    );
  });
});
