import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  API_TOKEN_PREFIX,
  deriveApiTokenKeys,
  formatApiToken,
  generateApiToken,
  InvalidApiTokenError,
  parseApiToken,
  unwrapApiTokenAppKeys,
  unwrapApiTokenKeys,
  wrapAppKeysForApiToken,
  wrapKeysForApiToken,
  type ApiTokenWrap,
} from "./apiToken";
import { bytesToHex, hexToBytes, randomBytes } from "./utils";

/** Pins the token format: a token an older SDK or app made must keep opening. */
interface Vector {
  name: string;
  id: string;
  secret: string;
  user_id: string;
  token: string;
  auth: string;
  wrap_key: string;
  dek: string;
  private_key: string;
  wrapped_dek: ApiTokenWrap;
  wrapped_private_key: ApiTokenWrap;
  app_keys?: Record<
    string,
    {
      app_key: string;
      app_private_key: string;
      wrapped_key: ApiTokenWrap;
      wrapped_private_key: ApiTokenWrap;
    }
  >;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/api_token_vectors.json", import.meta.url),
);
const { vectors } = JSON.parse(readFileSync(fixturePath, "utf8")) as { vectors: Vector[] };

describe("API token vectors", () => {
  for (const v of vectors) {
    const parts = { id: v.id, secret: hexToBytes(v.secret) };

    it(`formats and parses the token string: ${v.name}`, () => {
      expect(formatApiToken(parts)).toBe(v.token);
      const parsed = parseApiToken(` ${v.token}\n`);
      expect(parsed.id).toBe(v.id);
      expect(bytesToHex(parsed.secret)).toBe(v.secret);
      // Plain base64url, as any other implementation would read it.
      const raw = Buffer.from(v.token.slice(API_TOKEN_PREFIX.length), "base64url");
      expect(raw.subarray(16).toString("hex")).toBe(v.secret);
    });

    it(`derives the auth value and wrapping key: ${v.name}`, () => {
      const keys = deriveApiTokenKeys(parts);
      expect(keys.auth).toBe(v.auth);
      expect(bytesToHex(keys.wrapKey)).toBe(v.wrap_key);
    });

    it(`opens the stored wraps: ${v.name}`, () => {
      const keys = unwrapApiTokenKeys(parts, v.user_id, v);
      expect(bytesToHex(keys.dek)).toBe(v.dek);
      expect(bytesToHex(keys.privateKey)).toBe(v.private_key);
    });

    for (const [app, a] of Object.entries(v.app_keys ?? {})) {
      it(`opens the stored ${app} app wraps: ${v.name}`, () => {
        const keys = unwrapApiTokenAppKeys(parts, v.user_id, app, a);
        expect(bytesToHex(keys.appKey)).toBe(a.app_key);
        expect(bytesToHex(keys.privateKey)).toBe(a.app_private_key);
      });
    }
  }
});

describe("API tokens", () => {
  const userId = "01920000-0000-7000-8000-000000000001";
  const keys = { dek: randomBytes(32), privateKey: randomBytes(32) };

  it("generates distinct v4-layout ids that survive the round trip", () => {
    const a = generateApiToken();
    const b = generateApiToken();
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const parsed = parseApiToken(formatApiToken(a));
    expect(parsed.id).toBe(a.id);
    expect(parsed.secret).toEqual(a.secret);
  });

  it("refuses strings that are not tokens", () => {
    const token = formatApiToken(generateApiToken());
    for (const bad of [
      "",
      "atlas_pat_",
      token.slice(0, -2),
      token + "AA",
      "x" + token,
      token.replace("_pat_", "_pak_"),
      token.slice(0, -1) + "!",
    ]) {
      expect(() => parseApiToken(bad), bad).toThrow(InvalidApiTokenError);
    }
  });

  it("wraps open only for the same token, account and slot", () => {
    const parts = generateApiToken();
    const wrapped = wrapKeysForApiToken(parts, userId, keys);
    const opened = unwrapApiTokenKeys(parts, userId, wrapped);
    expect(opened.dek).toEqual(keys.dek);
    expect(opened.privateKey).toEqual(keys.privateKey);

    expect(() => unwrapApiTokenKeys(generateApiToken(), userId, wrapped)).toThrow();
    expect(() =>
      unwrapApiTokenKeys({ id: generateApiToken().id, secret: parts.secret }, userId, wrapped),
    ).toThrow();
    expect(() =>
      unwrapApiTokenKeys(parts, "01920000-0000-7000-8000-000000000002", wrapped),
    ).toThrow();
    expect(() =>
      unwrapApiTokenKeys(parts, userId, {
        wrapped_dek: wrapped.wrapped_private_key,
        wrapped_private_key: wrapped.wrapped_dek,
      }),
    ).toThrow();
  });

  it("wraps another app's keys bound to that app, never as the todo key", () => {
    const parts = generateApiToken();
    const app = { appKey: randomBytes(32), privateKey: randomBytes(32) };
    const wrapped = wrapAppKeysForApiToken(parts, userId, "journal", app);
    const opened = unwrapApiTokenAppKeys(parts, userId, "journal", wrapped);
    expect(opened.appKey).toEqual(app.appKey);
    expect(opened.privateKey).toEqual(app.privateKey);

    expect(() => unwrapApiTokenAppKeys(parts, userId, "notes", wrapped)).toThrow();
    expect(() => unwrapApiTokenAppKeys(generateApiToken(), userId, "journal", wrapped)).toThrow();
    // Not openable as the todo key, nor the todo key as it.
    expect(() =>
      unwrapApiTokenKeys(parts, userId, {
        wrapped_dek: wrapped.wrapped_key,
        wrapped_private_key: wrapped.wrapped_private_key,
      }),
    ).toThrow();
    const todo = wrapKeysForApiToken(parts, userId, keys);
    expect(() =>
      unwrapApiTokenAppKeys(parts, userId, "journal", {
        wrapped_key: todo.wrapped_dek,
        wrapped_private_key: todo.wrapped_private_key,
      }),
    ).toThrow();
    expect(() => wrapAppKeysForApiToken(parts, userId, "todo", app)).toThrow();
    expect(() => unwrapApiTokenKeys(parts, userId, {})).toThrow(/no todo key/);
  });

  it("never puts the secret in what the server receives", () => {
    const parts = generateApiToken();
    const { auth } = deriveApiTokenKeys(parts);
    const sent = JSON.stringify({
      id: parts.id,
      auth,
      ...wrapKeysForApiToken(parts, userId, keys),
    });
    expect(sent).not.toContain(bytesToHex(parts.secret));
    expect(auth).toMatch(/^[0-9a-f]{64}$/);
  });
});
