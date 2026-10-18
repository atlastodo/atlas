import { describe, it, expect } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import {
  PORTABLE_KINDS,
  exportData,
  serializeBundle,
  bundleFilename,
  parseBundle,
  importBundle,
} from "./dataTransfer";

const p1 = "0192a000-0000-7000-8000-000000000001";
const s1 = "0192a000-0000-7000-8000-000000000002";
const t1 = "0192a000-0000-7000-8000-000000000003";
const l1 = "0192a000-0000-7000-8000-000000000004";

function seeded(): LocalStore {
  const store = new LocalStore("test");
  store.set("project", p1, "name", "Work");
  store.set("project", p1, "kind", "project");
  store.set("section", s1, "project_id", p1);
  store.set("section", s1, "name", "Todo");
  store.set("task", t1, "project_id", p1);
  store.set("task", t1, "title", "First");
  store.set("task", t1, "priority", 2);
  store.set("label", l1, "name", "urgent");
  // Server-managed kinds that must NOT be exported.
  store.set("project_member", "0192a000-0000-7000-8000-000000000005", "email", "a@b.c");
  store.set("activity", "0192a000-0000-7000-8000-000000000006", "kind", "status");
  return store;
}

describe("dataTransfer", () => {
  it("exportData captures portable kinds and excludes server-managed ones", () => {
    const bundle = exportData(seeded());
    expect(bundle.app).toBe("atlas-todo");
    expect(bundle.version).toBe(1);
    expect(bundle.entities.task).toHaveLength(1);
    expect(bundle.entities.task![0]!.fields.title).toBe("First");
    expect(bundle.entities.project).toHaveLength(1);
    expect(bundle.entities.label).toHaveLength(1);
    // Server-managed kinds are not portable.
    expect(PORTABLE_KINDS).not.toContain("project_member");
    expect(PORTABLE_KINDS).not.toContain("activity");
    expect(bundle.entities).not.toHaveProperty("project_member");
    expect(bundle.entities).not.toHaveProperty("activity");
  });

  it("round-trips through serialize/parse and imports into a fresh store", () => {
    const text = serializeBundle(exportData(seeded()));
    const bundle = parseBundle(text);
    const fresh = new LocalStore("test2");
    const { count } = importBundle(fresh, () => {}, bundle);

    expect(count).toBeGreaterThan(0);
    const t = fresh.get("task", t1);
    expect(t?.title).toBe("First");
    expect(t?.priority).toBe(2);
    expect(fresh.get("project", p1)?.name).toBe("Work");
    expect(fresh.get("section", s1)?.name).toBe("Todo");
    expect(fresh.get("label", l1)?.name).toBe("urgent");
  });

  it("merges by LWW so the imported value wins on an id conflict", () => {
    const bundle = parseBundle(serializeBundle(exportData(seeded())));
    const other = new LocalStore("test3");
    other.set("task", t1, "title", "Stale local");
    importBundle(other, () => {}, bundle);
    expect(other.get("task", t1)?.title).toBe("First");
    // Nothing is deleted by an import.
    expect(other.list("task")).toHaveLength(1);
  });

  it("parseBundle rejects junk and non-atlas payloads", () => {
    expect(() => parseBundle("not json")).toThrow();
    expect(() => parseBundle(JSON.stringify({ app: "other", version: 1 }))).toThrow();
    expect(() => parseBundle(JSON.stringify({ app: "atlas-todo" }))).toThrow();
  });

  it("importBundle skips unknown kinds without throwing", () => {
    const bundle = parseBundle(serializeBundle(exportData(seeded())));
    // Inject an unknown kind into the parsed bundle.
    (bundle.entities as Record<string, unknown>).mystery = [{ id: "x", fields: { a: 1 } }];
    const fresh = new LocalStore("test4");
    expect(() => importBundle(fresh, () => {}, bundle)).not.toThrow();
    expect(fresh.get("task", t1)?.title).toBe("First");
  });

  it("importBundle skips rows whose id is not a canonical UUID", () => {
    const bundle = parseBundle(
      JSON.stringify({
        app: "atlas-todo",
        version: 1,
        exportedAt: 0,
        entities: {
          task: [
            { id: "t1", fields: { title: "Not a uuid" } },
            { id: t1.toUpperCase(), fields: { title: "Not canonical" } },
            { id: `{${t1}}`, fields: { title: "Braced" } },
            { id: t1, fields: { title: "Kept" } },
          ],
        },
      }),
    );
    const fresh = new LocalStore("test5");
    expect(importBundle(fresh, () => {}, bundle)).toEqual({ count: 1 });
    expect(fresh.list("task").map((e) => [e.id, e.fields.title])).toEqual([[t1, "Kept"]]);
    expect(fresh.unsyncedOps().every((op) => op.entityId === t1)).toBe(true);
  });

  it("bundleFilename embeds the date", () => {
    const name = bundleFilename(Date.UTC(2026, 6, 12, 10, 0, 0));
    expect(name).toBe("atlas-todo-export-2026-07-12.json");
  });
});
