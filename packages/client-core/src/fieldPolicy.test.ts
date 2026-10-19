import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_MANIFESTS,
  PLAINTEXT_FIELDS,
  appOfKind,
  shouldEncryptField,
  shouldEncryptKindField,
  tokenPolicyFor,
  type TokenPolicy,
} from "./index";
import type { EntityKind } from "./types";

type Manifest = {
  app: string;
  version: number;
  kinds: Record<string, { plaintext_fields: string[] | "all" }>;
};
const readManifest = (app: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../manifests/${app}.json`, import.meta.url)), "utf8"),
  ) as Manifest;
const manifest = readManifest("todo");
const journalManifest = readManifest("journal");

interface FieldPolicyVectors {
  fields: { entity: string; field: string; encrypted: boolean }[];
  token_policies: { apps: string[]; policy: TokenPolicy }[];
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../test-vectors/field_policy_vectors.json", import.meta.url)),
    "utf8",
  ),
) as FieldPolicyVectors;

describe("field policy vectors", () => {
  it.each(vectors.fields.map((c) => [c.entity, c.field, c.encrypted] as const))(
    "%s.%s encrypted: %s",
    (entity, field, encrypted) => {
      expect(shouldEncryptKindField(entity, field)).toBe(encrypted);
      if (entity in PLAINTEXT_FIELDS) {
        expect(shouldEncryptField(entity as EntityKind, field)).toBe(encrypted);
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
        Object.entries(m.kinds).map(([kind, spec]) => [kind, spec.plaintext_fields]),
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
    for (const spec of Object.values(vault.kinds)) expect(spec.plaintext_fields).toEqual([]);
    expect(appOfKind("vault.item")?.app).toBe("vault");
    const journal = BUNDLED_MANIFESTS[1]!;
    expect(journal.name).toBe("Atlas Journal");
    expect(Object.keys(journal.kinds).sort()).toEqual(["journal.entry", "journal.preference"]);
    for (const spec of Object.values(journal.kinds)) expect(spec.plaintext_fields).toEqual([]);
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
    ["attachment", "blob_sha"],
    ["attachment", "thumb_sha"],
    ["attachment", "wrapped_key"],
    ["attachment", "meta"],
  ])("keeps %s.%s plaintext", (entity, field) => {
    expect(shouldEncryptField(entity, field)).toBe(false);
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
