import { describe, expect, test, vi } from "vitest";
import { ApiClient, E2eeLockedError, toEncryptedWire, type FetchLike } from "./api";
import { Keyring, generateDek, generatePek } from "./crypto";
import type { Operation } from "./types";

/** A wire op as the fake server received or serves it. */
type SentOp = { entity?: string; scope?: string | null; field?: string; value?: unknown };
type Envelope = { __enc: number; iv: string; ct: string };

/** The pulled `set` op of `field`, if any. */
function setOf(ops: Operation[], field: string): Extract<Operation, { op: "set" }> | undefined {
  return ops.find(
    (o): o is Extract<Operation, { op: "set" }> => o.op === "set" && o.field === field,
  );
}

describe("ApiClient Sync Encryption", () => {
  test("syncPush encrypts sensitive field values when Keyring is present", async () => {
    let sentBody = null as { operations: SentOp[] } | null;
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async (_url, init) => {
        sentBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify({ cursor: 10, applied: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const keyring = new Keyring({ dek: generateDek() });
    client.setKeyring(keyring);

    const ops: Operation[] = [
      {
        id: "op-1",
        entity: "task",
        entityId: "task-1",
        ts: { wallMs: 1000, counter: 0, node: "node-1" },
        op: "set",
        field: "title",
        value: "Secret meeting with client",
      },
      {
        id: "op-2",
        entity: "task",
        entityId: "task-1",
        ts: { wallMs: 1000, counter: 1, node: "node-1" },
        op: "set",
        field: "project_id",
        value: "proj-123",
      },
    ];

    await client.syncPush(ops);

    expect(sentBody).toBeDefined();
    expect(sentBody!.operations.length).toBe(2);

    // Neither the kind, the field names nor the link reach the server.
    const [title, projOp] = sentBody!.operations;
    for (const op of [title!, projOp!]) {
      expect(op.entity).toBe("todo.sealed");
      expect(op.scope).toBeNull(); // no key was made for proj-123: the account's own key
      expect(op.field).toMatch(/^[0-9a-f]{32}$/);
      expect((op.value as Envelope).__enc).toBe(3);
    }
    expect(title!.field).not.toBe(projOp!.field);
    expect(JSON.stringify(sentBody)).not.toMatch(/title|project_id|proj-123|Secret meeting/);
  });

  test("syncPull decrypts sensitive field values when Keyring is present", async () => {
    const dek = generateDek();
    const clientA = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async () => new Response("{}", { status: 200 }),
    });
    clientA.setKeyring(new Keyring({ dek }));

    let capturedWireOp: SentOp | null = null;
    const clientCapture = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        capturedWireOp = body.operations[0];
        return new Response(JSON.stringify({ cursor: 1, applied: 1 }), { status: 200 });
      },
    });
    clientCapture.setKeyring(new Keyring({ dek }));

    await clientCapture.syncPush([
      {
        id: "op-secret",
        entity: "task",
        entityId: "task-99",
        ts: { wallMs: 2000, counter: 0, node: "node-A" },
        op: "set",
        field: "notes",
        value: "Top secret project notes",
      },
    ]);

    // Client B pulls the wire op and decrypts it with the matching DEK
    const clientB = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response(JSON.stringify({ operations: [capturedWireOp], cursor: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    clientB.setKeyring(new Keyring({ dek }));

    const pullResult = await clientB.syncPull(0);
    expect(pullResult.operations.length).toBe(1);
    const pulledOp = pullResult.operations[0]!;
    expect(pulledOp.op).toBe("set");
    if (pulledOp.op === "set") {
      expect(pulledOp.field).toBe("notes");
      expect(pulledOp.value).toBe("Top secret project notes");
    }
  });

  test("project tasks are encrypted with PEK when project is registered in Keyring", async () => {
    const userDek = generateDek();
    const projPek = generatePek();
    const projectId = "proj-secret-collab";

    const keyring = new Keyring({ dek: userDek });
    keyring.setProjectKey(projectId, projPek);

    let sentWireOps: SentOp[] = [];
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        sentWireOps = body.operations;
        return new Response(JSON.stringify({ cursor: 1, applied: 1 }), { status: 200 });
      },
    });
    client.setKeyring(keyring);

    await client.syncPush([
      {
        id: "op-link",
        entity: "task",
        entityId: "task-collab",
        ts: { wallMs: 1000, counter: 0, node: "node-1" },
        op: "set",
        field: "project_id",
        value: projectId,
      },
      {
        id: "op-title",
        entity: "task",
        entityId: "task-collab",
        ts: { wallMs: 1000, counter: 1, node: "node-1" },
        op: "set",
        field: "title",
        value: "Shared collaborative task",
      },
    ]);

    const titleWireOp = sentWireOps[1]!;
    expect((titleWireOp.value as Envelope).__enc).toBe(3);
    expect(titleWireOp.scope).toBe(projectId);

    // Client with only userDek (wrong key) cannot decrypt the project task
    const clientWrongKey = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response(JSON.stringify({ operations: sentWireOps, cursor: 1 }), { status: 200 }),
    });
    clientWrongKey.setKeyring(new Keyring({ dek: userDek })); // missing project key!

    // When unable to decrypt, the value stays sealed under its wire kind and tag, with a warning.
    const pullWrong = await clientWrongKey.syncPull(0);
    expect(setOf(pullWrong.operations, "title")).toBeUndefined();
    const sealed = setOf(pullWrong.operations, titleWireOp.field!);
    expect(sealed!.entity).toBe("todo.sealed");
    expect((sealed!.value as Envelope).__enc).toBe(3);

    // Client with the project PEK decrypts successfully!
    const clientWithPek = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: async () =>
        new Response(JSON.stringify({ operations: sentWireOps, cursor: 1 }), { status: 200 }),
    });
    const keyringWithPek = new Keyring({ dek: generateDek() });
    keyringWithPek.setProjectKey(projectId, projPek);
    clientWithPek.setKeyring(keyringWithPek);

    const pullRight = await clientWithPek.syncPull(0);
    const pulledTitleRight = setOf(pullRight.operations, "title");
    expect(pulledTitleRight!.value).toBe("Shared collaborative task");
  });
});

describe("ApiClient sync fails closed without an unlocked keyring", () => {
  const titleOp: Operation = {
    id: "op-title",
    entity: "task",
    entityId: "task-1",
    ts: { wallMs: 1000, counter: 0, node: "node-1" },
    op: "set",
    field: "title",
    value: "Secret meeting with client",
  };

  test("push, pull and snapshot refuse before sending anything", async () => {
    // Every account is E2EE, so a session restored without its keys must not sync at all.
    const fetchMock = vi.fn<FetchLike>(
      async () => new Response(JSON.stringify({ cursor: 1, applied: 1, operations: [] })),
    );
    const client = new ApiClient({
      baseUrl: "https://api.example.com",
      token: "t",
      fetch: fetchMock,
    });

    await expect(client.syncPush([titleOp])).rejects.toBeInstanceOf(E2eeLockedError);
    await expect(client.syncPull(0)).rejects.toBeInstanceOf(E2eeLockedError);
    await expect(client.syncSnapshot()).rejects.toBeInstanceOf(E2eeLockedError);

    // A keyring whose keys were wiped (sign-out) is just as locked.
    const wiped = new Keyring({ dek: generateDek() });
    wiped.clear();
    client.setKeyring(wiped);
    await expect(client.syncPush([titleOp])).rejects.toBeInstanceOf(E2eeLockedError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the realtime decode path refuses too, so a socket cannot slip ciphertext in", () => {
    const client = new ApiClient({ baseUrl: "https://api.example.com", token: "t" });
    expect(() => client.decodeWirePayload({ operations: [], cursor: 1 })).toThrow(E2eeLockedError);
  });

  test("toEncryptedWire never converts without keys", () => {
    // Every field is tagged and sealed with its scope's key, links and tombstones included.
    expect(() => toEncryptedWire(titleOp, null)).toThrow(E2eeLockedError);
    const link: Operation = { ...titleOp, field: "project_id", value: "p-1" };
    expect(() => toEncryptedWire(link, null)).toThrow(E2eeLockedError);
    const del: Operation = { id: "d", entity: "task", entityId: "t", ts: titleOp.ts, op: "delete" };
    expect(() => toEncryptedWire(del, null)).toThrow(E2eeLockedError);
    const keyring = new Keyring({ dek: generateDek() });
    expect(toEncryptedWire(del, keyring)).toEqual({
      id: "d",
      entity: "todo.sealed",
      entity_id: "t",
      scope: null,
      op: "delete",
      ts: { wall_ms: 1000, counter: 0, node: "node-1" },
    });
  });
});
