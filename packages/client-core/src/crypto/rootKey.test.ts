import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateAccountId,
  generateRootKey,
  openRecoverySlot,
  sealRootKey,
  unsealRootKey,
  unwrapAppKey,
  unwrapAppPrivateKey,
  unwrapRootKey,
  wrapAppKey,
  wrapRootKey,
  type RootKeyWrap,
  type SealedRootKeyWrap,
} from "./rootKey";
import { bytesToHex, hexToBytes, randomBytes } from "./utils";
import { generateUserKeypair } from "./asym";

/** Pins the root key formats: a Rust client core must open what this one wrote, and back. */
interface Vector {
  name: string;
  user_id: string;
  root_key: string;
  mek: string;
  recovery_wrap_key: string;
  recovery_secret_key: string;
  recovery_public_key: string;
  passkey_credential: string;
  passkey_wrap_key: string;
  dek: string;
  private_key: string;
  notes_key: string;
  password_slot: RootKeyWrap;
  recovery_slot: RootKeyWrap;
  sealed_recovery_slot: SealedRootKeyWrap;
  passkey_slot: RootKeyWrap;
  todo_app_key: RootKeyWrap;
  todo_private_key: RootKeyWrap;
  notes_app_key: RootKeyWrap;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/root_key_vectors.json", import.meta.url),
);
const { vectors } = JSON.parse(readFileSync(fixturePath, "utf8")) as { vectors: Vector[] };

describe("root key vectors", () => {
  for (const v of vectors) {
    const root = hexToBytes(v.root_key);

    it(`opens every slot to the same root: ${v.name}`, () => {
      const open = (wrap: RootKeyWrap, key: string, slot: Parameters<typeof unwrapRootKey>[3]) =>
        bytesToHex(unwrapRootKey(wrap, hexToBytes(key), v.user_id, slot));
      expect(open(v.password_slot, v.mek, "password")).toBe(v.root_key);
      expect(open(v.recovery_slot, v.recovery_wrap_key, "recovery")).toBe(v.root_key);
      expect(open(v.passkey_slot, v.passkey_wrap_key, `passkey:${v.passkey_credential}`)).toBe(
        v.root_key,
      );
      const sealed = unsealRootKey(
        v.sealed_recovery_slot,
        hexToBytes(v.recovery_secret_key),
        v.user_id,
      );
      expect(bytesToHex(sealed)).toBe(v.root_key);
    });

    it(`opens the app keys under the root: ${v.name}`, () => {
      const dek = unwrapAppKey(v.todo_app_key, root, v.user_id, "todo");
      expect(bytesToHex(dek)).toBe(v.dek);
      expect(bytesToHex(unwrapAppPrivateKey(v.todo_private_key, dek, v.user_id, "todo"))).toBe(
        v.private_key,
      );
      expect(bytesToHex(unwrapAppKey(v.notes_app_key, root, v.user_id, "notes"))).toBe(v.notes_key);
    });

    it(`binds account, slot and app: ${v.name}`, () => {
      const other = "01920000-0000-4000-8000-0000000000bb";
      expect(() => unwrapRootKey(v.password_slot, hexToBytes(v.mek), other, "password")).toThrow();
      // The same key under another slot name does not open.
      expect(() =>
        unwrapRootKey(v.recovery_slot, hexToBytes(v.recovery_wrap_key), v.user_id, "password"),
      ).toThrow();
      expect(() =>
        unwrapRootKey(v.passkey_slot, hexToBytes(v.passkey_wrap_key), v.user_id, "passkey:cred-2"),
      ).toThrow();
      // The server cannot hand the notes key back as the todo key.
      expect(() => unwrapAppKey(v.notes_app_key, root, v.user_id, "todo")).toThrow();
      expect(() =>
        unsealRootKey(v.sealed_recovery_slot, hexToBytes(v.recovery_secret_key), other),
      ).toThrow();
    });

    it(`opens a recovery slot in either form: ${v.name}`, () => {
      const keys = {
        wrapKey: hexToBytes(v.recovery_wrap_key),
        secretKey: hexToBytes(v.recovery_secret_key),
      };
      expect(bytesToHex(openRecoverySlot(v.sealed_recovery_slot, keys, v.user_id))).toBe(
        v.root_key,
      );
      // The phrase form, padded with a stand-in epk as the recovery lookup sends it.
      const padded = { ...v.recovery_slot, epk: bytesToHex(randomBytes(32)) };
      expect(bytesToHex(openRecoverySlot(padded, keys, v.user_id))).toBe(v.root_key);
      expect(bytesToHex(openRecoverySlot(v.recovery_slot, keys, v.user_id))).toBe(v.root_key);
    });
  }
});

describe("root key wraps", () => {
  it("round-trip with fresh keys and refuse a wrong key", () => {
    const userId = generateAccountId();
    const root = generateRootKey();
    const mek = randomBytes(32);
    const wrap = wrapRootKey(root, mek, userId, "password");
    expect(wrap.v).toBe(1);
    expect(unwrapRootKey(wrap, mek, userId.toUpperCase(), "password")).toEqual(root);
    expect(() => unwrapRootKey(wrap, randomBytes(32), userId, "password")).toThrow();

    const appKey = randomBytes(32);
    expect(unwrapAppKey(wrapAppKey(appKey, root, userId, "vault"), root, userId, "vault")).toEqual(
      appKey,
    );
  });

  it("seals only to the recovery key's holder", () => {
    const userId = generateAccountId();
    const root = generateRootKey();
    const recovery = generateUserKeypair();
    const sealed = sealRootKey(root, recovery.publicKey, userId);
    expect(unsealRootKey(sealed, recovery.secretKey, userId)).toEqual(root);
    expect(() => unsealRootKey(sealed, generateUserKeypair().secretKey, userId)).toThrow();
  });

  it("makes v4 account ids", () => {
    expect(generateAccountId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(generateAccountId()).not.toBe(generateAccountId());
  });

  it("refuses keys of the wrong size", () => {
    expect(() => wrapRootKey(randomBytes(16), randomBytes(32), "u", "password")).toThrow();
  });
});
