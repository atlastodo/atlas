import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "bun:test";
import { fromEncryptedWire, type WireOp } from "./api";
import { LocalStore } from "./store";

/**
 * Golden conflict-resolution test. Loads `test-vectors/conflict_vectors.json` and runs each
 * scenario through the client's real merge: the ops arrive in wire form, as a pull delivers them,
 * and a `LocalStore` applies them and resolves the entity. The resolved state must match the
 * fixture, so every client converges on the same result.
 */

// The fixture stores HLC fields snake_case, as the wire does.
interface OpSpec {
  field?: string;
  value?: unknown;
  delete?: boolean;
  ts: WireOp["ts"];
}
interface Scenario {
  name: string;
  ops: OpSpec[];
  expected: { deleted: boolean; fields: Record<string, unknown> };
}
interface Fixture {
  scenarios: Scenario[];
}

const fixturePath = fileURLToPath(
  new URL("../../../test-vectors/conflict_vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

/** Every scenario's ops target this one task. */
const ENTITY_ID = "00000000-0000-0000-0000-0000000000e1";

/** A scenario's ops as the server sends them, each with its own op id. */
function wireOps(scenario: Scenario): WireOp[] {
  return scenario.ops.map((op, i): WireOp => {
    const base = {
      id: `${scenario.name}-${i}`,
      entity: "task" as const,
      entity_id: ENTITY_ID,
      ts: op.ts,
    };
    return op.delete
      ? { ...base, op: "delete" }
      : { ...base, op: "set", field: op.field!, value: op.value };
  });
}

/**
 * Merge `ops` into a fresh store (one by one, or as one pulled batch) and read the entity back:
 * its visible fields, and whether a tombstone hides it.
 */
function resolve(
  ops: WireOp[],
  mode: "single" | "batch" = "single",
): { fields: Record<string, unknown>; deleted: boolean } {
  const store = new LocalStore("00000000-0000-0000-0000-0000000000ff");
  const decoded = ops.map((w) => fromEncryptedWire(w));
  if (mode === "batch") store.applyRemoteBatch(decoded);
  else for (const op of decoded) store.applyRemote(op);
  const fields = store.get("task", ENTITY_ID);
  return { fields: fields ?? {}, deleted: fields === null };
}

describe("shared conflict vectors", () => {
  it("has scenarios", () => {
    expect(fixture.scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of fixture.scenarios) {
    const ops = wireOps(scenario);

    it(`resolves '${scenario.name}' as expected`, () => {
      const { fields, deleted } = resolve(ops);
      expect(deleted).toBe(scenario.expected.deleted);
      expect(fields).toEqual(scenario.expected.fields);
    });

    it(`resolves '${scenario.name}' independent of op order, batching and redelivery`, () => {
      const forward = resolve(ops);
      expect(resolve([...ops].reverse())).toEqual(forward);
      expect(resolve(ops, "batch")).toEqual(forward);
      expect(resolve([...ops, ...[...ops].reverse()])).toEqual(forward);
    });
  }
});
