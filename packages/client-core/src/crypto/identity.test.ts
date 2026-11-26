import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { generateDek } from "./envelope";
import {
  deliveryMessage,
  generateSigningKeypair,
  safetyNumber,
  safetyNumberGroups,
  sealDelivery,
  signDelivery,
  signingPublicKey,
  unwrapSigningKey,
  verifyDelivery,
  wrapSigningKey,
  type DeliveryFields,
  type IdentityKeys,
} from "./identity";
import { generateUserKeypair, unsealKey } from "./asym";
import { generatePek } from "./envelope";
import { bytesToHex, hexToBytes } from "./utils";

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/identity_vectors.json", import.meta.url),
);
const vectors = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  delivery: {
    signing_secret_key: string;
    signing_public_key: string;
    fields: DeliveryFields;
    message: string;
    signature: string;
  };
  safety_number: { a: IdentityKeys; b: IdentityKeys; number: string };
};

const ME = "0190a6f0-0000-7000-8000-0000000000e1";

describe("the identity signing key", () => {
  it("wraps under the DEK bound to its public half, and checks that half", () => {
    const dek = generateDek();
    const { publicKey, secretKey } = generateSigningKeypair();
    expect(signingPublicKey(secretKey)).toBe(publicKey);
    const wrapped = wrapSigningKey(secretKey, dek);
    expect(wrapped.v).toBe(1);
    expect(unwrapSigningKey(wrapped, dek, publicKey)).toEqual(secretKey);
    expect(unwrapSigningKey(wrapped, dek, publicKey.toUpperCase())).toEqual(secretKey);
    // Another DEK, or published as another key: refused.
    expect(() => unwrapSigningKey(wrapped, generateDek(), publicKey)).toThrow();
    expect(() => unwrapSigningKey(wrapped, dek, generateSigningKeypair().publicKey)).toThrow();
  });
});

describe("delivery signatures", () => {
  it("match the vectors", () => {
    const v = vectors.delivery;
    const secret = hexToBytes(v.signing_secret_key);
    expect(signingPublicKey(secret)).toBe(v.signing_public_key);
    expect(bytesToHex(deliveryMessage(v.fields))).toBe(v.message);
    expect(signDelivery(secret, v.fields)).toBe(v.signature);
    expect(verifyDelivery(v.signing_public_key, v.signature, v.fields)).toBe(true);
  });

  it("do not verify for any other project, recipient, key, sealed bytes or signer", () => {
    const v = vectors.delivery;
    const other = "0190a6f0-0000-7000-8000-00000000ffff";
    const variants: DeliveryFields[] = [
      { ...v.fields, projectId: other },
      { ...v.fields, recipientId: other },
      { ...v.fields, keyId: "ff".repeat(16) },
      { ...v.fields, sealed: { ...v.fields.sealed, ephemeralPublicKey: "cd".repeat(32) } },
      {
        ...v.fields,
        sealed: { ...v.fields.sealed, encryptedKey: { iv: "AAECAwQFBgcICQoM", ct: "3q2+7w==" } },
      },
      {
        ...v.fields,
        sealed: { ...v.fields.sealed, encryptedKey: { iv: "AAECAwQFBgcICQoL", ct: "3q2+7A==" } },
      },
    ];
    for (const fields of variants) {
      expect(verifyDelivery(v.signing_public_key, v.signature, fields)).toBe(false);
    }
    expect(verifyDelivery(generateSigningKeypair().publicKey, v.signature, v.fields)).toBe(false);
    expect(verifyDelivery(v.signing_public_key, "zz", v.fields)).toBe(false);
  });

  it("seal to the member and sign in one step", () => {
    const owner = generateSigningKeypair();
    const member = generateUserKeypair();
    const pek = generatePek();
    const { sealed, signature } = sealDelivery(pek, {
      projectId: vectors.delivery.fields.projectId,
      recipientId: ME,
      recipientPublicKey: member.publicKey,
      keyId: "00".repeat(16),
      signingKey: owner.secretKey,
    });
    expect(unsealKey(sealed, member.secretKey)).toEqual(pek);
    expect(
      verifyDelivery(owner.publicKey, signature, {
        projectId: vectors.delivery.fields.projectId,
        recipientId: ME,
        keyId: "00".repeat(16),
        sealed,
      }),
    ).toBe(true);
  });
});

describe("safety numbers", () => {
  const { a, b, number } = vectors.safety_number;

  it("match the vector and read the same from both sides", () => {
    expect(safetyNumber(a, b)).toBe(number);
    expect(safetyNumber(b, a)).toBe(number);
    expect(number).toMatch(/^\d{60}$/);
    expect(safetyNumberGroups(number)).toHaveLength(12);
    expect(safetyNumberGroups(number).join("")).toBe(number);
  });

  it("change with either key of either side", () => {
    const other = generateUserKeypair().publicKey;
    const otherSigning = generateSigningKeypair().publicKey;
    for (const changed of [
      safetyNumber({ ...a, publicKey: other }, b),
      safetyNumber({ ...a, signingKey: otherSigning }, b),
      safetyNumber(a, { ...b, publicKey: other }),
      safetyNumber(a, { ...b, signingKey: otherSigning }),
      safetyNumber(a, { ...b, userId: "0190a6f0-0000-7000-8000-0000000000e3" }),
    ]) {
      expect(changed).not.toBe(number);
    }
  });
});
