import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeBase64Url,
  derivePasskeySlotKey,
  normalizeCredentialId,
  passkeyPrfInputBase64Url,
  passkeySlot,
} from "./passkey";
import { unwrapRootKey, wrapRootKey, type RootKeyWrap } from "./rootKey";
import { base64UrlToBytes, bytesToBase64Url, bytesToHex, hexToBytes, randomBytes } from "./utils";

/** Pins the passkey slot derivation: the server's test reproduces it with its own HKDF. */
interface Vector {
  name: string;
  user_id: string;
  root_key: string;
  prf_output: string;
  credential_id: string;
  slot: string;
  slot_key: string;
  passkey_slot: RootKeyWrap;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/passkey_vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  prf_input: string;
  vectors: Vector[];
};

describe("passkey vectors", () => {
  it("evaluates one PRF input for every passkey", () => {
    expect(passkeyPrfInputBase64Url()).toBe(fixture.prf_input);
  });

  for (const v of fixture.vectors) {
    it(`derives the slot key and opens the slot: ${v.name}`, () => {
      const key = derivePasskeySlotKey(hexToBytes(v.prf_output), v.credential_id);
      expect(bytesToHex(key)).toBe(v.slot_key);
      expect(passkeySlot(v.credential_id)).toBe(v.slot);
      const slot = passkeySlot(v.credential_id);
      expect(bytesToHex(unwrapRootKey(v.passkey_slot, key, v.user_id, slot))).toBe(v.root_key);
    });

    it(`binds the credential: ${v.name}`, () => {
      const key = derivePasskeySlotKey(hexToBytes(v.prf_output), v.credential_id);
      expect(() => unwrapRootKey(v.passkey_slot, key, v.user_id, "passkey:other")).toThrow();
      const otherKey = derivePasskeySlotKey(hexToBytes(v.prf_output), "b3RoZXI");
      expect(() =>
        unwrapRootKey(v.passkey_slot, otherKey, v.user_id, passkeySlot(v.credential_id)),
      ).toThrow();
    });
  }
});

describe("passkey helpers", () => {
  it("normalizes padded credential ids", () => {
    expect(normalizeCredentialId("AQI=")).toBe("AQI");
    expect(passkeySlot("AQI==")).toBe("passkey:AQI");
    expect(() => decodeBase64Url("a+b/")).toThrow();
  });

  it("round-trips base64url", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = randomBytes(n);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }
  });

  it("refuses a PRF output of the wrong size", () => {
    expect(() => derivePasskeySlotKey(new Uint8Array(16), "AQI")).toThrow();
  });

  it("wraps a fresh root that only its passkey opens", () => {
    const root = randomBytes(32);
    const key = derivePasskeySlotKey(randomBytes(32), "AQID");
    const wrap = wrapRootKey(root, key, "u", passkeySlot("AQID"));
    expect(unwrapRootKey(wrap, key, "u", passkeySlot("AQID"))).toEqual(root);
  });
});
