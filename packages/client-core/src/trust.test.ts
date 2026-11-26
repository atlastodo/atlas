import { describe, expect, it } from "bun:test";
import { LocalStore } from "./store";
import {
  EMPTY_KEY_TRUST,
  forgetIdentity,
  isVerified,
  observeIdentity,
  readKeyTrust,
  recordFirstKeyMembers,
  recordLegacySharesAccepted,
  recordMintedKey,
  recordRetiredKey,
  recordVerified,
} from "./trust";

const USER = "0190a6f0-0000-7000-8000-0000000000e2";
const P = "0190a6f0-0000-7000-8000-00000000a001";
const X1 = "11".repeat(32);
const X2 = "12".repeat(32);
const E1 = "21".repeat(32);
const E2 = "22".repeat(32);

function store() {
  let n = 0;
  return new LocalStore("0190a6f0-0000-7000-8000-0000000000d1", {
    newId: () => `0190a6f0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
  });
}

describe("identity pins", () => {
  it("pins on first use and reports any later change without adopting it", () => {
    const s = store();
    const see = (publicKey: string | null, signingKey: string | null) =>
      observeIdentity(s, readKeyTrust(s), USER, { publicKey, signingKey }).status;
    expect(see(null, null)).toBe("unknown");
    expect(see(X1, E1)).toBe("trusted");
    expect(see(X1.toUpperCase(), E1)).toBe("trusted");
    expect(see(X2, E1)).toBe("changed");
    expect(see(X1, E2)).toBe("changed");
    // A signing key the server stops publishing is a change too.
    expect(see(X1, null)).toBe("changed");
    expect(readKeyTrust(s).identities.get(USER)).toEqual({ publicKey: X1, signingKey: E1 });
  });

  it("fills in a signing key published after the X25519 key", () => {
    const s = store();
    expect(observeIdentity(s, readKeyTrust(s), USER, { publicKey: X1 }).status).toBe("trusted");
    expect(readKeyTrust(s).identities.get(USER)).toEqual({ publicKey: X1, signingKey: null });
    expect(
      observeIdentity(s, readKeyTrust(s), USER, { publicKey: X1, signingKey: E1 }).status,
    ).toBe("trusted");
    expect(readKeyTrust(s).identities.get(USER)).toEqual({ publicKey: X1, signingKey: E1 });
    expect(
      observeIdentity(s, readKeyTrust(s), USER, { publicKey: X1, signingKey: E2 }).status,
    ).toBe("changed");
  });

  it("compares without pinning when given no store", () => {
    expect(observeIdentity(null, EMPTY_KEY_TRUST, USER, { publicKey: X1, signingKey: E1 })).toEqual(
      {
        status: "trusted",
        pinned: { publicKey: X1, signingKey: E1 },
      },
    );
  });

  it("keeps a verification only for the number it was made for, until the pin is forgotten", () => {
    const s = store();
    observeIdentity(s, readKeyTrust(s), USER, { publicKey: X1, signingKey: E1 });
    recordVerified(s, USER, "1".repeat(60));
    expect(isVerified(readKeyTrust(s), USER, "1".repeat(60))).toBe(true);
    expect(isVerified(readKeyTrust(s), USER, "2".repeat(60))).toBe(false);
    forgetIdentity(s, USER);
    expect(readKeyTrust(s).identities.has(USER)).toBe(false);
    expect(isVerified(readKeyTrust(s), USER, "1".repeat(60))).toBe(false);
    // Pinned afresh after that.
    expect(
      observeIdentity(s, readKeyTrust(s), USER, { publicKey: X2, signingKey: E2 }).status,
    ).toBe("trusted");
  });

  it("records retired keys", () => {
    const s = store();
    recordRetiredKey(s, P, "ab".repeat(16));
    expect(readKeyTrust(s).retired).toEqual(new Set([`${P}:${"ab".repeat(16)}`]));
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

describe("recordLegacySharesAccepted", () => {
  it("accepts, once, the shares the user is an active member of but does not own", () => {
    const store = new LocalStore("device");
    member(store, "joined", "me", "editor", "active");
    member(store, "commented", "me", "commenter", "active");
    member(store, "invited", "me", "editor", "pending");
    member(store, "mine", "me", "owner", "active");
    member(store, "minted", "me", "editor", "active");
    recordMintedKey(store, "minted", "k".repeat(32));
    member(store, "theirs", "someone", "editor", "active");

    expect(recordLegacySharesAccepted(store, "me")).toBe(true);
    expect([...readKeyTrust(store).accepted].sort()).toEqual(["commented", "joined"]);

    // Once per account: a share that shows up later went through an invite.
    member(store, "later", "me", "editor", "active");
    expect(recordLegacySharesAccepted(store, "me")).toBe(false);
    expect(readKeyTrust(store).accepted.has("later")).toBe(false);
  });
});

describe("first key members", () => {
  it("round-trips through the trust state", () => {
    const store = new LocalStore("device");
    recordFirstKeyMembers(store, "p1", ["u-b", "u-a"]);
    recordFirstKeyMembers(store, "p2", []);

    const trust = readKeyTrust(store);
    expect([...trust.firstKeyMembers.get("p1")!]).toEqual(["u-a", "u-b"]);
    expect(trust.firstKeyMembers.get("p2")!.size).toBe(0);
  });
});
