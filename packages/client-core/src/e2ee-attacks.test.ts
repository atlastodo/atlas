/**
 * Attacks a malicious server can mount against field encryption and key distribution. Each test
 * plays the server: it serves crafted sync payloads or key rows and checks what the client reads
 * and what it sends back.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, type FetchLike, type WireOp } from "./api";
import { generateAek, unwrapAek, unwrapAekAny, wrapAek } from "./attachments";
import {
  Keyring,
  encryptJson,
  generateDek,
  generatePek,
  generateUserKeypair,
  projectKeyId,
  sealKey,
  wrapKey,
} from "./crypto";
import type { Hlc } from "./hlc";
import { hydrateProjectKeys } from "./projectKeys";
import { keyForScope, rescopeEntity, type ScopeKey } from "./scope";
import { LocalStore } from "./store";
import { SyncClient } from "./sync-client";
import * as trust from "./trust";
import type { EntityKind, Operation, ProjectKeysResponse } from "./types";

const ME = "0190a6f0-0000-7000-8000-0000000000e1";
const MALLORY = "0190a6f0-0000-7000-8000-0000000000e3";
const DEVICE = "0190a6f0-0000-7000-8000-0000000000d1";
const REMOTE_NODE = "0190a6f0-0000-7000-8000-0000000000d2";
/** A project shared with Mallory, who colludes with the server: the server knows its key. */
const Y = "0190a6f0-0000-7000-8000-00000000a001";
/** A project the user created and never shared. */
const MINE = "0190a6f0-0000-7000-8000-00000000a002";
const PRIVATE_TASK = "0190a6f0-0000-7000-8000-00000000b001";
const SHARED_TASK = "0190a6f0-0000-7000-8000-00000000b002";
const OTHER_PRIVATE_TASK = "0190a6f0-0000-7000-8000-00000000b003";

let seq = 0;
const newId = () => `0190a6f0-0000-7000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const ts = (wallMs: number, node = REMOTE_NODE): Hlc => ({ wallMs, counter: 0, node });

function remote(
  entity: EntityKind,
  entityId: string,
  field: string,
  value: unknown,
  at: Hlc,
): Operation {
  return { id: newId(), entity, entityId, ts: at, op: "set", field, value };
}

function wire(
  entity: EntityKind,
  entityId: string,
  field: string,
  value: unknown,
  at: Hlc,
): WireOp {
  const t = { wall_ms: at.wallMs, counter: at.counter, node: at.node };
  return { id: newId(), entity, entity_id: entityId, ts: t, op: "set", field, value };
}

/** ME's store: Y is shared with Mallory, PRIVATE_TASK and OTHER_PRIVATE_TASK are personal. */
function victimStore(): LocalStore {
  const store = new LocalStore(DEVICE, { newId, now: () => 5_000 });
  const member = (id: string, user: string, role: string) => [
    remote("project_member", id, "project_id", Y, ts(1)),
    remote("project_member", id, "user_id", user, ts(1)),
    remote("project_member", id, "role", role, ts(1)),
    remote("project_member", id, "state", "active", ts(1)),
  ];
  store.applyRemoteBatch([
    ...member(newId(), MALLORY, "owner"),
    ...member(newId(), ME, "editor"),
    remote("task", SHARED_TASK, "project_id", Y, ts(2)),
    remote("task", PRIVATE_TASK, "title", "My diagnosis", ts(2)),
    remote("task", OTHER_PRIVATE_TASK, "title", "Groceries", ts(2)),
  ]);
  return store;
}

/** The server: records pushes and serves each queued pull payload once. */
function server(...pulls: WireOp[][]) {
  const pushes: WireOp[] = [];
  const queue = [...pulls];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/sync/push") {
      const ops = JSON.parse(String(init?.body)).operations as WireOp[];
      pushes.push(...ops);
      return Response.json({ cursor: 1, applied: ops.length });
    }
    if (path === "/sync/pull") return Response.json({ operations: queue.shift() ?? [], cursor: 7 });
    return new Response("not found", { status: 404 });
  };
  return { pushes, fetch };
}

function client(fetch: FetchLike, keyring: Keyring, store: LocalStore): ApiClient {
  const api = new ApiClient({ baseUrl: "https://api.example.com", token: "t", fetch });
  api.setKeyring(keyring);
  api.setScopeContext(store, ME);
  return api;
}

/** ME's keys: the DEK, and Y's key, which Mallory (and so the server) also holds. */
function victimKeys() {
  const dek = generateDek();
  const pekY = generatePek();
  const keyring = new Keyring({ dek });
  keyring.setProjectKey(Y, pekY);
  return { dek, pekY, keyring };
}

/** What the victim's client itself sends for `title` of a personal task: real ciphertext. */
async function ownCiphertext(keyring: Keyring, store: LocalStore, value: string): Promise<unknown> {
  const srv = server();
  const op: Operation = {
    id: newId(),
    entity: "task",
    entityId: PRIVATE_TASK,
    ts: ts(3, DEVICE),
    op: "set",
    field: "title",
    value,
  };
  await client(srv.fetch, keyring, store).syncPush([op]);
  return (srv.pushes[0] as { value: unknown }).value;
}

describe("decryption oracle through key repair", () => {
  it("never re-sends a personal ciphertext planted in a shared project under the project key", async () => {
    const store = victimStore();
    const { dek, keyring } = victimKeys();
    // A version-1 value under the DEK, as clients wrote them before bound envelopes.
    const stolen = { __enc: 1, ...encryptJson(dek, "My diagnosis") };
    const srv = server([wire("task", SHARED_TASK, "zz", stolen, ts(20))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(srv.pushes.filter((o) => o.entity_id === SHARED_TASK)).toEqual([]);
    expect(store.unsyncedOps()).toEqual([]);
  });

  it("never re-sends a current ciphertext planted in a shared project", async () => {
    const store = victimStore();
    const { keyring } = victimKeys();
    const stolen = await ownCiphertext(keyring, store, "My diagnosis");
    const srv = server([wire("task", SHARED_TASK, "title", stolen, ts(20))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(srv.pushes).toEqual([]);
    expect(store.get("task", SHARED_TASK)?.title).not.toBe("My diagnosis");
  });

  it("does not read a ciphertext copied to another entity or field", async () => {
    const store = victimStore();
    const { keyring } = victimKeys();
    const stolen = await ownCiphertext(keyring, store, "My diagnosis");
    const srv = server([
      wire("task", OTHER_PRIVATE_TASK, "title", stolen, ts(20)),
      wire("task", PRIVATE_TASK, "notes", stolen, ts(20)),
    ]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(store.get("task", OTHER_PRIVATE_TASK)?.title).not.toBe("My diagnosis");
    expect(store.get("task", PRIVATE_TASK)?.notes).not.toBe("My diagnosis");
    expect(srv.pushes).toEqual([]);
  });

  it("does not open a project ciphertext moved to another project with the same key", async () => {
    // Even a key the server managed to register for two projects cannot carry values across.
    const store = victimStore();
    const { pekY, keyring } = victimKeys();
    keyring.addProjectKey(MINE, projectKeyId(pekY), pekY);
    const srv = server();
    const op: Operation = {
      id: newId(),
      entity: "task",
      entityId: SHARED_TASK,
      ts: ts(3, DEVICE),
      op: "set",
      field: "title",
      value: "Team plan",
    };
    await client(srv.fetch, keyring, store).syncPush([op]);
    const moved = (srv.pushes[0] as { value: unknown }).value;

    const decoded = client(server().fetch, keyring, store).decodeWirePayload({
      operations: [
        wire("task", SHARED_TASK, "project_id", MINE, ts(30)),
        wire("task", SHARED_TASK, "title", moved, ts(30)),
      ],
      cursor: 1,
    });
    const title = decoded.operations.find((o) => o.op === "set" && o.field === "title");
    expect(title && title.op === "set" ? title.value : undefined).not.toBe("Team plan");
  });
});

describe("attachment keys", () => {
  it("never re-wraps a file key the server copied onto another attachment for a shared project", () => {
    // The victim's private attachment: its file key is wrapped under the DEK, for that attachment.
    const store = victimStore();
    const { pekY, keyring } = victimKeys();
    const privateAttachment = newId();
    const aek = generateAek();
    const personal = keyForScope(keyring, { kind: "personal" }, new Set());
    const wrapped = wrapAek(aek, personal, privateAttachment);
    // The server plants a second attachment on another personal task, carrying the same wrapped
    // key; moving that task into Y would otherwise re-wrap the key for Mallory.
    const planted = newId();
    store.applyRemoteBatch([
      remote("attachment", privateAttachment, "task_id", PRIVATE_TASK, ts(10)),
      remote("attachment", privateAttachment, "wrapped_key", wrapped, ts(10)),
      remote("attachment", planted, "task_id", OTHER_PRIVATE_TASK, ts(11)),
      remote("attachment", planted, "wrapped_key", wrapped, ts(11)),
    ]);
    expect(() => unwrapAekAny(wrapped, keyring, planted)).toThrow();

    store.set("task", OTHER_PRIVATE_TASK, "project_id", Y);
    rescopeEntity(store, keyring, "task", OTHER_PRIVATE_TASK, null);
    expect(store.get("attachment", planted)!.wrapped_key).toEqual(wrapped);
    const asY: ScopeKey = {
      key: pekY,
      keyId: projectKeyId(pekY),
      scope: { kind: "project", projectId: Y },
    };
    expect(() => unwrapAek(wrapped, asY, planted)).toThrow();
  });
});

describe("value length", () => {
  it("does not reveal booleans, dates or short titles through the ciphertext length", async () => {
    const store = victimStore();
    const { keyring } = victimKeys();
    const srv = server();
    const values: [string, unknown][] = [
      ["is_completed", true],
      ["is_completed", false],
      ["completed_at", null],
      ["completed_at", 1_767_225_600_000],
      ["title", "Tax"],
      ["title", "Book the dentist"],
    ];
    await client(srv.fetch, keyring, store).syncPush(
      values.map(([field, value]) => ({
        id: newId(),
        entity: "task",
        entityId: PRIVATE_TASK,
        ts: ts(3, DEVICE),
        op: "set",
        field,
        value,
      })),
    );
    const lengths = new Set(
      srv.pushes.map((o) => (o as { value: { ct: string } }).value.ct.length),
    );
    expect(lengths.size).toBe(1);
  });
});

describe("plaintext in an encrypted field", () => {
  it("is dropped, not read or re-sent, once the legacy migration is done", async () => {
    const store = victimStore();
    const { keyring } = victimKeys();
    trust.recordLegacyMigrated(store);
    for (const op of store.unsyncedOps()) store.markSynced([op.id]);
    const srv = server([
      wire("task", PRIVATE_TASK, "notes", "Reset your password at http://evil", ts(20)),
    ]);
    const api = client(srv.fetch, keyring, store);
    await new SyncClient(store, api, { cursor: 7 }).sync();

    expect(store.get("task", PRIVATE_TASK)?.notes).toBeUndefined();
    expect(srv.pushes.filter((o) => o.entity_id === PRIVATE_TASK)).toEqual([]);
  });
});

describe("planted project keys", () => {
  function rows(...keys: ProjectKeysResponse["keys"]): ProjectKeysResponse {
    return { keys, canonical: {} };
  }

  it("ignores a key sealed to the user for a project whose invite they never accepted", async () => {
    const { publicKey, secretKey: privateKey } = generateUserKeypair();
    const keyring = new Keyring({ dek: generateDek(), publicKey, privateKey });
    const planted = generatePek();
    const plantedId = projectKeyId(planted);
    const store = new LocalStore(DEVICE, { newId });
    store.applyRemote(remote("project", MINE, "name", "Private", ts(1)));
    trust.recordKeyTrustBaseline(store, keyring, ME);
    const response = rows({
      project_id: MINE,
      key_id: plantedId,
      kind: "sealed",
      encrypted_pek: sealKey(planted, publicKey),
    });
    response.canonical = { [MINE]: plantedId };
    await hydrateProjectKeys(
      { listProjectKeys: async () => response, putProjectKey: async () => {} },
      keyring,
      { isCreator: () => true, trust: trust.readKeyTrust(store) },
    );

    expect(keyring.getProjectKey(MINE)).toBeUndefined();
    expect(keyring.projectKeys(MINE)).toEqual([]);
  });

  it("keeps the key the user minted as canonical when the server names another", async () => {
    const { publicKey, secretKey: privateKey } = generateUserKeypair();
    const dek = generateDek();
    const keyring = new Keyring({ dek, publicKey, privateKey });
    const mine = generatePek();
    const planted = generatePek();
    const store = new LocalStore(DEVICE, { newId });
    trust.recordMintedKey(store, MINE, projectKeyId(mine));
    const response: ProjectKeysResponse = {
      keys: [
        {
          project_id: MINE,
          key_id: projectKeyId(mine),
          kind: "wrapped",
          encrypted_pek: wrapKey(mine, dek),
        },
        {
          project_id: MINE,
          key_id: projectKeyId(planted),
          kind: "sealed",
          encrypted_pek: sealKey(planted, publicKey),
        },
      ],
      canonical: { [MINE]: projectKeyId(planted) },
    };
    await hydrateProjectKeys(
      { listProjectKeys: async () => response, putProjectKey: async () => {} },
      keyring,
      { isCreator: () => true, trust: trust.readKeyTrust(store) },
    );

    expect(keyring.canonicalKeyId(MINE)).toBe(projectKeyId(mine));
    expect(keyring.projectKeys(MINE).map((k) => k.keyId)).toEqual([projectKeyId(mine)]);
  });
});
