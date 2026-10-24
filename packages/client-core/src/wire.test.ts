import { describe, expect, it, vi } from "vitest";
import { DEK_KEY_ID, Keyring, generateDek, generatePek, projectKeyId } from "./crypto";
import type { Hlc } from "./hlc";
import type { ScopeKey } from "./scope";
import { LocalStore } from "./store";
import type { EntityKind, Operation } from "./types";
import { decodeOps, encodeOp, isSealedPlaceholder, type DecodeContext, type WireOp } from "./wire";

const P = "0190a6f0-0000-7000-8000-00000000a001";
const T = "0190a6f0-0000-7000-8000-00000000b001";
const A = "0190a6f0-0000-7000-8000-00000000d001";
const ME = "0190a6f0-0000-7000-8000-0000000000e1";
const OTHER = "0190a6f0-0000-7000-8000-0000000000e2";
const NODE = "0190a6f0-0000-7000-8000-0000000000d2";

let seq = 0;
const newId = () => `0190a6f0-0000-7000-8000-${(++seq).toString(16).padStart(12, "0")}`;
const ts = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter, node: NODE });

function set(entity: EntityKind, entityId: string, field: string, value: unknown, at = ts(1)) {
  return { id: newId(), entity, entityId, ts: at, op: "set" as const, field, value };
}

function keys() {
  const dek = generateDek();
  const pek = generatePek();
  const keyring = new Keyring({ dek });
  keyring.setProjectKey(P, pek);
  const personal = { key: dek, keyId: DEK_KEY_ID, scope: { kind: "personal" as const } };
  const project = {
    key: pek,
    keyId: projectKeyId(pek),
    scope: { kind: "project" as const, projectId: P },
  };
  return { keyring, personal, project };
}

function ctx(keyring: Keyring | null, store?: LocalStore): DecodeContext {
  return {
    keyring,
    store: { kindOf: (id) => store?.kindOf(id) ?? null },
    openLegacy: (op) => op,
  };
}

const decode = (ops: WireOp[], c: DecodeContext): Operation[] => decodeOps(ops, c).map((d) => d.op);

describe("encodeOp", () => {
  it("sends the wire kind, the scope and a per-entity tag, the value sealed", () => {
    const { project, personal } = keys();
    const title = encodeOp(set("task", T, "title", "Secret"), project);
    expect(title).toMatchObject({ entity: "todo.sealed", entity_id: T, scope: P, op: "set" });
    if (title.op !== "set") throw new Error("set");
    expect(title.field).toMatch(/^[0-9a-f]{32}$/);
    expect(title.value).toMatchObject({ __enc: 3, kid: projectKeyId(project.key) });
    expect(JSON.stringify(title)).not.toMatch(/task|title|Secret/);
    // Deterministic per entity, field and key; different for another entity or key.
    const again = encodeOp(set("task", T, "title", "Other"), project);
    const otherTask = encodeOp(set("task", newId(), "title", "Secret"), project);
    const personalTitle = encodeOp(set("task", T, "title", "Secret"), personal);
    expect(again.op === "set" && again.field).toBe(title.field);
    expect(otherTask.op === "set" && otherTask.field).not.toBe(title.field);
    expect(personalTitle).toMatchObject({ scope: null });
    expect(personalTitle.op === "set" && personalTitle.field).not.toBe(title.field);
  });

  it("keeps the public names, and only the blob addresses in plaintext", () => {
    const { project } = keys();
    const sha = "a".repeat(64);
    expect(encodeOp(set("attachment", A, "blob_sha", sha), project)).toMatchObject({
      entity: "todo.sealed",
      field: "blob_sha",
      value: sha,
    });
    const archived = encodeOp(set("project", P, "archived_at", 5), project);
    expect(archived).toMatchObject({ entity: "todo.project", field: "archived_at" });
    expect(archived.op === "set" && archived.value).toMatchObject({ __enc: 3 });
  });

  it("refuses server-authored and unknown kinds", () => {
    const { personal } = keys();
    expect(() => encodeOp(set("project_member", newId(), "role", "owner"), personal)).toThrow();
    expect(() => encodeOp(set("notes.note" as EntityKind, newId(), "x", 1), personal)).toThrow();
  });
});

describe("decodeOps", () => {
  it("opens what it encoded, with the key and scope it opened with", () => {
    const { keyring, project } = keys();
    const op = set("comment", newId(), "body", { text: "hi" });
    const [d] = decodeOps([encodeOp(op, project)], ctx(keyring));
    expect(d!.op).toEqual(op);
    expect(d!.opened).toEqual({ keyId: project.keyId, scope: project.scope });
    expect(d!.legacy).toBe(false);
  });

  it("keeps a value no held key opens sealed under its wire kind and tag", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { project } = keys();
    const wire = encodeOp(set("task", T, "title", "Secret"), project);
    const [op] = decode([wire], ctx(new Keyring({ dek: generateDek() })));
    expect(op).toMatchObject({ entity: "todo.sealed", entityId: T, op: "set" });
    if (op!.op !== "set" || wire.op !== "set") throw new Error("set");
    expect(op!.field).toBe(wire.field);
    expect(isSealedPlaceholder(op!.value)).toBe(true);
    expect((op!.value as { scope: string }).scope).toBe(P);
    warn.mockRestore();
  });

  it("refuses a value moved under another tag, wire kind or scope", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { keyring, project } = keys();
    const title = encodeOp(set("task", T, "title", "Secret"), project);
    const notes = encodeOp(set("task", T, "notes", "Other"), project);
    if (title.op !== "set" || notes.op !== "set") throw new Error("set");
    const moved = [
      { ...title, field: notes.field },
      { ...title, entity: "todo.project" },
      { ...title, scope: null },
      { ...title, entity_id: newId() },
    ];
    for (const w of moved) {
      const [op] = decode([w], ctx(keyring));
      expect(op!.op === "set" && isSealedPlaceholder(op!.value)).toBe(true);
    }
    // A value that is no sealed envelope at all is dropped.
    expect(decode([{ ...title, value: "plain" }], ctx(keyring))).toEqual([]);
    warn.mockRestore();
  });

  it("takes an activity's actor only from the account that pushed it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { keyring, project } = keys();
    const activity = newId();
    const actor = (pushed_by: string | null | undefined) => ({
      ...encodeOp(set("activity", activity, "actor_id", ME), project),
      pushed_by,
    });
    expect(decode([actor(ME)], ctx(keyring))).toHaveLength(1);
    expect(decode([actor(OTHER)], ctx(keyring))).toEqual([]);
    expect(decode([actor(null)], ctx(keyring))).toEqual([]);
    // Other activity fields need no such check.
    const kind = {
      ...encodeOp(set("activity", activity, "kind", "status"), project),
      pushed_by: OTHER,
    };
    expect(decode([kind], ctx(keyring))).toHaveLength(1);
    warn.mockRestore();
  });

  it("gives a delete the kind of the entity it removes: this page's, the store's, or the wire kind's", () => {
    const { keyring, project, personal } = keys();
    const store = new LocalStore("device", { newId });
    const known = newId();
    store.applyRemote(set("label", known, "name", "Mine"));
    const del = (id: string, k: ScopeKey = personal, entity: EntityKind = "task") =>
      encodeOp({ id: newId(), entity, entityId: id, ts: ts(9), op: "delete" }, k);
    const page = newId();
    const [byPage, setOnPage, byStore, unknown, project_] = decode(
      [
        del(page),
        encodeOp(set("comment", page, "body", "x"), project),
        del(known),
        del(newId()),
        del(P, project, "project"),
      ],
      ctx(keyring, store),
    );
    expect(byPage).toMatchObject({ entity: "comment", op: "delete" });
    expect(setOnPage).toMatchObject({ entity: "comment" });
    expect(byStore).toMatchObject({ entity: "label", op: "delete" });
    expect(unknown).toMatchObject({ entity: "todo.sealed", op: "delete" });
    expect(project_).toMatchObject({ entity: "project", op: "delete" });
  });

  it("reads a blob address by its public name", () => {
    const { keyring, project } = keys();
    const sha = "b".repeat(64);
    expect(
      decode([encodeOp(set("attachment", A, "thumb_sha", sha), project)], ctx(keyring)),
    ).toEqual([expect.objectContaining({ entity: "attachment", field: "thumb_sha", value: sha })]);
  });
});

describe("a tombstone that arrives before its entity", () => {
  it("is the entity's once its first field arrives, and keeps older fields hidden", () => {
    const store = new LocalStore("device", { newId });
    const id = newId();
    store.applyRemote({
      id: newId(),
      entity: "todo.sealed" as EntityKind,
      entityId: id,
      ts: ts(10),
      op: "delete",
    });
    store.applyRemote(set("task", id, "title", "Deleted", ts(5)));
    expect(store.get("task", id)).toBeNull();
    store.applyRemote(set("task", id, "notes", "Revived", ts(11)));
    expect(store.get("task", id)).toEqual({ notes: "Revived" });
    expect(store.kindOf(id)).toBe("task");
  });
});
