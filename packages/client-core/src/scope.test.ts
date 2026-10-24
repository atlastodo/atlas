import { describe, expect, it, vi } from "vitest";
import { ApiClient, type FetchLike, type WireOp } from "./api";
import {
  DEK_KEY_ID,
  Keyring,
  encryptField,
  isFieldEnvelopeV3,
  openSealedField,
  type FieldEnvelopeV3,
  encryptJson,
  generateDek,
  generatePek,
  isEncryptedEnvelope,
  projectKeyId,
  unwrapAttachmentKey,
  wrapAttachmentKey,
  wrapKey,
  type WrappedAttachmentKey,
} from "./crypto";
import { compareHlc, successorHlc, type Hlc } from "./hlc";
import { MemoryPersistence } from "./persistence";
import {
  applyRepairs,
  memberEntityId,
  resolveScope,
  rescopeTask,
  revokedProjectOps,
  reviveLockedValues,
} from "./scope";
import { LocalStore } from "./store";
import { SyncClient } from "./sync-client";
import type { EntityKind, Operation } from "./types";
import { encodeOp } from "./wire";

const ME = "0190a6f0-0000-7000-8000-0000000000e1";
const OTHER = "0190a6f0-0000-7000-8000-0000000000e2";
const DEVICE = "0190a6f0-0000-7000-8000-0000000000d1";
const REMOTE_NODE = "0190a6f0-0000-7000-8000-0000000000d2";
const P = "0190a6f0-0000-7000-8000-00000000a001";
const P2 = "0190a6f0-0000-7000-8000-00000000a002";
const T = "0190a6f0-0000-7000-8000-00000000b001";
const C = "0190a6f0-0000-7000-8000-00000000c001";
const A = "0190a6f0-0000-7000-8000-00000000d001";

let seq = 0;
const newId = () => `0190a6f0-0000-7000-8000-${(++seq).toString(16).padStart(12, "0")}`;

function ts(wallMs: number, counter = 0, node = REMOTE_NODE): Hlc {
  return { wallMs, counter, node };
}

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
  return {
    id: newId(),
    entity,
    entity_id: entityId,
    ts: { wall_ms: at.wallMs, counter: at.counter, node: at.node },
    op: "set",
    field,
    value,
  };
}

/** A version-1 value: no key id, no binding, as older clients wrote them. */
function enc(key: Uint8Array, value: unknown) {
  return { __enc: 1 as const, ...encryptJson(key, value) };
}

/** A current value of `entity.field` under project `projectId`'s key `key` (null: the DEK). */
function enc2(
  key: Uint8Array,
  projectId: string | null,
  entity: EntityKind,
  entityId: string,
  field: string,
  value: unknown,
) {
  const kid = projectId ? projectKeyId(key) : DEK_KEY_ID;
  const scope = projectId ? { kind: "project" as const, projectId } : { kind: "personal" as const };
  return encryptField(key, kid, scope, { entity, entityId, field }, value);
}

/** A pushed op's real field and value, opened as project `projectId`'s content (null: personal). */
function openPushedSealed(key: Uint8Array, projectId: string | null, op: WireOp) {
  const scope = projectId ? { kind: "project" as const, projectId } : { kind: "personal" as const };
  const at = { entity: op.entity, entityId: op.entity_id, field: op.op === "set" ? op.field : "" };
  return openSealedField(key, scope, at, valueOf(op) as FieldEnvelopeV3);
}

/** Open a pushed op's value as project `projectId`'s content (null: personal). */
function openPushed(key: Uint8Array, projectId: string | null, op: WireOp): unknown {
  return openPushedSealed(key, projectId, op).value;
}

/** The (last, with `last`) pushed set of `field`: the server sees only tags, so each is opened. */
function pushedSet(
  ops: WireOp[],
  key: Uint8Array,
  projectId: string | null,
  field: string,
  last = false,
): WireOp | undefined {
  const sets = ops.filter((o) => {
    if (o.op !== "set" || !isFieldEnvelopeV3(o.value)) return false;
    try {
      return openPushedSealed(key, projectId, o).field === field;
    } catch {
      return false;
    }
  });
  return last ? sets[sets.length - 1] : sets[0];
}

/** A protocol 7 wire op: `entity.field` sealed with project `projectId`'s key `key` (null: the DEK). */
function sealedWire(
  key: Uint8Array,
  projectId: string | null,
  entity: EntityKind,
  entityId: string,
  field: string,
  value: unknown,
  at: Hlc,
): WireOp {
  const keyId = projectId ? projectKeyId(key) : DEK_KEY_ID;
  const scope = projectId ? { kind: "project" as const, projectId } : { kind: "personal" as const };
  const op: Operation = { id: newId(), entity, entityId, ts: at, op: "set", field, value };
  return encodeOp(op, { key, keyId, scope });
}

/** A store in which `P` is shared: ME owns it, OTHER is an active editor. */
function sharedStore(opts: { persistence?: MemoryPersistence } = {}): LocalStore {
  const store = new LocalStore(DEVICE, { newId, now: () => 5_000, persistence: opts.persistence });
  const member = (id: string, user: string, role: string) => [
    remote("project_member", id, "project_id", P, ts(1)),
    remote("project_member", id, "user_id", user, ts(1)),
    remote("project_member", id, "role", role, ts(1)),
    remote("project_member", id, "state", "active", ts(1)),
  ];
  store.applyRemoteBatch([
    ...member("0190a6f0-0000-7000-8000-00000000f001", ME, "owner"),
    ...member("0190a6f0-0000-7000-8000-00000000f002", OTHER, "editor"),
    remote("project", P, "name", "Shared", ts(1)),
    remote("task", T, "project_id", P, ts(2)),
    remote("task", T, "title", "Shared task", ts(2)),
  ]);
  return store;
}

function keys(withPek = true) {
  const dek = generateDek();
  const pek = generatePek();
  const keyring = new Keyring({ dek });
  if (withPek) keyring.setProjectKey(P, pek);
  return { dek, pek, keyring };
}

/** A server double: records pushes, serves one pull payload, no snapshot endpoint. */
function server(pull: WireOp[] = []) {
  const pushes: WireOp[][] = [];
  let pending = pull;
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/sync/push") {
      const ops = JSON.parse(String(init?.body)).operations as WireOp[];
      pushes.push(ops);
      return Response.json({ cursor: 1, applied: ops.length });
    }
    if (path === "/sync/pull") {
      const body = { operations: pending, cursor: pending.length > 0 ? 7 : 7 };
      pending = [];
      return Response.json(body);
    }
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

function valueOf(op: WireOp): unknown {
  return op.op === "set" ? op.value : undefined;
}

describe("successorHlc", () => {
  it("is the smallest timestamp above its input", () => {
    const base = ts(10, 0, "00000000-0000-0000-0000-0000000000af");
    const next = successorHlc(base);
    expect(next).toEqual(ts(10, 0, "00000000-0000-0000-0000-0000000000b0"));
    expect(compareHlc(next, base)).toBeGreaterThan(0);
    // Beaten by any later edit: a higher counter, or a higher node at the same counter.
    expect(compareHlc(ts(10, 1, "00000000-0000-0000-0000-000000000000"), next)).toBeGreaterThan(0);
    expect(compareHlc(ts(10, 0, "00000000-0000-0000-0000-0000000000b1"), next)).toBeGreaterThan(0);
  });

  it("carries across the whole 128-bit node", () => {
    expect(successorHlc(ts(1, 2, "0190a6f0-0000-7000-8fff-ffffffffffff")).node).toBe(
      "0190a6f0-0000-7000-9000-000000000000",
    );
    expect(successorHlc(ts(1, 2, "0190A6F0-0000-7000-8000-00000000000F")).node).toBe(
      "0190a6f0-0000-7000-8000-000000000010",
    );
    // The largest uuid has no successor node: the next counter with the smallest node follows.
    expect(successorHlc(ts(1, 2, "ffffffff-ffff-ffff-ffff-ffffffffffff"))).toEqual(
      ts(1, 3, "00000000-0000-0000-0000-000000000000"),
    );
  });
});

describe("resolveScope", () => {
  it("follows task and comment links, batch first, then the store", () => {
    const store = sharedStore();
    store.applyRemote(remote("comment", C, "task_id", T, ts(3)));
    expect(resolveScope(store, "project", P)).toEqual({ kind: "project", projectId: P });
    expect(resolveScope(store, "task", T)).toEqual({ kind: "project", projectId: P });
    expect(resolveScope(store, "comment", C)).toEqual({ kind: "project", projectId: P });
    expect(resolveScope(store, "label", newId())).toEqual({ kind: "personal" });
    expect(resolveScope(store, "comment", newId())).toEqual({ kind: "unknown" });
    // A tombstoned task still names its project.
    store.applyRemote({ id: newId(), entity: "task", entityId: T, ts: ts(4), op: "delete" });
    expect(resolveScope(store, "comment", C)).toEqual({ kind: "project", projectId: P });
  });

  it("does not count a pending invite as sharing", () => {
    const store = new LocalStore(DEVICE, { newId });
    store.applyRemoteBatch([
      remote("project_member", newId(), "project_id", P2, ts(1)),
      remote("project_member", newId(), "state", "pending", ts(1)),
    ]);
    const { keyring } = keys(false);
    const api = client(server().fetch, keyring, store);
    // P2 is not shared here, so its task is encrypted with the DEK rather than deferred.
    return api
      .syncPush([
        {
          id: newId(),
          entity: "task",
          entityId: T,
          ts: ts(9, 0, DEVICE),
          op: "set",
          field: "project_id",
          value: P2,
        },
      ])
      .then((res) => expect(res.deferred).toEqual([]));
  });
});

describe("push key choice", () => {
  it("encrypts a shared task's title edit with the project key, with no project_id in the batch", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys();
    const srv = server();
    store.set("task", T, "title", "Renamed");
    await client(srv.fetch, keyring, store).syncPush(store.unsyncedOps());
    const title = pushedSet(srv.pushes[0]!, pek, P, "title")!;
    expect(openPushed(pek, P, title)).toBe("Renamed");
    expect(title.scope).toBe(P);
  });

  it("encrypts comments and attachments with the key of their task's project", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys();
    const srv = server();
    store.set("comment", C, "task_id", T);
    store.set("comment", C, "body", "Looks good");
    store.applyRemote(remote("attachment", A, "task_id", T, ts(3)));
    store.set("attachment", A, "blob_size", 42);
    await client(srv.fetch, keyring, store).syncPush(store.unsyncedOps());
    const sent = srv.pushes[0]!;
    const body = pushedSet(sent, pek, P, "body")!;
    const size = pushedSet(sent, pek, P, "blob_size")!;
    const link = pushedSet(sent, pek, P, "task_id")!;
    expect(openPushed(pek, P, body)).toBe("Looks good");
    expect(openPushed(pek, P, size)).toBe(42);
    // The link is sealed like any field: the server routes by the scope.
    expect(openPushed(pek, P, link)).toBe(T);
    expect(sent.every((o) => o.scope === P)).toBe(true);
  });

  it("defers every op of a shared project without its key, then pushes them once keys load", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys(false);
    const srv = server();
    const sync = new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 });
    store.set("task", T, "title", "Offline edit");
    const other = newId();
    store.set("task", other, "project_id", P);
    store.set("label", newId(), "name", "Personal label");

    await sync.sync();
    const first = srv.pushes.flat();
    expect(first).toHaveLength(1); // the label, under the account's own key
    expect(first[0]!.scope).toBeNull();
    expect(sync.deferredCount()).toBe(2);
    expect(store.unsyncedOps()).toHaveLength(2); // kept, never quarantined

    keyring.setProjectKey(P, pek);
    await sync.sync();
    const second = srv.pushes.flat().slice(first.length);
    expect(second).toHaveLength(2);
    // The link op waited too, so members never saw half of the new task.
    expect(pushedSet(second, pek, P, "project_id")).toBeDefined();
    const title = pushedSet(second, pek, P, "title")!;
    expect(openPushed(pek, P, title)).toBe("Offline edit");
    expect(store.unsyncedOps()).toHaveLength(0);
    expect(sync.deferredCount()).toBe(0);
  });
});

describe("pull repairs", () => {
  it("re-encrypts a value under a forked key of the same project with the canonical key", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys();
    const forked = generatePek();
    keyring.addProjectKey(P, projectKeyId(forked), forked);
    const at = ts(20);
    const srv = server([sealedWire(forked, P, "task", T, "notes", "Forked note", at)]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(store.get("task", T)!.notes).toBe("Forked note");
    expect(store.fieldTs("task", T, "notes")).toEqual(successorHlc(at));
    const repaired = pushedSet(srv.pushes.flat(), pek, P, "notes")!;
    expect(repaired.ts).toEqual({ wall_ms: 20, counter: 0, node: successorHlc(at).node });
    expect(openPushed(pek, P, repaired)).toBe("Forked note");
  });

  it("leaves a value under a key a rotation retired where it is", async () => {
    const store = sharedStore();
    const { keyring } = keys();
    const old = generatePek();
    keyring.addProjectKey(P, projectKeyId(old), old);
    keyring.setRetiredKeys(P, [projectKeyId(old)]);
    const srv = server([sealedWire(old, P, "task", T, "notes", "Before the rotation", ts(20))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(store.get("task", T)!.notes).toBe("Before the rotation");
    expect(store.fieldTs("task", T, "notes")).toEqual(ts(20));
    expect(srv.pushes.flat()).toEqual([]);
  });

  it("does not read or move a DEK value found in a shared project", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = sharedStore();
    const { dek, keyring } = keys();
    const srv = server([wire("task", T, "notes", enc(dek, "Written with the DEK"), ts(20))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(isEncryptedEnvelope(store.get("task", T)!.notes)).toBe(true);
    expect(srv.pushes).toHaveLength(0);
    warn.mockRestore();
  });

  it("reads a protocol 6 version-1 value and leaves it to the migration, never a repair", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys();
    const at = ts(22);
    const srv = server([wire("task", T, "title", enc(pek, "Old format"), at)]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(store.get("task", T)!.title).toBe("Old format");
    expect(store.fieldTs("task", T, "title")).toEqual(at); // a repair would have moved it
    expect(srv.pushes).toHaveLength(0);
  });

  it("reads protocol 6 plaintext before the legacy migration, without pushing it again", async () => {
    const store = sharedStore();
    const { keyring } = keys();
    const at = ts(21);
    const srv = server([
      wire("task", T, "title", "Leaked title", at),
      wire("task", T, "project_id", P, ts(21, 1)),
    ]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();

    expect(store.get("task", T)!.title).toBe("Leaked title");
    expect(srv.pushes).toHaveLength(0);
  });

  it("leaves correctly keyed values alone", async () => {
    const store = sharedStore();
    const { pek, keyring } = keys();
    const srv = server([
      wire("task", T, "title", enc2(pek, P, "task", T, "title", "Fine"), ts(22)),
      sealedWire(pek, P, "task", T, "notes", "Also fine", ts(23)),
    ]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();
    expect(store.get("task", T)!.title).toBe("Fine");
    expect(store.get("task", T)!.notes).toBe("Also fine");
    expect(srv.pushes).toHaveLength(0);
  });

  it("keeps a sealed value no key opens under its wire kind, and opens it once the key arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = sharedStore();
    const { pek, keyring } = keys(false);
    const srv = server([sealedWire(pek, P, "task", T, "notes", "Sealed", ts(24))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();
    expect(store.get("task", T)!.notes).toBeUndefined();
    expect(store.lockedCount()).toBe(1);

    keyring.setProjectKey(P, pek);
    expect(reviveLockedValues(store, keyring, ME).revived).toBe(1);
    expect(store.get("task", T)!.notes).toBe("Sealed");
    expect(store.fieldTs("task", T, "notes")).toEqual(ts(24));
    expect(store.lockedCount()).toBe(0);
    expect(store.unsyncedOps()).toHaveLength(0);
    warn.mockRestore();
  });

  it("keeps a value no key opens as an envelope", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = sharedStore();
    const { keyring } = keys();
    const srv = server([wire("task", T, "title", enc(generatePek(), "Unknown key"), ts(23))]);
    await new SyncClient(store, client(srv.fetch, keyring, store), { cursor: 7 }).sync();
    expect(isEncryptedEnvelope(store.get("task", T)!.title)).toBe(true);
    expect(store.lockedCount()).toBe(1);
    expect(srv.pushes).toHaveLength(0);
    warn.mockRestore();
  });

  it("skips a repair once the field has moved on locally", () => {
    const store = sharedStore();
    const at = store.fieldTs("task", T, "title")!;
    store.set("task", T, "title", "Newer local edit");
    const applied = applyRepairs(store, [
      { entity: "task", entityId: T, field: "title", ts: at, value: "Shared task", reason: "key" },
    ]);
    expect(applied).toBe(0);
    expect(store.get("task", T)!.title).toBe("Newer local edit");
  });

  it("decrypts a snapshot that delivers comments before their tasks", async () => {
    const { pek, keyring } = keys();
    const store = new LocalStore(DEVICE, { newId });
    const pages: Record<string, unknown> = {
      "": {
        operations: [
          wire("comment", C, "task_id", T, ts(30)),
          wire("comment", C, "body", enc2(pek, P, "comment", C, "body", "First!"), ts(30, 1)),
        ],
        cursor: 9,
        next: "project_member/x",
      },
      "project_member/x": {
        operations: [
          wire("project_member", newId(), "project_id", P, ts(1)),
          wire("project_member", newId(), "state", "active", ts(1)),
          wire("task", T, "project_id", P, ts(2)),
          wire("task", T, "title", enc2(pek, P, "task", T, "title", "Shared task"), ts(2, 1)),
        ],
        cursor: 9,
      },
    };
    const pushes: unknown[] = [];
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/sync/snapshot") {
        const token = u.searchParams.get("next") ?? "";
        return Response.json(pages[token]);
      }
      if (u.pathname === "/sync/pull") return Response.json({ operations: [], cursor: 9 });
      pushes.push(init?.body);
      return Response.json({ cursor: 9, applied: 0 });
    };
    await new SyncClient(store, client(fetch, keyring, store)).sync();
    expect(store.get("comment", C)!.body).toBe("First!");
    expect(store.get("task", T)!.title).toBe("Shared task");
    expect(pushes).toHaveLength(0); // nothing was misjudged as wrongly keyed
  });
});

describe("locked values", () => {
  it("revives an envelope once its key arrives, and the readable value survives a reload", async () => {
    const persistence = new MemoryPersistence();
    const store = sharedStore({ persistence });
    const { pek, keyring } = keys(false);
    const envelope = enc2(pek, P, "task", T, "notes", "Secret");
    store.applyRemote(remote("task", T, "notes", envelope, ts(40)));
    expect(store.lockedCount()).toBe(1);

    keyring.setProjectKey(P, pek);
    const result = reviveLockedValues(store, keyring, ME);
    expect(result.revived).toBe(1);
    expect(store.get("task", T)!.notes).toBe("Secret");
    expect(store.fieldTs("task", T, "notes")).toEqual(ts(40)); // same timestamp: nothing to push
    expect(store.unsyncedOps()).toHaveLength(0);
    await store.flush();

    const reloaded = new LocalStore(DEVICE, { newId, persistence });
    await reloaded.hydrate();
    expect(reloaded.get("task", T)!.notes).toBe("Secret");
    // The envelope re-delivered at the same timestamp does not lock it again.
    reloaded.applyRemote(remote("task", T, "notes", envelope, ts(40)));
    expect(reloaded.get("task", T)!.notes).toBe("Secret");
  });

  it("repairs a revived value that was opened with a non-canonical key of its project", () => {
    const store = sharedStore();
    const { keyring } = keys();
    const forked = generatePek();
    store.applyRemote(
      remote("task", T, "notes", enc2(forked, P, "task", T, "notes", "Forked"), ts(41)),
    );
    keyring.addProjectKey(P, projectKeyId(forked), forked);
    const result = reviveLockedValues(store, keyring, ME);
    expect(result.revived).toBe(1);
    expect(result.repaired).toBe(1);
    expect(store.fieldTs("task", T, "notes")).toEqual(successorHlc(ts(41)));
  });

  it("does not revive a personal value found in a shared project", () => {
    const store = sharedStore();
    const { dek, keyring } = keys();
    store.applyRemote(remote("task", T, "notes", enc(dek, "Planted"), ts(41)));
    const result = reviveLockedValues(store, keyring, ME);
    expect(result).toEqual({ revived: 0, repaired: 0 });
  });

  it("moves an old personal value of a project only the user belongs to under its key", () => {
    const store = new LocalStore(DEVICE, { newId, now: () => 5_000 });
    const { dek, keyring } = keys();
    store.applyRemoteBatch([
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "project_id", P, ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "user_id", ME, ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "role", "owner", ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "state", "active", ts(1)),
      remote("project", P, "name", enc(dek, "Old project"), ts(2)),
      remote("task", T, "project_id", P, ts(2)),
      remote("task", T, "title", enc(dek, "Old title"), ts(3)),
    ]);
    expect(store.lockedCount()).toBe(2);

    const result = reviveLockedValues(store, keyring, ME);

    expect(result).toEqual({ revived: 2, repaired: 2 });
    expect(store.lockedCount()).toBe(0);
    expect(store.get("project", P)!.name).toBe("Old project");
    expect(store.get("task", T)!.title).toBe("Old title");
    // Rewritten under the project's key, at the successor timestamp, to be pushed.
    expect(store.fieldTs("task", T, "title")).toEqual(successorHlc(ts(3)));
    const pushed = store.unsyncedOps().map((op) => (op.op === "set" ? op.field : op.op));
    expect(pushed.sort()).toEqual(["name", "title"]);
  });

  it("never repairs a field its entity's delete hides, so a repair cannot outlive the delete", () => {
    const store = new LocalStore(DEVICE, { newId, now: () => 5_000 });
    const { dek, keyring } = keys();
    const S = "0190a6f0-0000-7000-8000-00000000e001";
    const deleted: Operation = {
      id: newId(),
      entity: "section",
      entityId: S,
      ts: ts(4),
      op: "delete",
    };
    store.applyRemoteBatch([
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "project_id", P, ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "user_id", ME, ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "role", "owner", ts(1)),
      remote("project_member", "0190a6f0-0000-7000-8000-00000000f001", "state", "active", ts(1)),
      remote("section", S, "project_id", P, ts(2)),
      remote("section", S, "name", enc(dek, "Old section"), ts(3)),
      deleted,
    ]);
    expect(store.lockedCount()).toBe(0);

    const result = reviveLockedValues(store, keyring, ME);

    expect(result.repaired).toBe(0);
    expect(store.unsyncedOps()).toHaveLength(0);
    expect(store.get("section", S)).toBeNull();
    expect(store.lockedCount()).toBe(0);
  });
});

describe("rescopeTask", () => {
  it("re-writes every field of the task and its children under the new project's key", async () => {
    const store = sharedStore();
    const { dek, pek, keyring } = keys();
    const personal = newId();
    const aek = generatePek();
    store.applyRemoteBatch([
      remote("task", personal, "title", "Private", ts(50)),
      remote("task", personal, "notes", "Details", ts(50, 1)),
      remote("comment", C, "task_id", personal, ts(51)),
      remote("comment", C, "body", "Note to self", ts(51, 1)),
      remote("attachment", A, "task_id", personal, ts(52)),
      remote("attachment", A, "wrapped_key", wrapKey(aek, dek), ts(52, 1)),
    ]);
    store.set("task", personal, "project_id", P);
    const moved = store.fieldTs("task", personal, "project_id")!;

    const written = rescopeTask(store, keyring, personal);
    expect(written).toBeGreaterThanOrEqual(6);
    expect(store.fieldTs("task", personal, "title")).toEqual(successorHlc(ts(50)));
    expect(store.fieldTs("task", personal, "project_id")).toEqual(successorHlc(moved));
    expect(store.fieldTs("comment", C, "body")).toEqual(successorHlc(ts(51, 1)));
    // An older client's unbound key comes out bound to the attachment and its new scope.
    const wrapped = store.get("attachment", A)!.wrapped_key as WrappedAttachmentKey;
    expect(wrapped).toMatchObject({ v: 2, kid: projectKeyId(pek) });
    expect(unwrapAttachmentKey(wrapped, pek, { kind: "project", projectId: P }, A)).toEqual(aek);

    const srv = server();
    await client(srv.fetch, keyring, store).syncPush(store.unsyncedOps());
    const sent = srv.pushes[0]!;
    for (const field of ["title", "notes", "body"]) {
      const op = pushedSet(sent, pek, P, field, true)!;
      expect(isEncryptedEnvelope(valueOf(op))).toBe(true);
      expect(op.scope).toBe(P);
    }
    expect(projectKeyId(pek)).toBe(keyring.canonicalKeyId(P));
  });

  it("does not re-wrap a key the server copied in from another attachment", () => {
    const store = sharedStore();
    const { dek, keyring } = keys();
    const personal = newId();
    const aek = generatePek();
    const copied = wrapAttachmentKey(aek, dek, DEK_KEY_ID, { kind: "personal" }, newId());
    store.applyRemoteBatch([
      remote("task", personal, "title", "Private", ts(50)),
      remote("attachment", A, "task_id", personal, ts(52)),
      remote("attachment", A, "wrapped_key", copied, ts(52, 1)),
    ]);
    store.set("task", personal, "project_id", P);

    rescopeTask(store, keyring, personal);
    expect(store.get("attachment", A)!.wrapped_key).toEqual(copied);
  });
});

describe("memberEntityId", () => {
  it("derives the server's membership id (a UUID v5 of project:user)", () => {
    expect(memberEntityId(P, ME)).toBe("fbb639c9-672a-5c86-a652-74dee814331f");
  });
});

describe("revokedProjectOps", () => {
  const PERSONAL_P = "0190a6f0-0000-7000-8000-00000000a009";
  const T2 = "0190a6f0-0000-7000-8000-00000000b002";
  const T3 = "0190a6f0-0000-7000-8000-00000000b003";

  function del(entity: EntityKind, entityId: string, at: Hlc): Operation {
    return { id: newId(), entity, entityId, ts: at, op: "delete" };
  }

  it("finds the queued ops of a project the user left, and nothing else", () => {
    const store = sharedStore();
    // Queued edits: one in the shared project, one in a personal project deleted since.
    store.set("task", T, "title", "held back");
    store.applyRemoteBatch([
      remote("project", PERSONAL_P, "name", "Mine", ts(3)),
      remote("task", T2, "project_id", PERSONAL_P, ts(3)),
    ]);
    store.set("task", T2, "title", "kept");
    store.remove("project", PERSONAL_P);
    expect(revokedProjectOps(store, ME)).toEqual([]);

    // The leave: the server tombstones the project and the user's own membership.
    store.applyRemoteBatch([
      del("project", P, ts(10_000)),
      del("project_member", memberEntityId(P, ME), ts(10_000)),
    ]);

    const revoked = revokedProjectOps(store, ME);
    expect(revoked.map((op) => op.entityId)).toEqual([T]);
    expect(revokedProjectOps(store, OTHER)).toEqual([]);
  });

  it("keeps a project whose owner deleted it while the user is still a member", () => {
    const store = sharedStore();
    store.applyRemoteBatch([remote("task", T3, "project_id", P, ts(3))]);
    store.set("task", T3, "title", "still mine to send");
    store.applyRemote(del("project", P, ts(10_000)));
    expect(revokedProjectOps(store, ME)).toEqual([]);
  });
});
