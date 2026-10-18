import { renderHook, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  Keyring,
  LocalStore,
  generateDek,
  generatePek,
  generateSigningKeypair,
  generateUserKeypair,
  pinMemberKey,
  projectKeyId,
  readKeyTrust,
  recordFirstKeyMembers,
  unsealKey,
  verifyDelivery,
  type ApiClient,
  type MissingProjectKey,
  type SealedKey,
} from "@atlastodo/client-core";
import { fakeAuth, withApp } from "../testutil";
import {
  memberKeyChanges,
  mintFirstSharedKeys,
  requestProjectKeyMaintenance,
  sealMissingProjectKeys,
  useProjectKeyMaintenance,
} from "./useProjectKeyMaintenance";

/**
 * The owner-side key delivery, over a fake transport and a real keyring: a delivered key must open
 * with the member's private key to the very key the owner holds.
 */

const alice = generateUserKeypair();
const carol = generateUserKeypair();

const signing = generateSigningKeypair();

function newKeyring(withSigningKey = true): Keyring {
  const me = generateUserKeypair();
  return new Keyring({
    dek: generateDek(),
    userPrivateKey: me.secretKey,
    userPublicKey: me.publicKey,
    signingKey: withSigningKey ? signing.secretKey : undefined,
  });
}

/** The trust state of an owner who invited each `[project, user, public key]`. */
function pinned(...pins: [string, string, string][]) {
  const store = new LocalStore("owner-device");
  for (const [projectId, userId, publicKey] of pins)
    pinMemberKey(store, projectId, userId, publicKey);
  return readKeyTrust(store);
}

function fakeApi(missing: MissingProjectKey[] | (() => Promise<MissingProjectKey[]>)) {
  const api = {
    listMissingProjectKeys: jest.fn(typeof missing === "function" ? missing : async () => missing),
    putMemberProjectKey: jest.fn(
      async (_p: string, _member: string, _sealed: SealedKey, _keyId: string, _sig: string) => {},
    ),
    listKeyRotations: jest.fn(async () => [] as { project_id: string; request: number }[]),
    // The maintenance pass also mints a first key for an owned shared project that has none.
    putProjectKey: jest.fn(async () => {}),
  };
  return api as unknown as ApiClient & typeof api;
}

describe("sealMissingProjectKeys", () => {
  it("seals exactly the members it can deliver to", async () => {
    const keyring = newKeyring();
    const pek = generatePek();
    const keyId = keyring.setProjectKey("p1", pek);
    const api = fakeApi([
      { project_id: "p1", user_id: "u-alice", public_key: alice.publicKey, key_id: keyId },
      // No public key yet: nothing to seal to.
      { project_id: "p1", user_id: "u-bob", public_key: null, key_id: keyId },
      // A project whose key this device does not hold.
      { project_id: "p2", user_id: "u-carol", public_key: carol.publicKey, key_id: "a".repeat(32) },
    ]);

    const trust = pinned(["p1", "u-alice", alice.publicKey], ["p2", "u-carol", carol.publicKey]);
    const result = await sealMissingProjectKeys(api, keyring, trust);

    expect(result).toEqual({ sealed: 1, skipped: 2, failed: 0, keyChanged: [] });
    expect(api.putMemberProjectKey).toHaveBeenCalledTimes(1);
    const [projectId, memberId, sealed, sealedKeyId, signature] =
      api.putMemberProjectKey.mock.calls[0]!;
    expect([projectId, memberId, sealedKeyId]).toEqual(["p1", "u-alice", keyId]);
    expect(unsealKey(sealed, alice.secretKey)).toEqual(pek);
    // Signed by the owner for exactly this member, project and key.
    expect(
      verifyDelivery(signing.publicKey, signature, {
        projectId: "p1",
        recipientId: "u-alice",
        keyId,
        sealed,
      }),
    ).toBe(true);
  });

  it("sends nothing before the signing key is loaded", async () => {
    const keyring = newKeyring(false);
    const keyId = keyring.setProjectKey("p1", generatePek());
    const api = fakeApi([
      { project_id: "p1", user_id: "u-alice", public_key: alice.publicKey, key_id: keyId },
    ]);
    const result = await sealMissingProjectKeys(
      api,
      keyring,
      pinned(["p1", "u-alice", alice.publicKey]),
    );
    expect(result.sealed).toBe(0);
    expect(api.listMissingProjectKeys).not.toHaveBeenCalled();
  });

  it("delivers the key the server names, not merely the newest one held", async () => {
    const keyring = newKeyring();
    const older = generatePek();
    keyring.setProjectKey("p1", generatePek());
    keyring.addProjectKey("p1", projectKeyId(older), older);
    const api = fakeApi([
      {
        project_id: "p1",
        user_id: "u-alice",
        public_key: alice.publicKey,
        key_id: projectKeyId(older),
      },
    ]);

    await sealMissingProjectKeys(api, keyring, pinned(["p1", "u-alice", alice.publicKey]));

    expect(unsealKey(api.putMemberProjectKey.mock.calls[0]![2], alice.secretKey)).toEqual(older);
  });

  it("keeps going past a row the server refuses", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const keyring = newKeyring();
    const keyId = keyring.setProjectKey("p1", generatePek());
    const api = fakeApi([
      { project_id: "p1", user_id: "u-alice", public_key: alice.publicKey, key_id: keyId },
      { project_id: "p1", user_id: "u-carol", public_key: carol.publicKey, key_id: keyId },
    ]);
    api.putMemberProjectKey.mockRejectedValueOnce(new Error("forbidden"));

    const trust = pinned(["p1", "u-alice", alice.publicKey], ["p1", "u-carol", carol.publicKey]);
    const result = await sealMissingProjectKeys(api, keyring, trust);

    expect(result).toEqual({ sealed: 1, skipped: 0, failed: 1, keyChanged: [] });
    expect(api.putMemberProjectKey).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("never seals to a member the server added, or to a public key it swapped in", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const keyring = newKeyring();
    const keyId = keyring.setProjectKey("p1", generatePek());
    const server = generateUserKeypair();
    const api = fakeApi([
      // A member the user never invited, with the server's own key.
      { project_id: "p1", user_id: "u-phantom", public_key: server.publicKey, key_id: keyId },
      // Alice, invited, but now listed with the server's key instead of hers.
      { project_id: "p1", user_id: "u-alice", public_key: server.publicKey, key_id: keyId },
    ]);

    const result = await sealMissingProjectKeys(
      api,
      keyring,
      pinned(["p1", "u-alice", alice.publicKey]),
    );

    expect(api.putMemberProjectKey).not.toHaveBeenCalled();
    expect(result).toEqual({
      sealed: 0,
      skipped: 1,
      failed: 0,
      keyChanged: [{ projectId: "p1", userId: "u-alice" }],
    });
    expect(memberKeyChanges().has("p1:u-alice")).toBe(true);
    warn.mockRestore();
  });
});

describe("useProjectKeyMaintenance", () => {
  function ownerStore(role = "owner"): LocalStore {
    const store = new LocalStore("test");
    store.set("project_member", "m1", "project_id", "p1");
    store.set("project_member", "m1", "user_id", "me");
    store.set("project_member", "m1", "role", role);
    store.set("project_member", "m1", "state", "active");
    return store;
  }

  async function mount(store: LocalStore, api: ApiClient) {
    const auth = fakeAuth({
      api,
      keyring: newKeyring(),
      session: {
        accessToken: "a",
        refreshToken: "r",
        deviceId: "d",
        user: { id: "me", email: "me@example.com", display_name: "Me" },
      },
    });
    return await renderHook(() => useProjectKeyMaintenance(), {
      wrapper: withApp(store, auth, null),
    });
  }

  it("runs for an owner once the first sync has settled, and never twice at once", async () => {
    let release!: (rows: MissingProjectKey[]) => void;
    const api = fakeApi(
      () =>
        new Promise<MissingProjectKey[]>((r) => {
          release = r;
        }),
    );
    await mount(ownerStore(), api);
    await waitFor(() => expect(api.listMissingProjectKeys).toHaveBeenCalledTimes(1));
    // Pending rotations are served first.
    expect(api.listKeyRotations).toHaveBeenCalledTimes(1);

    requestProjectKeyMaintenance();
    requestProjectKeyMaintenance();
    expect(api.listMissingProjectKeys).toHaveBeenCalledTimes(1);

    release([]);
    await waitFor(() => {
      requestProjectKeyMaintenance();
      expect(api.listMissingProjectKeys).toHaveBeenCalledTimes(2);
    });
  });

  it("does nothing for a user who owns no shared project", async () => {
    const api = fakeApi([]);
    await mount(ownerStore("editor"), api);
    requestProjectKeyMaintenance();
    await Promise.resolve();
    expect(api.listMissingProjectKeys).not.toHaveBeenCalled();
  });
});

/** A `project_member` row in `store`. */
function member(store: LocalStore, projectId: string, userId: string, role: string, state: string) {
  const id = `${projectId}:${userId}`;
  store.set("project_member", id, "project_id", projectId);
  store.set("project_member", id, "user_id", userId);
  store.set("project_member", id, "role", role);
  store.set("project_member", id, "state", state);
}

describe("first keys for projects shared before project keys existed", () => {
  function putApi(put: () => Promise<void> = async () => {}) {
    const api = {
      putProjectKey: jest.fn((_projectId: string, _encrypted: unknown, _keyId: string) => put()),
    };
    return api as unknown as ApiClient & typeof api;
  }

  it("keys an owned shared project that has none, stores it first, and records its members", async () => {
    const store = new LocalStore("owner-device");
    const keyring = newKeyring();
    member(store, "p1", "me", "owner", "active");
    member(store, "p1", "u-bob", "editor", "active");
    member(store, "p1", "u-carol", "commenter", "pending");
    // Keyed already, and owned by someone else: both left alone.
    member(store, "p2", "me", "owner", "active");
    keyring.setProjectKey("p2", generatePek());
    member(store, "p3", "u-bob", "owner", "active");
    member(store, "p3", "me", "editor", "active");
    const api = putApi();

    expect(await mintFirstSharedKeys(api, keyring, store, "me")).toEqual(["p1"]);

    expect(api.putProjectKey).toHaveBeenCalledTimes(1);
    const [projectId, , keyId] = api.putProjectKey.mock.calls[0]!;
    const pek = keyring.getProjectKey("p1")!;
    expect([projectId, keyId]).toEqual(["p1", projectKeyId(pek)]);
    const trust = readKeyTrust(store);
    expect(trust.minted.get("p1")).toBe(keyId);
    expect([...trust.firstKeyMembers.get("p1")!].sort()).toEqual(["u-bob", "u-carol"]);
  });

  it("uses no key the server refused: someone already holds one", async () => {
    const store = new LocalStore("owner-device");
    const keyring = newKeyring();
    member(store, "p1", "me", "owner", "active");
    member(store, "p1", "u-bob", "editor", "active");
    const api = putApi(async () => {
      throw new ApiError(409, "this shared project already has a key");
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(await mintFirstSharedKeys(api, keyring, store, "me")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("p1 already has a key"));
    warn.mockRestore();

    expect(keyring.getProjectKey("p1")).toBeUndefined();
    expect(readKeyTrust(store).minted.has("p1")).toBe(false);
    expect(readKeyTrust(store).firstKeyMembers.has("p1")).toBe(false);
  });

  it("pins a recorded member on the first delivery, and nobody the server adds later", async () => {
    const store = new LocalStore("owner-device");
    const keyring = newKeyring();
    const pek = generatePek();
    const keyId = keyring.setProjectKey("p1", pek);
    recordFirstKeyMembers(store, "p1", ["u-alice"]);
    const api = fakeApi([
      { project_id: "p1", user_id: "u-alice", public_key: alice.publicKey, key_id: keyId },
      { project_id: "p1", user_id: "u-carol", public_key: carol.publicKey, key_id: keyId },
    ]);
    const pin = jest.fn((projectId: string, userId: string, publicKey: string) =>
      pinMemberKey(store, projectId, userId, publicKey),
    );

    const result = await sealMissingProjectKeys(api, keyring, readKeyTrust(store), pin);

    expect(result).toEqual({ sealed: 1, skipped: 1, failed: 0, keyChanged: [] });
    expect(pin).toHaveBeenCalledWith("p1", "u-alice", alice.publicKey);
    expect(pin).toHaveBeenCalledTimes(1);
    const [, memberId, sealed] = api.putMemberProjectKey.mock.calls[0]!;
    expect(memberId).toBe("u-alice");
    expect(unsealKey(sealed, alice.secretKey)).toEqual(pek);
    // Pinned now: a later change of that public key is reported, as for an invited member.
    expect(readKeyTrust(store).pins.get("p1:u-alice")).toBe(alice.publicKey);
  });
});
