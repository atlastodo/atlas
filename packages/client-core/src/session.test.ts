import { describe, it, expect } from "vitest";
import {
  isAdmin,
  mergeRotatedTokens,
  reconcileStoredSession,
  sessionFromAuth,
  type Session,
} from "./session";
import type { AuthResponse } from "./types";

const AUTH: AuthResponse = {
  access_token: "access-jwt",
  refresh_token: "refresh-opaque",
  expires_in: 900,
  device_id: "9f1c4b2a-0000-4000-8000-000000000001",
  user: { id: "u-1", email: "a@b.dev", display_name: "A" },
};

describe("sessionFromAuth", () => {
  it("maps the wire response onto the persisted session", () => {
    // Every field is distinct, so a crossed mapping (access <-> refresh, say) fails here.
    expect(sessionFromAuth(AUTH)).toEqual({
      accessToken: "access-jwt",
      refreshToken: "refresh-opaque",
      deviceId: "9f1c4b2a-0000-4000-8000-000000000001",
      user: { id: "u-1", email: "a@b.dev", display_name: "A" },
    });
  });

  it("carries the identity signing key's published and wrapped halves", () => {
    const wrapped = { iv: "iv", ct: "ct" };
    const session = sessionFromAuth({
      ...AUTH,
      signing_public_key: "cc".repeat(32),
      encrypted_signing_key: wrapped,
    });
    expect(session.signingPublicKey).toBe("cc".repeat(32));
    expect(session.encryptedSigningKey).toEqual(wrapped);
  });

  it("keeps only what a session needs, dropping the response's expiry", () => {
    // expires_in describes the response, not the stored session; persisting it would go stale.
    expect(sessionFromAuth(AUTH)).not.toHaveProperty("expires_in");
    expect(Object.keys(sessionFromAuth(AUTH)).sort()).toEqual([
      "accessToken",
      "deviceId",
      "refreshToken",
      "user",
    ]);
  });
});

describe("root key state", () => {
  const slot = { v: 1 as const, iv: "iv", ct: "ct" };
  const appKeys = [{ app: "todo", wrapped_key: slot }];

  it("carries the root slot, app keys and recovery state of a migrated account", () => {
    const session = sessionFromAuth({
      ...AUTH,
      has_root_key: true,
      encrypted_root_key: slot,
      app_keys: appKeys,
      recovery_public_key: "dd".repeat(32),
      has_recovery_root_key: true,
    });
    expect(session).toMatchObject({
      hasRootKey: true,
      encryptedRootKey: slot,
      appKeys,
      recoveryPublicKey: "dd".repeat(32),
      hasRecoveryRootKey: true,
    });
  });

  it("knows an unmigrated account from a server that does not say", () => {
    expect(sessionFromAuth({ ...AUTH, has_root_key: false })).toMatchObject({
      hasRootKey: false,
      appKeys: [],
      hasRecoveryRootKey: false,
    });
    expect(sessionFromAuth(AUTH).hasRootKey).toBeUndefined();
  });

  it("drops a stale root slot when a rotation says the root is gone", () => {
    const prev = sessionFromAuth({
      ...AUTH,
      has_root_key: true,
      encrypted_root_key: slot,
      app_keys: appKeys,
    });
    const next = mergeRotatedTokens(prev, { ...AUTH, has_root_key: false });
    expect(next.hasRootKey).toBe(false);
    expect(next.encryptedRootKey).toBeUndefined();
    expect(next.appKeys).toEqual([]);
  });
});

describe("isAdmin", () => {
  it("is false for a session persisted before the field existed", () => {
    // The keychain/localStorage payload is raw JSON from an older app version, so `is_admin` is
    // simply absent. It has to read as "not an admin" rather than throw or read as undefined.
    const legacy = sessionFromAuth(AUTH);
    expect(legacy.user).not.toHaveProperty("is_admin");
    expect(isAdmin(legacy)).toBe(false);
  });

  it("is true only when the server actually said so", () => {
    expect(isAdmin(sessionFromAuth({ ...AUTH, user: { ...AUTH.user, is_admin: true } }))).toBe(
      true,
    );
    expect(isAdmin(sessionFromAuth({ ...AUTH, user: { ...AUTH.user, is_admin: false } }))).toBe(
      false,
    );
    expect(isAdmin(null)).toBe(false);
  });
});

describe("mergeRotatedTokens", () => {
  it("never forgets a registered recovery key over a response issued before it was registered", () => {
    // The key is set once on the server; a rotation answered just before the registration landed
    // must not bring the confirmation prompt back.
    const prev = { ...sessionFromAuth(AUTH), user: { ...AUTH.user, has_recovery_key: true } };
    const stale = { ...AUTH, user: { ...AUTH.user, has_recovery_key: false } };
    expect(mergeRotatedTokens(prev, stale).user.has_recovery_key).toBe(true);
    const unknown = { ...sessionFromAuth(AUTH), user: { ...AUTH.user } };
    expect(mergeRotatedTokens(unknown, stale).user.has_recovery_key).toBe(false);
  });

  const E2EE_AUTH: AuthResponse = {
    ...AUTH,
    salt: "00ff",
    public_key: "pub-hex",
    encrypted_dek: { iv: "iv-1", ct: "dek-1" },
    encrypted_private_key: { iv: "iv-1", ct: "priv-1" },
    is_e2ee: true,
  };
  const UNLOCKED: Session = {
    ...sessionFromAuth(E2EE_AUTH),
    dek: "aa".repeat(32),
    privateKey: "bb".repeat(32),
    publicKey: "pub-hex",
  };

  it("takes the rotated tokens but keeps the unwrapped keys a refresh never carries", () => {
    // Persisting the bare refresh response would drop the keys and leave every session locked
    // after a reload.
    const rotated: AuthResponse = {
      ...E2EE_AUTH,
      access_token: "access-2",
      refresh_token: "refresh-2",
      user: { ...AUTH.user, is_admin: true },
      encrypted_dek: { iv: "iv-2", ct: "dek-2" },
    };

    const next = mergeRotatedTokens(UNLOCKED, rotated);

    expect(next.accessToken).toBe("access-2");
    expect(next.refreshToken).toBe("refresh-2");
    expect(next.user.is_admin).toBe(true);
    // The server-side blobs follow the server (a password change elsewhere re-wraps them)...
    expect(next.encryptedDek).toEqual({ iv: "iv-2", ct: "dek-2" });
    // ...while the unwrapped keys and the public half they pair with stay.
    expect(next.dek).toBe(UNLOCKED.dek);
    expect(next.privateKey).toBe(UNLOCKED.privateKey);
    expect(next.publicKey).toBe("pub-hex");
  });

  it("keeps the stored blobs when the refresh response omits them", () => {
    const next = mergeRotatedTokens(UNLOCKED, { ...AUTH, access_token: "a2", refresh_token: "r2" });
    expect(next.salt).toBe("00ff");
    expect(next.encryptedDek).toEqual({ iv: "iv-1", ct: "dek-1" });
    expect(next.dek).toBe(UNLOCKED.dek);
  });

  it("never carries one account's keys onto another account's tokens", () => {
    const other: AuthResponse = { ...E2EE_AUTH, user: { ...AUTH.user, id: "u-2" } };
    const next = mergeRotatedTokens(UNLOCKED, other);
    expect(next.user.id).toBe("u-2");
    expect(next).not.toHaveProperty("dek");
    expect(next).not.toHaveProperty("privateKey");
  });
});

describe("reconcileStoredSession", () => {
  const MINE: Session = {
    ...sessionFromAuth(AUTH),
    dek: "aa".repeat(32),
    privateKey: "bb".repeat(32),
    signingKey: "dd".repeat(32),
    publicKey: "pub",
  };

  it("ends the session here when another tab removed it", () => {
    expect(reconcileStoredSession(MINE, null)).toBeNull();
  });

  it("changes nothing for a write that carries our own tokens", () => {
    expect(reconcileStoredSession(MINE, { ...MINE })).toBe(MINE);
  });

  it("adopts another tab's rotated tokens and keeps our keys when its write lacks them", () => {
    const rotated: Session = { ...sessionFromAuth(AUTH), accessToken: "a2", refreshToken: "r2" };
    const next = reconcileStoredSession(MINE, rotated)!;
    expect(next.refreshToken).toBe("r2");
    expect(next.accessToken).toBe("a2");
    expect(next.dek).toBe(MINE.dek);
    expect(next.privateKey).toBe(MINE.privateKey);
    expect(next.signingKey).toBe(MINE.signingKey);
    expect(next.publicKey).toBe("pub");
  });

  it("adopts keys another tab unlocked", () => {
    const locked = sessionFromAuth(AUTH);
    expect(reconcileStoredSession(locked, MINE)).toEqual(MINE);
  });

  it("takes another account's session wholesale, never mixing in our keys", () => {
    const other = { ...sessionFromAuth(AUTH), user: { ...AUTH.user, id: "u-2" } };
    expect(reconcileStoredSession(MINE, other)).toEqual(other);
    expect(reconcileStoredSession(null, other)).toEqual(other);
  });
});
