import { describe, expect, it, vi } from "bun:test";
import {
  Keyring,
  generateDek,
  generatePek,
  generateSigningKeypair,
  generateUserKeypair,
  projectKeyId,
  sealKey,
  signDelivery,
  unwrapProjectKey,
  wrapKey,
  wrapProjectKey,
  type EncryptedPayload,
  type SigningKeypair,
  type UserKeypair,
} from "./crypto";
import { hydrateProjectKeys, type ProjectKeysTransport } from "./projectKeys";
import { LocalStore } from "./store";
import * as trust from "./trust";
import type { ProjectKeyRow, ProjectKeysResponse } from "./types";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const ME = "0190a6f0-0000-7000-8000-0000000000e1";
const OWNER = "0190a6f0-0000-7000-8000-0000000000e2";
const OTHER = "0190a6f0-0000-7000-8000-0000000000e3";

function me() {
  const dek = generateDek();
  const pair = generateUserKeypair();
  return {
    dek,
    pair,
    keyring: () => new Keyring({ dek, privateKey: pair.secretKey, publicKey: pair.publicKey }),
  };
}

interface Owner {
  id: string;
  pair: UserKeypair;
  signing: SigningKeypair;
}

function owner(id = OWNER): Owner {
  return { id, pair: generateUserKeypair(), signing: generateSigningKeypair() };
}

/**
 * A delivery of `pek` for `projectId` sealed to `recipient`, signed by `from` (optionally in the
 * shape ShareDialog once wrote, or signed over other fields than the row claims).
 */
function delivery(
  pek: Uint8Array,
  projectId: string,
  recipientKey: string,
  from: Owner,
  opts: { legacyShape?: boolean; signedFor?: { projectId?: string; recipientId?: string } } = {},
): ProjectKeyRow {
  const sealed = sealKey(pek, recipientKey);
  const keyId = projectKeyId(pek);
  const signature = signDelivery(from.signing.secretKey, {
    projectId: opts.signedFor?.projectId ?? projectId,
    recipientId: opts.signedFor?.recipientId ?? ME,
    keyId,
    sealed,
  });
  return {
    project_id: projectId,
    key_id: keyId,
    kind: "sealed",
    encrypted_pek: opts.legacyShape
      ? { iv: sealed.ephemeralPublicKey, ct: JSON.stringify(sealed.encryptedKey) }
      : sealed,
    signature,
    signed_by: from.id,
    signer_public_key: from.pair.publicKey,
    signer_signing_key: from.signing.publicKey,
  };
}

function trustStore() {
  let n = 0;
  return new LocalStore("0190a6f0-0000-7000-8000-0000000000d1", {
    newId: () => `0190a6f0-0000-7000-8000-${(++n).toString(16).padStart(12, "0")}`,
  });
}

function fakeApi(response: ProjectKeysResponse) {
  const puts: { projectId: string; encryptedPek: EncryptedPayload; keyId: string }[] = [];
  const api: ProjectKeysTransport & { puts: typeof puts } = {
    puts,
    listProjectKeys: vi.fn(async () => response),
    putProjectKey: vi.fn(
      async (projectId: string, encryptedPek: EncryptedPayload, keyId: string) => {
        puts.push({ projectId, encryptedPek, keyId });
      },
    ),
  };
  return api;
}

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("hydrateProjectKeys", () => {
  it("loads every row shape ever written", async () => {
    const u = me();
    const [a, b, c, d, e] = [
      generatePek(),
      generatePek(),
      generatePek(),
      generatePek(),
      generatePek(),
    ];
    const rows: ProjectKeyRow[] = [
      {
        project_id: P1,
        key_id: projectKeyId(a),
        kind: "wrapped",
        encrypted_pek: wrapKey(a, u.dek),
      },
      { project_id: P1, key_id: "", kind: "wrapped", encrypted_pek: wrapKey(b, u.dek) },
      delivery(c, P2, u.pair.publicKey, owner()),
      delivery(d, P2, u.pair.publicKey, owner(), { legacyShape: true }),
      // A legacy delivery labelled by its row kind alone would be misread; the shape decides.
      { ...delivery(e, P2, u.pair.publicKey, owner(), { legacyShape: true }), kind: "wrapped" },
    ];
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(fakeApi({ keys: rows, canonical: {} }), keyring, {
      userId: ME,
    });

    expect(result.failed).toBe(0);
    const ids = (p: string) =>
      keyring
        .projectKeys(p)
        .map((k) => k.keyId)
        .sort();
    expect(ids(P1)).toEqual([projectKeyId(a), projectKeyId(b)].sort());
    expect(ids(P2)).toEqual([projectKeyId(c), projectKeyId(d), projectKeyId(e)].sort());
    const held = keyring.projectKeys(P2).find((k) => k.keyId === projectKeyId(d))!;
    expect(held.key).toEqual(d);
  });

  it("keeps every key of a project and uses the server's canonical one", async () => {
    const u = me();
    const [old, current] = [generatePek(), generatePek()];
    const keyring = u.keyring();
    await hydrateProjectKeys(
      fakeApi({
        keys: [
          {
            project_id: P1,
            key_id: projectKeyId(old),
            kind: "wrapped",
            encrypted_pek: wrapKey(old, u.dek),
          },
          {
            project_id: P1,
            key_id: projectKeyId(current),
            kind: "wrapped",
            encrypted_pek: wrapKey(current, u.dek),
          },
        ],
        canonical: { [P1]: projectKeyId(current) },
      }),
      keyring,
    );
    expect(keyring.getProjectKey(P1)).toEqual(current);
    expect(keyring.projectKeys(P1)).toHaveLength(2);
    // History stays available for decryption.
    expect(keyring.allKeys().map((k) => k.keyId)).toEqual(
      expect.arrayContaining(["dek", projectKeyId(old), projectKeyId(current)]),
    );
  });

  it("names a canonical key it does not hold, so writes wait instead of forking", async () => {
    const u = me();
    const mine = generatePek();
    const keyring = u.keyring();
    await hydrateProjectKeys(
      fakeApi({
        keys: [
          {
            project_id: P1,
            key_id: projectKeyId(mine),
            kind: "wrapped",
            encrypted_pek: wrapKey(mine, u.dek),
          },
        ],
        canonical: { [P1]: projectKeyId(generatePek()) },
      }),
      keyring,
    );
    expect(keyring.getProjectKey(P1)).toBeUndefined();
    expect(keyring.projectKeys(P1)).toHaveLength(1);
  });

  it("falls back to the creator's only key when the server names none", async () => {
    const u = me();
    const only = generatePek();
    const [x, y] = [generatePek(), generatePek()];
    const response: ProjectKeysResponse = {
      keys: [
        {
          project_id: P1,
          key_id: projectKeyId(only),
          kind: "wrapped",
          encrypted_pek: wrapKey(only, u.dek),
        },
        {
          project_id: P2,
          key_id: projectKeyId(x),
          kind: "wrapped",
          encrypted_pek: wrapKey(x, u.dek),
        },
        {
          project_id: P2,
          key_id: projectKeyId(y),
          kind: "wrapped",
          encrypted_pek: wrapKey(y, u.dek),
        },
      ],
      canonical: {},
    };

    const creator = u.keyring();
    await hydrateProjectKeys(fakeApi(response), creator, { isCreator: () => true });
    expect(creator.getProjectKey(P1)).toEqual(only);
    expect(creator.getProjectKey(P2)).toBeUndefined(); // two candidates: no guessing

    const member = u.keyring();
    await hydrateProjectKeys(fakeApi(response), member, { isCreator: () => false });
    expect(member.getProjectKey(P1)).toBeUndefined();
  });

  it("stores unsealed, unfingerprinted and unbound keys back as the caller's own bound copies, once", async () => {
    const u = me();
    const [fingerprinted, legacy, delivered] = [generatePek(), generatePek(), generatePek()];
    const rows: ProjectKeyRow[] = [
      {
        project_id: P1,
        key_id: projectKeyId(fingerprinted),
        kind: "wrapped",
        encrypted_pek: wrapKey(fingerprinted, u.dek),
      },
      { project_id: P1, key_id: "", kind: "wrapped", encrypted_pek: wrapKey(legacy, u.dek) },
      delivery(delivered, P2, u.pair.publicKey, owner()),
    ];
    const api = fakeApi({ keys: rows, canonical: {} });
    const result = await hydrateProjectKeys(api, u.keyring(), { userId: ME });

    expect(result.backfilled).toBe(3);
    const byKey = new Map(api.puts.map((p) => [p.keyId, p]));
    expect([...byKey.keys()].sort()).toEqual(
      [projectKeyId(fingerprinted), projectKeyId(legacy), projectKeyId(delivered)].sort(),
    );
    expect(byKey.get(projectKeyId(legacy))!.projectId).toBe(P1);
    const stored = byKey.get(projectKeyId(delivered))!.encryptedPek;
    expect(unwrapProjectKey(stored, u.dek, P2)).toEqual(delivered);
    // Bound to its project: it does not open as another project's key.
    expect(() => unwrapProjectKey(stored, u.dek, P1)).toThrow();

    // Once the server holds those wrapped copies, a second hydration writes nothing.
    const after: ProjectKeyRow[] = [
      ...rows.filter((r) => r.kind === "wrapped"),
      ...api.puts.map((p) => ({
        project_id: p.projectId,
        key_id: p.keyId,
        kind: "wrapped" as const,
        encrypted_pek: p.encryptedPek,
      })),
    ];
    const again = fakeApi({ keys: after, canonical: {} });
    expect((await hydrateProjectKeys(again, u.keyring())).backfilled).toBe(0);
    expect(again.puts).toHaveLength(0);
  });

  it("is idempotent", async () => {
    const u = me();
    const pek = generatePek();
    const response: ProjectKeysResponse = {
      keys: [
        {
          project_id: P1,
          key_id: projectKeyId(pek),
          kind: "wrapped",
          encrypted_pek: wrapKey(pek, u.dek),
        },
      ],
      canonical: { [P1]: projectKeyId(pek) },
    };
    const keyring = u.keyring();
    expect((await hydrateProjectKeys(fakeApi(response), keyring)).changed).toBe(true);
    expect((await hydrateProjectKeys(fakeApi(response), keyring)).changed).toBe(false);
    expect(keyring.projectKeys(P1)).toHaveLength(1);
    expect(keyring.getProjectKey(P1)).toEqual(pek);
  });

  it("skips a bad row and keeps going", async () => {
    const warn = quiet();
    const u = me();
    const good = generatePek();
    const rows: ProjectKeyRow[] = [
      {
        project_id: P1,
        key_id: "",
        kind: "wrapped",
        encrypted_pek: wrapKey(generatePek(), generateDek()),
      },
      { project_id: P1, key_id: "", kind: "sealed", encrypted_pek: { iv: "zz", ct: "not json" } },
      { project_id: P1, key_id: "", kind: "wrapped", encrypted_pek: "garbage" },
      { project_id: P1, key_id: "", kind: "wrapped", encrypted_pek: null },
      {
        project_id: P2,
        key_id: projectKeyId(good),
        kind: "wrapped",
        encrypted_pek: wrapKey(good, u.dek),
      },
    ];
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(
      fakeApi({ keys: rows, canonical: { [P2]: projectKeyId(good) } }),
      keyring,
    );
    expect(result.failed).toBe(4);
    expect(keyring.getProjectKey(P2)).toEqual(good);
    expect(keyring.projectKeys(P1)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the loaded keys when storing a backfill fails", async () => {
    const warn = quiet();
    const u = me();
    const pek = generatePek();
    const api = fakeApi({
      keys: [delivery(pek, P1, u.pair.publicKey, owner())],
      canonical: {},
    });
    api.putProjectKey = vi.fn(async () => {
      throw new Error("offline");
    });
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(api, keyring, { userId: ME });
    expect(result.backfilled).toBe(0);
    expect(keyring.projectKeys(P1).map((k) => k.key)).toEqual([pek]);
    warn.mockRestore();
  });
});

describe("signed deliveries", () => {
  it("loads an unsigned delivery only when it holds a key already held", async () => {
    const warn = quiet();
    const u = me();
    const [known, unknown] = [generatePek(), generatePek()];
    const unsigned = (pek: Uint8Array): ProjectKeyRow => ({
      project_id: P1,
      key_id: projectKeyId(pek),
      kind: "sealed",
      encrypted_pek: sealKey(pek, u.pair.publicKey),
    });
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(
      fakeApi({
        // The delivery comes first; the own copy is still checked before it.
        keys: [
          unsigned(known),
          unsigned(unknown),
          {
            project_id: P1,
            key_id: projectKeyId(known),
            kind: "wrapped",
            encrypted_pek: wrapProjectKey(known, u.dek, P1),
          },
        ],
        canonical: {},
      }),
      keyring,
      { userId: ME },
    );
    expect(keyring.projectKeys(P1).map((k) => k.keyId)).toEqual([projectKeyId(known)]);
    expect(result.rejected).toBe(1);
    warn.mockRestore();
  });

  it("refuses a delivery the server moved to another project, member or key", async () => {
    const warn = quiet();
    const u = me();
    const from = owner();
    const pek = generatePek();
    const rows: ProjectKeyRow[] = [
      delivery(pek, P1, u.pair.publicKey, from, { signedFor: { projectId: P2 } }),
      delivery(pek, P1, u.pair.publicKey, from, { signedFor: { recipientId: OTHER } }),
      { ...delivery(pek, P1, u.pair.publicKey, from), key_id: projectKeyId(generatePek()) },
      // Signed by one key, published with another.
      {
        ...delivery(pek, P1, u.pair.publicKey, from),
        signer_signing_key: owner().signing.publicKey,
      },
      { ...delivery(pek, P1, u.pair.publicKey, from), signed_by: ME },
      { ...delivery(pek, P1, u.pair.publicKey, from), signature: "00".repeat(64) },
    ];
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(fakeApi({ keys: rows, canonical: {} }), keyring, {
      userId: ME,
    });
    expect(result.rejected).toBe(rows.length);
    expect(keyring.projectKeys(P1)).toEqual([]);
    warn.mockRestore();
  });

  it("pins the signer on first use and refuses a signer whose keys changed", async () => {
    const warn = quiet();
    const u = me();
    const store = trustStore();
    const from = owner();
    trust.recordAcceptedProject(store, P1);
    trust.recordAcceptedProject(store, P2);
    const first = generatePek();
    await hydrateProjectKeys(
      fakeApi({ keys: [delivery(first, P1, u.pair.publicKey, from)], canonical: {} }),
      u.keyring(),
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    const pinned = trust.readKeyTrust(store);
    expect(pinned.identities.get(OWNER)).toEqual({
      publicKey: from.pair.publicKey,
      signingKey: from.signing.publicKey,
    });
    // The owner who delivered becomes someone this member may deliver the project's keys to.
    expect(trust.pinnedMemberKey(pinned, P1, OWNER)).toBe(from.pair.publicKey);

    // The server swaps in keys of its own under the same account.
    const impostor = { ...owner(), id: OWNER };
    const keyring = u.keyring();
    const result = await hydrateProjectKeys(
      fakeApi({ keys: [delivery(generatePek(), P2, u.pair.publicKey, impostor)], canonical: {} }),
      keyring,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(result.rejected).toBe(1);
    expect(result.signerChanged).toEqual([OWNER]);
    expect(keyring.projectKeys(P2)).toEqual([]);
    expect(trust.readKeyTrust(store).identities.get(OWNER)?.signingKey).toBe(
      from.signing.publicKey,
    );
    warn.mockRestore();
  });

  it("takes a key for the user's own project only from a co-owner they invited", async () => {
    const warn = quiet();
    const u = me();
    const store = trustStore();
    const mine = generatePek();
    trust.recordMintedKey(store, P1, projectKeyId(mine));
    const coOwner = owner();
    const stranger = owner(OTHER);
    const [fromCoOwner, fromStranger] = [generatePek(), generatePek()];
    const response: ProjectKeysResponse = {
      keys: [
        {
          project_id: P1,
          key_id: projectKeyId(mine),
          kind: "wrapped",
          encrypted_pek: wrapProjectKey(mine, u.dek, P1),
        },
        delivery(fromCoOwner, P1, u.pair.publicKey, coOwner),
        delivery(fromStranger, P1, u.pair.publicKey, stranger),
      ],
      canonical: {},
    };
    const before = u.keyring();
    await hydrateProjectKeys(fakeApi(response), before, {
      userId: ME,
      trust: trust.readKeyTrust(store),
    });
    expect(before.projectKeys(P1).map((k) => k.keyId)).toEqual([projectKeyId(mine)]);

    trust.pinMemberKey(store, P1, OWNER, coOwner.pair.publicKey);
    const after = u.keyring();
    const result = await hydrateProjectKeys(fakeApi(response), after, {
      userId: ME,
      trust: trust.readKeyTrust(store),
    });
    expect(after.projectKeys(P1).map((k) => k.keyId)).toEqual([
      projectKeyId(mine),
      projectKeyId(fromCoOwner),
    ]);
    expect(result.rejected).toBe(1);
    expect(after.canonicalKeyId(P1)).toBe(projectKeyId(mine));
    warn.mockRestore();
  });
});

describe("rotated keys", () => {
  it("moves the user's own project to the new key once the old one is retired", async () => {
    const warn = quiet();
    const u = me();
    const store = trustStore();
    const [old, rotated] = [generatePek(), generatePek()];
    const coOwner = owner();
    trust.recordMintedKey(store, P1, projectKeyId(old));
    trust.pinMemberKey(store, P1, OWNER, coOwner.pair.publicKey);
    const own: ProjectKeyRow = {
      project_id: P1,
      key_id: projectKeyId(old),
      kind: "wrapped",
      encrypted_pek: wrapProjectKey(old, u.dek, P1),
    };
    const next = delivery(rotated, P1, u.pair.publicKey, coOwner);

    // Named canonical but the old key is not retired: the minted key stays.
    const notRetired = u.keyring();
    await hydrateProjectKeys(
      fakeApi({ keys: [own, next], canonical: { [P1]: projectKeyId(rotated) } }),
      notRetired,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(notRetired.canonicalKeyId(P1)).toBe(projectKeyId(old));

    // Retired, and the device holds the key that replaced it: the project moves, for good.
    const keyring = u.keyring();
    await hydrateProjectKeys(
      fakeApi({
        keys: [own, next],
        canonical: { [P1]: projectKeyId(rotated) },
        retired: { [P1]: [projectKeyId(old)] },
      }),
      keyring,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(keyring.canonicalKeyId(P1)).toBe(projectKeyId(rotated));
    expect(keyring.isRetired(P1, projectKeyId(old))).toBe(true);
    expect(keyring.projectKey(P1, projectKeyId(old))).toEqual(old); // still reads history
    const recorded = trust.readKeyTrust(store);
    expect(recorded.minted.get(P1)).toBe(projectKeyId(rotated));
    expect(recorded.retired.has(`${P1}:${projectKeyId(old)}`)).toBe(true);

    // The server cannot roll the project back to the retired key.
    const rolledBack = u.keyring();
    await hydrateProjectKeys(
      fakeApi({
        keys: [own, next],
        canonical: { [P1]: projectKeyId(old) },
        retired: { [P1]: [projectKeyId(rotated)] },
      }),
      rolledBack,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(rolledBack.canonicalKeyId(P1)).toBe(projectKeyId(rotated));
    warn.mockRestore();
  });

  it("never makes a key it saw retired canonical again in a joined project", async () => {
    const warn = quiet();
    const u = me();
    const store = trustStore();
    trust.recordAcceptedProject(store, P1);
    const from = owner();
    const [old, rotated] = [generatePek(), generatePek()];
    const rows = [
      delivery(old, P1, u.pair.publicKey, from),
      delivery(rotated, P1, u.pair.publicKey, from),
    ];
    const keyring = u.keyring();
    await hydrateProjectKeys(
      fakeApi({
        keys: rows,
        canonical: { [P1]: projectKeyId(rotated) },
        retired: { [P1]: [projectKeyId(old)] },
      }),
      keyring,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(keyring.canonicalKeyId(P1)).toBe(projectKeyId(rotated));
    expect(trust.readKeyTrust(store).retired.has(`${P1}:${projectKeyId(old)}`)).toBe(true);

    const later = u.keyring();
    await hydrateProjectKeys(
      fakeApi({ keys: rows, canonical: { [P1]: projectKeyId(old) } }),
      later,
      { userId: ME, trust: trust.readKeyTrust(store), trustWriter: store },
    );
    expect(later.canonicalKeyId(P1)).toBeUndefined();
    expect(later.isRetired(P1, projectKeyId(old))).toBe(true);
    warn.mockRestore();
  });
});
