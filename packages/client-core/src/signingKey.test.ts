import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  Keyring,
  generateDek,
  generateSigningKeypair,
  unwrapSigningKey,
  wrapSigningKey,
} from "./crypto";
import { ensureSigningKey, type SigningKeyTransport } from "./signingKey";
import type { SigningKeyResponse } from "./types";

function server(initial: SigningKeyResponse | null = null) {
  let stored = initial;
  const api: SigningKeyTransport & { puts: number } = {
    puts: 0,
    getSigningKey: vi.fn(
      async () => stored ?? { signing_public_key: null, encrypted_signing_key: null },
    ),
    putSigningKey: vi.fn(async (publicKey: string, wrapped: { iv: string; ct: string }) => {
      api.puts++;
      if (stored && stored.signing_public_key !== publicKey) {
        throw new ApiError(409, "conflict", { code: "signing_key_already_set" });
      }
      stored = { signing_public_key: publicKey, encrypted_signing_key: wrapped };
    }),
  };
  return { api, stored: () => stored };
}

describe("ensureSigningKey", () => {
  it("creates and uploads a key for an account that has none", async () => {
    const dek = generateDek();
    const keyring = new Keyring({ dek });
    const srv = server();
    const result = await ensureSigningKey(srv.api, keyring);
    expect(result.created).toBe(true);
    expect(keyring.getSigningPublicKey()).toBe(result.publicKey);
    const stored = srv.stored()!;
    expect(stored.signing_public_key).toBe(result.publicKey);
    expect(unwrapSigningKey(stored.encrypted_signing_key!, dek, result.publicKey)).toEqual(
      keyring.getSigningKey(),
    );
    // Held now: nothing more to do.
    expect((await ensureSigningKey(srv.api, keyring)).created).toBe(false);
    expect(srv.api.puts).toBe(1);
  });

  it("sends the credential it is given with a new key's upload", async () => {
    const srv = server();
    await ensureSigningKey(srv.api, new Keyring({ dek: generateDek() }), undefined, {
      currentPassword: "auth-hash",
    });
    expect(srv.api.putSigningKey).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      currentPassword: "auth-hash",
    });
  });

  it("loads the stored key, from the session first, without touching the server", async () => {
    const dek = generateDek();
    const pair = generateSigningKeypair();
    const wrapped = wrapSigningKey(pair.secretKey, dek);
    const srv = server();
    const keyring = new Keyring({ dek });
    await ensureSigningKey(srv.api, keyring, { publicKey: pair.publicKey, wrapped });
    expect(keyring.getSigningKey()).toEqual(pair.secretKey);
    expect(srv.api.getSigningKey).not.toHaveBeenCalled();
  });

  it("loads the key another device stored first", async () => {
    const dek = generateDek();
    const winner = generateSigningKeypair();
    const srv = server();
    // The other device stores its key between this one's GET and PUT.
    srv.api.getSigningKey = vi
      .fn()
      .mockResolvedValueOnce({ signing_public_key: null, encrypted_signing_key: null })
      .mockResolvedValue({
        signing_public_key: winner.publicKey,
        encrypted_signing_key: wrapSigningKey(winner.secretKey, dek),
      });
    srv.api.putSigningKey = vi.fn(async () => {
      throw new ApiError(409, "conflict", { code: "signing_key_already_set" });
    });
    const keyring = new Keyring({ dek });
    const result = await ensureSigningKey(srv.api, keyring);
    expect(result.created).toBe(false);
    expect(keyring.getSigningKey()).toEqual(winner.secretKey);
  });

  it("refuses a stored key that does not match its published half", async () => {
    const dek = generateDek();
    const srv = server({
      signing_public_key: generateSigningKeypair().publicKey,
      encrypted_signing_key: wrapSigningKey(generateSigningKeypair().secretKey, dek),
    });
    const keyring = new Keyring({ dek });
    await expect(ensureSigningKey(srv.api, keyring)).rejects.toThrow();
    expect(keyring.getSigningKey()).toBeNull();
    expect(srv.api.puts).toBe(0);
  });
});
