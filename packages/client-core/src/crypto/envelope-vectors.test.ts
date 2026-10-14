import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decryptJson } from "./aes";
import { unsealKey, type SealedKey } from "./asym";
import { unwrapKey, unwrapProjectKey } from "./envelope";
import { decryptField, paddedLength, type FieldEnvelopeV2, type KeyScope } from "./field";
import { unwrapSigningKey } from "./identity";
import { projectKeyId } from "./keyring";
import { bytesToHex, hexToBytes } from "./utils";

/**
 * `test-vectors/envelope_vectors.json`: field envelopes and key wraps that the Rust client
 * (`crates/atlas-client`) asserts too, opening each and reproducing its ciphertext from the IV.
 */

interface Payload {
  iv: string;
  ct: string;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/envelope_vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  padding: { n: number; padded: number }[];
  field_v2: {
    key: string;
    scope: string;
    entity: string;
    entity_id: string;
    field: string;
    value: unknown;
    envelope: FieldEnvelopeV2;
  }[];
  field_v1: { key: string; value: unknown; envelope: Payload }[];
  project_key: {
    dek: string;
    pek: string;
    project_id: string;
    key_id: string;
    wrapped: Payload & { v: 2 };
    unbound: Payload;
  };
  signing_key: { dek: string; secret_key: string; public_key: string; wrapped: Payload };
  sealed: { recipient_secret_key: string; key: string; sealed: SealedKey };
};

const scopeOf = (label: string): KeyScope =>
  label === "personal"
    ? { kind: "personal" }
    : { kind: "project", projectId: label.slice("project:".length) };

describe("envelope vectors", () => {
  it("pads to the size buckets", () => {
    for (const { n, padded } of fixture.padding) expect(paddedLength(n)).toBe(padded);
  });

  for (const [i, v] of fixture.field_v2.entries()) {
    it(`opens field v2 vector ${i} only where it was written`, () => {
      const at = { entity: v.entity, entityId: v.entity_id, field: v.field };
      const key = hexToBytes(v.key);
      expect(decryptField(key, scopeOf(v.scope), at, v.envelope)).toEqual(v.value);
      expect(() =>
        decryptField(key, scopeOf(v.scope), { ...at, field: "other" }, v.envelope),
      ).toThrow();
    });
  }

  it("opens field v1 vectors", () => {
    for (const v of fixture.field_v1) {
      expect(decryptJson(hexToBytes(v.key), v.envelope)).toEqual(v.value);
    }
  });

  it("opens project key wraps and fingerprints the key", () => {
    const p = fixture.project_key;
    const dek = hexToBytes(p.dek);
    expect(bytesToHex(unwrapProjectKey(p.wrapped, dek, p.project_id))).toBe(p.pek);
    expect(() => unwrapProjectKey(p.wrapped, dek, "another-project")).toThrow();
    expect(bytesToHex(unwrapKey(p.unbound, dek))).toBe(p.pek);
    expect(projectKeyId(hexToBytes(p.pek))).toBe(p.key_id);
  });

  it("opens the signing key wrap", () => {
    const s = fixture.signing_key;
    expect(bytesToHex(unwrapSigningKey(s.wrapped, hexToBytes(s.dek), s.public_key))).toBe(
      s.secret_key,
    );
  });

  it("unseals the sealed key", () => {
    const s = fixture.sealed;
    expect(bytesToHex(unsealKey(s.sealed, hexToBytes(s.recipient_secret_key)))).toBe(s.key);
  });
});
