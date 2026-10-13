import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_MANIFESTS, PLAINTEXT_FIELDS, appOfKind, shouldEncryptField } from "./index";
import type { EntityKind } from "./types";

const manifestPath = fileURLToPath(new URL("../../../manifests/todo.json", import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  app: string;
  version: number;
  kinds: Record<string, { plaintext_fields: string[] | "all" }>;
};

describe("field encryption policy", () => {
  it("is exactly the todo manifest's plaintext_fields", () => {
    const fromManifest = Object.fromEntries(
      Object.entries(manifest.kinds).map(([kind, spec]) => [kind, spec.plaintext_fields]),
    );
    expect(PLAINTEXT_FIELDS).toEqual(fromManifest);
  });

  it("bundles the todo manifest and maps its kinds to it", () => {
    expect(BUNDLED_MANIFESTS.map((m) => m.app)).toEqual([manifest.app]);
    expect(BUNDLED_MANIFESTS[0]!.version).toBe(manifest.version);
    for (const kind of Object.keys(PLAINTEXT_FIELDS)) expect(appOfKind(kind)?.app).toBe("todo");
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
