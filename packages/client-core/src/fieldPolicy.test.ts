import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_MANIFESTS,
  PLAINTEXT_FIELDS,
  appOfKind,
  isLegacyWireKind,
  isPublicField,
  kindsOfWire,
  legacyEncrypted,
  realKindOf,
  shouldEncryptField,
  shouldEncryptKindField,
  tokenPolicyFor,
  wireKindOf,
  type TokenPolicy,
} from "./index";
import type { EntityKind } from "./types";

type Manifest = {
  app: string;
  version: number;
  kinds: Record<string, { wire: string; plaintext_fields?: string[] | "all" }>;
};
const readManifest = (app: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../manifests/${app}.json`, import.meta.url)), "utf8"),
  ) as Manifest;
const manifest = readManifest("todo");
const journalManifest = readManifest("journal");

interface FieldPolicyVectors {
  fields: {
    entity: string;
    field: string;
    wire: string | null;
    public: boolean;
    encrypted: boolean;
    legacy_encrypted: boolean;
  }[];
  token_policies: { apps: string[]; policy: TokenPolicy }[];
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../test-vectors/field_policy_vectors.json", import.meta.url)),
    "utf8",
  ),
) as FieldPolicyVectors;

describe("field policy vectors", () => {
  it.each(vectors.fields.map((c) => [c.entity, c.field, c] as const))(
    "%s.%s",
    (entity, field, c) => {
      expect(wireKindOf(entity)).toBe(c.wire);
      expect(isPublicField(entity, field)).toBe(c.public);
      expect(shouldEncryptKindField(entity, field)).toBe(c.encrypted);
      expect(legacyEncrypted(entity, field)).toBe(c.legacy_encrypted);
      if (entity in PLAINTEXT_FIELDS) {
        expect(shouldEncryptField(entity as EntityKind, field)).toBe(c.encrypted);
      }
    },
  );

  it.each(vectors.token_policies.map((c) => [c.apps.join(","), c] as const))(
    "a token for %s",
    (_, c) => {
      expect(tokenPolicyFor(c.apps)).toEqual(c.policy);
    },
  );
});

describe("field encryption policy", () => {
  it("is exactly the bundled manifests' plaintext_fields, every kind of every app", () => {
    const fromManifests = Object.fromEntries(
      [manifest, journalManifest, readManifest("vault")].flatMap((m) =>
        Object.entries(m.kinds).map(([kind, spec]) => [kind, spec.plaintext_fields ?? []]),
      ),
    );
    expect(PLAINTEXT_FIELDS).toEqual(fromManifests);
  });

  it("bundles the todo, journal and vault manifests and maps their kinds to them", () => {
    expect(BUNDLED_MANIFESTS.map((m) => m.app)).toEqual([manifest.app, "journal", "vault"]);
    expect(BUNDLED_MANIFESTS[0]!.version).toBe(manifest.version);
    for (const kind of Object.keys(manifest.kinds)) expect(appOfKind(kind)?.app).toBe("todo");
    const vault = BUNDLED_MANIFESTS[2]!;
    expect(vault.name).toBe("Atlas Vault");
    expect(Object.keys(vault.kinds).sort()).toEqual([
      "vault.folder",
      "vault.item",
      "vault.preference",
    ]);
    for (const spec of Object.values(vault.kinds)) {
      expect(spec.plaintext_fields ?? []).toEqual([]);
      expect(spec.wire).toBe("vault.sealed");
    }
    expect(appOfKind("vault.item")?.app).toBe("vault");
    const journal = BUNDLED_MANIFESTS[1]!;
    expect(journal.name).toBe("Atlas Journal");
    expect(Object.keys(journal.kinds).sort()).toEqual(["journal.entry", "journal.preference"]);
    for (const spec of Object.values(journal.kinds)) {
      expect(spec.plaintext_fields ?? []).toEqual([]);
      expect(spec.wire).toBe("journal.sealed");
    }
    expect(appOfKind("journal.entry")?.app).toBe("journal");
    expect(appOfKind("entry")).toBeUndefined();
    expect(appOfKind("notes.note")).toBeUndefined();
    expect(appOfKind("toString")).toBeUndefined();
  });

  it.each<[EntityKind, string]>([
    ["task", "title"],
    ["task", "notes"],
    ["task", "due_at"],
    ["task", "is_completed"],
    ["task", "deleted_at"],
    ["task", "section_id"],
    ["project", "name"],
    ["project", "deleted_at"],
    ["section", "name"],
    ["label", "name"],
    ["comment", "body"],
    ["activity", "old_value"],
    ["activity", "new_value"],
    ["habit", "steps"],
    ["habit", "schedule_history"],
    ["habit_checkin", "note"],
    ["reminder", "title"],
    ["saved_filter", "query"],
    ["preference", "value"],
    ["focus_session", "task_id"],
    ["attachment", "blob_size"],
  ])("encrypts %s.%s", (entity, field) => {
    expect(shouldEncryptField(entity, field)).toBe(true);
  });

  it.each<[EntityKind, string]>([
    ["task", "project_id"],
    ["task", "assignee_id"],
    ["section", "project_id"],
    ["comment", "task_id"],
    ["activity", "task_id"],
    ["activity", "actor_id"],
    ["attachment", "task_id"],
    ["attachment", "wrapped_key"],
    ["attachment", "meta"],
  ])("encrypts %s.%s, which protocol 6 sent in plaintext", (entity, field) => {
    expect(shouldEncryptField(entity, field)).toBe(true);
    expect(isPublicField(entity, field)).toBe(false);
    expect(legacyEncrypted(entity, field)).toBe(false);
  });

  it("keeps the blob addresses public and in plaintext, a project's archive and delete public only", () => {
    for (const field of ["blob_sha", "thumb_sha"]) {
      expect(isPublicField("attachment", field)).toBe(true);
      expect(shouldEncryptField("attachment", field)).toBe(false);
    }
    for (const field of ["deleted_at", "archived_at"]) {
      expect(isPublicField("project", field)).toBe(true);
      expect(shouldEncryptField("project", field)).toBe(true);
      expect(isPublicField("task", field)).toBe(false);
    }
  });

  it("maps real kinds to wire kinds and back", () => {
    expect(wireKindOf("project")).toBe("todo.project");
    expect(wireKindOf("comment")).toBe("todo.sealed");
    expect(wireKindOf("project_member")).toBe("project_member");
    expect(wireKindOf("vault.item")).toBe("vault.sealed");
    expect(wireKindOf("notes.note")).toBeNull();
    expect(realKindOf("todo.project")).toBe("project");
    expect(realKindOf("todo.sealed")).toBeNull();
    expect(realKindOf("todo.sealed", "blob_sha")).toBe("attachment");
    expect(realKindOf("project_member")).toBe("project_member");
    expect(kindsOfWire("journal.sealed").sort()).toEqual(["journal.entry", "journal.preference"]);
    expect(isLegacyWireKind("task")).toBe(true);
    expect(isLegacyWireKind("vault.item")).toBe(true);
    expect(isLegacyWireKind("project_member")).toBe(false);
    expect(isLegacyWireKind("todo.sealed")).toBe(false);
  });

  it("encrypts every field of the journal's kinds", () => {
    for (const kind of ["journal.entry", "journal.preference"] as const) {
      for (const field of ["date", "title", "body", "mood", "tags", "deleted_at", "project_id"]) {
        expect(shouldEncryptField(kind, field)).toBe(true);
      }
    }
  });

  it("encrypts fields nothing has declared yet", () => {
    expect(shouldEncryptField("task", "some_future_field")).toBe(true);
    expect(shouldEncryptField("comment", "anything")).toBe(true);
    expect(shouldEncryptField("no_such_entity" as EntityKind, "project_id")).toBe(true);
  });

  it("never encrypts server-authored project_member fields", () => {
    for (const field of ["project_id", "user_id", "email", "role", "state", "whatever"]) {
      expect(shouldEncryptField("project_member", field)).toBe(false);
    }
  });
});
