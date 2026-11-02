import { describe, expect, it } from "vitest";
import vectors from "../../../test-vectors/scope_rule_vectors.json";
import {
  actorFieldOf,
  registerApp,
  scopeLinkFields,
  wireKindOf,
  type AppDefinition,
} from "./fieldPolicy";
import { resolveScope, type Scope, type ScopeStore } from "./scope";
import { TEST_APP } from "./testApp.testutil";

type Entity = { kind: string; id: string; fields: Record<string, unknown> };

function storeOf(entities: readonly Entity[]): ScopeStore {
  const find = (kind: string, id: string) =>
    entities.find((e) => e.kind === kind && e.id === id) ?? null;
  return {
    list: (kind) =>
      entities.filter((e) => e.kind === kind).map((e) => ({ id: e.id, fields: e.fields })),
    get: (kind, id) => find(kind, id)?.fields ?? null,
    rawField: (kind, id, field) => find(kind, id)?.fields[field],
    exists: (kind, id) => find(kind, id) !== null,
  } as ScopeStore;
}

const show = (s: Scope) => (s.kind === "project" ? `project:${s.projectId}` : s.kind);

describe("scope_rule_vectors.json", () => {
  it("routes each kind to its wire kind", () => {
    for (const c of vectors.wire) expect(wireKindOf(c.kind), c.kind).toBe(c.wire);
  });

  it("knows each kind's writer field", () => {
    for (const c of vectors.actor_fields)
      expect(actorFieldOf(c.kind) ?? null, c.kind).toBe(c.field);
  });

  it("collects every linked field", () => {
    expect([...scopeLinkFields()].sort()).toEqual(vectors.link_fields);
  });

  it("resolves every case", () => {
    const store = storeOf(vectors.store as Entity[]);
    for (const c of vectors.cases)
      expect(show(resolveScope(store, c.kind, c.id)), `${c.kind} ${c.id}`).toBe(c.expected);
  });

  it("refuses every invalid definition and keeps the registered one", () => {
    for (const c of vectors.invalid)
      expect(() => registerApp(c.definition as unknown as AppDefinition), c.why).toThrow();
    expect(wireKindOf("vector_note")).toBe("todo.sealed");
    expect(wireKindOf("vector_a")).toBeNull();
    registerApp(TEST_APP);
  });
});
