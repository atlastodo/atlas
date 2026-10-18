import { fireEvent, render as render, screen, waitFor } from "@testing-library/react-native";
import {
  ApiError,
  Keyring,
  LocalStore,
  generateDek,
  generatePek,
  generateSigningKeypair,
  generateUserKeypair,
  observeIdentity,
  projectKeyId,
  safetyNumber,
  safetyNumberGroups,
  unsealKey,
  pinMemberKey,
  pinnedMemberKey,
  readKeyTrust,
  unwrapProjectKey,
  verifyDelivery,
  type ApiClient,
  type EncryptedPayload,
  type MemberRole,
  type MemberView,
  type ProjectKeysResponse,
  type SealedKey,
} from "@atlastodo/client-core";
import { fakeAuth, withApp } from "../testutil";
import { ShareDialog } from "./ShareDialog";

/**
 * Membership is REST-driven (not the store), so this injects a fake `ApiClient` through the auth
 * context and asserts the dialog lists members and calls invite/updateRole/remove. No network, no
 * mocks of our own modules -- the fake is the seam the real code already uses. The keyring and the
 * store are real, so the key a share delivers can be opened exactly as the invitee would.
 */

const carol = generateUserKeypair();
const bob = generateUserKeypair();
const bobSigning = generateSigningKeypair();
const mySigning = generateSigningKeypair();
const PUBLIC_KEYS: Record<string, string> = {
  "carol@example.com": carol.publicKey,
  "bob@example.com": bob.publicKey,
};

function newKeyring(): Keyring {
  const me = generateUserKeypair();
  return new Keyring({
    dek: generateDek(),
    userPrivateKey: me.secretKey,
    userPublicKey: me.publicKey,
    signingKey: mySigning.secretKey,
  });
}

function fakeApi(
  members: MemberView[],
  calls: string[],
  keys: ProjectKeysResponse = { keys: [], canonical: {} },
) {
  const api = {
    listMembers: jest.fn(async () => members),
    inviteMember: jest.fn(async (_p: string, email: string, role: MemberRole) => {
      calls.push("inviteMember");
      const member: MemberView = {
        user_id: "u-carol",
        email,
        display_name: "",
        role,
        state: "pending",
        has_key: false,
        invited_by: "me",
      };
      return member;
    }),
    updateMemberRole: jest.fn(async () => members[0]!),
    removeMember: jest.fn(async () => {}),
    listProjectKeys: jest.fn(async () => {
      calls.push("listProjectKeys");
      return keys;
    }),
    putProjectKey: jest.fn(async (_p: string, _wrapped: EncryptedPayload, _keyId: string) => {
      calls.push("putProjectKey");
    }),
    getUserPublicKey: jest.fn(async (email: string) => ({
      user_id: email === "bob@example.com" ? "u-bob" : "u-carol",
      email,
      public_key: PUBLIC_KEYS[email] ?? null,
      signing_public_key: email === "bob@example.com" ? bobSigning.publicKey : null,
    })),
    putMemberProjectKey: jest.fn(
      async (_p: string, _member: string, _sealed: SealedKey, _keyId: string, _sig: string) => {
        calls.push("putMemberProjectKey");
      },
    ),
    listKeyRotations: jest.fn(async () => [] as { project_id: string; request: number }[]),
    completeKeyRotation: jest.fn(async (_p: string, _keyId: string, _request: number) => {
      calls.push("completeKeyRotation");
    }),
  };
  return api as unknown as ApiClient & typeof api;
}

async function mount(
  members: MemberView[],
  opts: {
    store?: LocalStore;
    keyring?: Keyring | null;
    keys?: ProjectKeysResponse;
    calls?: string[];
  } = {},
) {
  const calls = opts.calls ?? [];
  const api = fakeApi(members, calls, opts.keys);
  const keyring = opts.keyring === undefined ? newKeyring() : opts.keyring;
  const auth = fakeAuth({
    api,
    keyring,
    session: {
      accessToken: "a",
      refreshToken: "r",
      deviceId: "d",
      user: { id: "me", email: "me@example.com", display_name: "Me" },
    },
  });
  await render(<ShareDialog projectId="p1" projectName="Home reno" onClose={() => {}} />, {
    wrapper: withApp(opts.store ?? new LocalStore("test"), auth, null),
  });
  return { api, keyring, calls };
}

function addMember(store: LocalStore, id: string, userId: string, role: MemberRole) {
  store.set("project_member", id, "project_id", "p1");
  store.set("project_member", id, "user_id", userId);
  store.set("project_member", id, "role", role);
  store.set("project_member", id, "state", "active");
}

async function inviteCarol() {
  await fireEvent.changeText(screen.getByLabelText("Invite by email"), "carol@example.com");
  await fireEvent.press(screen.getByLabelText("Send invite"));
}

const owner: MemberView = {
  user_id: "me",
  email: "me@example.com",
  display_name: "Me",
  role: "owner",
  state: "active",
  has_key: true,
  invited_by: null,
};
const editor: MemberView = {
  user_id: "u-bob",
  email: "bob@example.com",
  display_name: "Bob",
  role: "editor",
  state: "active",
  has_key: true,
  invited_by: "me",
  public_key: bob.publicKey,
  signing_public_key: bobSigning.publicKey,
};

describe("ShareDialog", () => {
  it("invites a member by email and role", async () => {
    const { api } = await mount([owner]);
    await waitFor(() => expect(api.listMembers).toHaveBeenCalled());

    await inviteCarol();

    await waitFor(() =>
      expect(api.inviteMember).toHaveBeenCalledWith("p1", "carol@example.com", "editor"),
    );
  });

  it("removes a non-owner member", async () => {
    const { api } = await mount([owner, editor]);
    await waitFor(() => expect(screen.getByText(/Bob/)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Remove bob@example.com"));
    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("p1", "u-bob"));
  });

  it("on a first share stores the new key, re-encrypts the project, invites, then seals", async () => {
    // Re-encryption writes at a successor timestamp, which needs a real (uuid) HLC node.
    const store = new LocalStore("00000000-0000-4000-8000-000000000001");
    store.set("project", "p1", "name", "Home reno");
    store.set("task", "t1", "project_id", "p1");
    store.set("task", "t1", "title", "Paint the hall");
    store.markSynced(store.unsyncedOps().map((o) => o.id));
    const calls: string[] = [];
    // The re-encryption shows up as fresh local writes of the project's existing content.
    store.onChange(() => {
      if (!calls.includes("rescope") && store.unsyncedOps().length > 0) calls.push("rescope");
    });

    const { api, keyring } = await mount([owner], { store, calls });
    await waitFor(() => expect(api.listMembers).toHaveBeenCalled());
    await inviteCarol();
    await waitFor(() => expect(api.putMemberProjectKey).toHaveBeenCalled());

    expect(calls.filter((c) => c !== "listProjectKeys")).toEqual([
      "putProjectKey",
      "rescope",
      "inviteMember",
      "putMemberProjectKey",
    ]);
    const pek = keyring!.getProjectKey("p1")!;
    const keyId = projectKeyId(pek);
    expect(keyring!.canonicalKeyId("p1")).toBe(keyId);
    // Our own copy opens with our DEK; the invitee's opens with their private key.
    const [, wrapped, ownKeyId] = api.putProjectKey.mock.calls[0]!;
    expect(ownKeyId).toBe(keyId);
    expect(unwrapProjectKey(wrapped, keyring!.getDek(), "p1")).toEqual(pek);
    // Recorded as the key this account minted, and the invitee's public key pinned.
    expect(readKeyTrust(store).minted.get("p1")).toBe(keyId);
    expect(pinnedMemberKey(readKeyTrust(store), "p1", "u-carol")).toBe(carol.publicKey);
    const [projectId, memberId, sealed, sealedKeyId, signature] =
      api.putMemberProjectKey.mock.calls[0]!;
    expect([projectId, memberId, sealedKeyId]).toEqual(["p1", "u-carol", keyId]);
    expect(unsealKey(sealed, carol.secretKey)).toEqual(pek);
    expect(
      verifyDelivery(mySigning.publicKey, signature, {
        projectId: "p1",
        recipientId: "u-carol",
        keyId,
        sealed,
      }),
    ).toBe(true);
    const rewritten = store
      .unsyncedOps()
      .map((o) => (o.op === "set" ? `${o.entity}.${o.field}` : `${o.entity} deleted`));
    expect(rewritten).toEqual(expect.arrayContaining(["project.name", "task.title"]));
  });

  it("never mints a key for a shared project whose key this device lacks", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    addMember(store, "m-bob", "u-bob", "editor");
    const { api, keyring } = await mount([owner, editor], {
      store,
      keys: { keys: [], canonical: { p1: "0".repeat(32) } },
    });
    await waitFor(() => expect(screen.getByText(/Bob/)).toBeTruthy());

    await inviteCarol();

    await waitFor(() =>
      expect(screen.getByText("The project key isn't available on this device yet")).toBeTruthy(),
    );
    expect(api.listProjectKeys).toHaveBeenCalled();
    expect(api.putProjectKey).not.toHaveBeenCalled();
    expect(api.inviteMember).not.toHaveBeenCalled();
    expect(api.putMemberProjectKey).not.toHaveBeenCalled();
    expect(keyring!.getProjectKey("p1")).toBeUndefined();
  });

  it("says the person is already a member instead of a generic failure", async () => {
    const { api } = await mount([owner, editor]);
    api.inviteMember.mockRejectedValueOnce(
      new ApiError(409, "already a member of this project", { code: "already_member" }),
    );
    await waitFor(() => expect(api.listMembers).toHaveBeenCalled());

    await fireEvent.changeText(screen.getByLabelText("Invite by email"), "bob@example.com");
    await fireEvent.press(screen.getByLabelText("Send invite"));

    await waitFor(() =>
      expect(
        screen.getByText("Already a member — change their role in the list below."),
      ).toBeTruthy(),
    );
  });

  it("shows a failed key delivery in the dialog", async () => {
    const store = new LocalStore("test");
    const { api } = await mount([owner], { store });
    api.putMemberProjectKey.mockRejectedValueOnce(new ApiError(500, "boom"));
    await waitFor(() => expect(api.listMembers).toHaveBeenCalled());

    await inviteCarol();

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't send the project key to carol@example.com \(boom\)/),
      ).toBeTruthy(),
    );
    expect(api.inviteMember).toHaveBeenCalled();
  });

  it("re-sends the key to a member who lacks it", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    const keyring = newKeyring();
    const pek = generatePek();
    const keyId = keyring.setProjectKey("p1", pek);
    const pendingBob: MemberView = { ...editor, state: "pending", has_key: false };
    const { api } = await mount([owner, pendingBob], { store, keyring });

    await waitFor(() => expect(screen.getByText("Key pending")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Retry sending the key to bob@example.com"));

    await waitFor(() => expect(api.putMemberProjectKey).toHaveBeenCalledTimes(1));
    const [projectId, memberId, sealed, sealedKeyId] = api.putMemberProjectKey.mock.calls[0]!;
    expect([projectId, memberId, sealedKeyId]).toEqual(["p1", "u-bob", keyId]);
    expect(unsealKey(sealed, bob.secretKey)).toEqual(pek);
    expect(api.getUserPublicKey).toHaveBeenCalledWith("bob@example.com");
    await waitFor(() => expect(api.listMembers).toHaveBeenCalledTimes(2));
  });

  it("does not send the key to a public key other than the one pinned at the invite", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    pinMemberKey(store, "p1", "u-bob", generateUserKeypair().publicKey);
    const keyring = newKeyring();
    keyring.setProjectKey("p1", generatePek());
    const pendingBob: MemberView = { ...editor, state: "pending", has_key: false };
    const { api } = await mount([owner, pendingBob], { store, keyring });

    await waitFor(() => expect(screen.getByText("Key pending")).toBeTruthy());
    await fireEvent.press(screen.getByLabelText("Retry sending the key to bob@example.com"));

    await waitFor(() =>
      expect(screen.getByText(/encryption key has changed since you invited them/)).toBeTruthy(),
    );
    expect(api.putMemberProjectKey).not.toHaveBeenCalled();
  });

  it("shows no key status to a member who is not the owner", async () => {
    const viewer: MemberView = { ...owner, role: "editor" };
    const other: MemberView = { ...editor, user_id: "u-x", email: "x@example.com", has_key: false };
    await mount([viewer, other]);
    await waitFor(() => expect(screen.getByText(/Bob/)).toBeTruthy());
    expect(screen.queryByText("Key pending")).toBeNull();
  });

  it("shows the safety number both sides compute, and records a verification for those keys", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    const keyring = newKeyring();
    await mount([owner, editor], { store, keyring });
    await waitFor(() => expect(screen.getByText(/Bob/)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Show the safety number for bob@example.com"));
    const number = safetyNumber(
      { userId: "u-bob", publicKey: bob.publicKey, signingKey: bobSigning.publicKey },
      { userId: "me", publicKey: keyring.getUserPublicKey()!, signingKey: mySigning.publicKey },
    );
    const groups = safetyNumberGroups(number);
    await waitFor(() => expect(screen.getByText(groups[0]!)).toBeTruthy());
    expect(screen.getByLabelText(`Safety number: ${groups.join(", ")}`)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Mark bob@example.com as verified"));
    expect(readKeyTrust(store).verified.get("u-bob")).toBe(number);
    await waitFor(() =>
      expect(screen.getByLabelText("Remove the verification of bob@example.com")).toBeTruthy(),
    );
    await fireEvent.press(screen.getByLabelText("Hide the safety number for bob@example.com"));
    expect(screen.getByLabelText("bob@example.com is verified")).toBeTruthy();
  });

  it("warns about a member whose keys changed, and drops their verification", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    // Pinned (and verified) earlier with other keys than the server lists now.
    observeIdentity(store, readKeyTrust(store), "u-bob", {
      publicKey: generateUserKeypair().publicKey,
      signingKey: generateSigningKeypair().publicKey,
    });
    store.set(
      "preference",
      "00000000-0000-4000-8000-00000000e2ee",
      "verified:u-bob",
      "1".repeat(60),
    );
    await mount([owner, editor], { store });

    await waitFor(() =>
      expect(screen.getByText(/Bob's encryption keys have changed/)).toBeTruthy(),
    );
    expect(screen.queryByLabelText("bob@example.com is verified")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Show the safety number for bob@example.com"));
    expect(screen.getByText(/No safety number yet/)).toBeTruthy();
    expect(screen.queryByLabelText("Mark bob@example.com as verified")).toBeNull();
  });

  it("rotates the project key after removing a member, without sending it to them", async () => {
    const store = new LocalStore("test");
    addMember(store, "m-me", "me", "owner");
    const keyring = newKeyring();
    const old = keyring.setProjectKey("p1", generatePek());
    pinMemberKey(store, "p1", "u-bob", bob.publicKey);
    const calls: string[] = [];
    const { api } = await mount([owner, editor], { store, keyring, calls });
    api.listKeyRotations.mockResolvedValue([{ project_id: "p1", request: 1 }]);
    await waitFor(() => expect(screen.getByText(/Bob/)).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Remove bob@example.com"));

    await waitFor(() => expect(api.completeKeyRotation).toHaveBeenCalled());
    const [, keyId, request] = api.completeKeyRotation.mock.calls[0]!;
    expect(request).toBe(1);
    expect(keyring.canonicalKeyId("p1")).toBe(keyId);
    expect(keyring.isRetired("p1", old)).toBe(true);
    // The server still lists Bob in this double; he gets nothing.
    expect(api.putMemberProjectKey).not.toHaveBeenCalled();
    expect(pinnedMemberKey(readKeyTrust(store), "p1", "u-bob")).toBeUndefined();
  });
});
