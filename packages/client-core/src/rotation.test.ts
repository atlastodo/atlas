import { describe, expect, it, vi } from "bun:test";
import { ApiError } from "./api";
import {
  Keyring,
  generateDek,
  generatePek,
  generateSigningKeypair,
  generateUserKeypair,
  projectKeyId,
  unsealKey,
  unwrapProjectKey,
  verifyDelivery,
  type SealedKey,
  type WrappedProjectKey,
} from "./crypto";
import { performKeyRotations, type RotationTransport } from "./rotation";
import { LocalStore } from "./store";
import * as trust from "./trust";
import type { MemberView } from "./types";

const ME = "0190a6f0-0000-7000-8000-0000000000e1";
const BOB = "0190a6f0-0000-7000-8000-0000000000e2";
const CAROL = "0190a6f0-0000-7000-8000-0000000000e3";
const DAVE = "0190a6f0-0000-7000-8000-0000000000e4";
const P = "0190a6f0-0000-7000-8000-00000000a001";

function member(
  user_id: string,
  publicKey: string,
  role: MemberView["role"] = "editor",
): MemberView {
  return {
    user_id,
    email: `${user_id}@example.com`,
    display_name: "",
    role,
    state: "active",
    invited_by: ME,
    has_key: true,
    public_key: publicKey,
  };
}

function setup(complete?: () => Promise<void>) {
  let n = 0;
  const store = new LocalStore("0190a6f0-0000-7000-8000-0000000000d1", {
    newId: () => `0190a6f0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
  });
  const dek = generateDek();
  const signing = generateSigningKeypair();
  const keyring = new Keyring({ dek, signingKey: signing.secretKey });
  const old = generatePek();
  keyring.setProjectKey(P, old);
  trust.recordMintedKey(store, P, projectKeyId(old));
  const [bob, carol, dave] = [generateUserKeypair(), generateUserKeypair(), generateUserKeypair()];
  trust.pinMemberKey(store, P, BOB, bob.publicKey);
  trust.pinMemberKey(store, P, DAVE, dave.publicKey);
  const calls: string[] = [];
  const own: { keyId: string; wrapped: WrappedProjectKey }[] = [];
  const deliveries: { to: string; sealed: SealedKey; keyId: string; signature: string }[] = [];
  const api: RotationTransport = {
    listKeyRotations: vi.fn(async () => [{ project_id: P, request: 3 }]),
    putProjectKey: vi.fn(async (_p, wrapped, keyId) => {
      calls.push("own");
      own.push({ keyId, wrapped: wrapped as WrappedProjectKey });
    }),
    putMemberProjectKey: vi.fn(async (_p, to, sealed, keyId, signature) => {
      calls.push(`deliver:${to}`);
      deliveries.push({ to, sealed, keyId, signature });
    }),
    completeKeyRotation: vi.fn(
      complete ??
        (async () => {
          calls.push("complete");
        }),
    ),
    // The server still lists Dave, whom the caller just removed, and Carol, never pinned here.
    listMembers: vi.fn(async () => [
      member(ME, generateUserKeypair().publicKey, "owner"),
      member(BOB, "ff".repeat(32)),
      member(CAROL, carol.publicKey),
      member(DAVE, dave.publicKey),
    ]),
  };
  return { store, dek, signing, keyring, old, bob, api, calls, own, deliveries };
}

describe("performKeyRotations", () => {
  it("mints, stores, delivers signed to the pinned remaining members, then completes", async () => {
    const t = setup();
    const result = await performKeyRotations(t.api, t.keyring, t.store, ME, { removed: [DAVE] });
    expect(result).toEqual({ rotated: [P], superseded: [], failed: 0, unpinned: 1 });
    expect(t.calls).toEqual(["own", `deliver:${BOB}`, "complete"]);

    const keyId = t.own[0]!.keyId;
    const pek = unwrapProjectKey(t.own[0]!.wrapped, t.dek, P);
    expect(projectKeyId(pek)).toBe(keyId);
    expect(t.api.completeKeyRotation).toHaveBeenCalledWith(P, keyId, 3);

    // Sealed to the key pinned at invite time, not the one the server lists now, and signed.
    const [d] = t.deliveries;
    expect(unsealKey(d!.sealed, t.bob.secretKey)).toEqual(pek);
    expect(
      verifyDelivery(t.signing.publicKey, d!.signature, {
        projectId: P,
        recipientId: BOB,
        keyId,
        sealed: d!.sealed,
      }),
    ).toBe(true);

    expect(t.keyring.canonicalKeyId(P)).toBe(keyId);
    expect(t.keyring.isRetired(P, projectKeyId(t.old))).toBe(true);
    expect(t.keyring.projectKey(P, projectKeyId(t.old))).toEqual(t.old);
    const recorded = trust.readKeyTrust(t.store);
    expect(recorded.minted.get(P)).toBe(keyId);
    expect(recorded.retired.has(`${P}:${projectKeyId(t.old)}`)).toBe(true);
  });

  it("keeps the current key when another owner completed the rotation first", async () => {
    const t = setup(async () => {
      throw new ApiError(409, "conflict", { code: "rotation_not_pending" });
    });
    const result = await performKeyRotations(t.api, t.keyring, t.store, ME);
    expect(result.superseded).toEqual([P]);
    expect(result.rotated).toEqual([]);
    expect(t.keyring.canonicalKeyId(P)).toBe(projectKeyId(t.old));
    expect(trust.readKeyTrust(t.store).minted.get(P)).toBe(projectKeyId(t.old));
  });

  it("does nothing without the signing key", async () => {
    const t = setup();
    const keyring = new Keyring({ dek: t.dek });
    const result = await performKeyRotations(t.api, keyring, t.store, ME);
    expect(result.rotated).toEqual([]);
    expect(t.api.listKeyRotations).not.toHaveBeenCalled();
  });
});
