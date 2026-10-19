import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  VaultError,
  newVaultItemFields,
  resolveVaultItem,
  summarizeVaultItem,
  toVaultItem,
  vaultItemChanges,
  vaultItemField,
} from "./vault";

/**
 * `test-vectors/vault_item_vectors.json`, which the Rust client (`crates/atlas-client/src/vault.rs`)
 * asserts as well.
 */

type Fields = Record<string, unknown>;
interface Failure {
  code: string;
  message: string;
}
interface Vectors {
  now: number;
  create: { name: string; input: unknown; fields?: Fields; error?: Failure }[];
  update: { name: string; item: Fields; patch: unknown; changes?: Fields; error?: Failure }[];
  read: { name: string; fields: Fields; item: Fields; summary: Fields }[];
  resolve: {
    name: string;
    items: { id: string; name: string; deleted_at: number | null }[];
    ref: string;
    id?: string;
    error?: Failure;
  }[];
  field: { name: string; item: Fields; field: string; value?: string; error?: Failure }[];
}

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../test-vectors/vault_item_vectors.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

/** The rule's result, or its error as the fixture writes one. */
function outcome<T>(run: () => T): { ok: T } | { error: Failure } {
  try {
    return { ok: run() };
  } catch (e) {
    if (!(e instanceof VaultError)) throw e;
    return { error: { code: e.code, message: e.message } };
  }
}

const withoutId = ({ id: _id, ...rest }: { id: string }) => rest;

describe("vault item vectors", () => {
  it.each(vectors.create.map((c) => [c.name, c] as const))("create: %s", (_, c) => {
    const got = outcome(() => newVaultItemFields(c.input, vectors.now));
    expect(got).toEqual(c.error ? { error: c.error } : { ok: c.fields });
  });

  it.each(vectors.update.map((c) => [c.name, c] as const))("update: %s", (_, c) => {
    const got = outcome(() => vaultItemChanges(c.item, c.patch, vectors.now));
    expect(got).toEqual(c.error ? { error: c.error } : { ok: c.changes });
  });

  it.each(vectors.read.map((c) => [c.name, c] as const))("read: %s", (_, c) => {
    const item = toVaultItem("x", c.fields);
    expect(withoutId(item)).toEqual(c.item);
    expect(withoutId(summarizeVaultItem(item))).toEqual(c.summary);
  });

  it.each(vectors.resolve.map((c) => [c.name, c] as const))("resolve: %s", (_, c) => {
    const got = outcome(() => resolveVaultItem(c.items, c.ref));
    expect(got).toEqual(c.error ? { error: c.error } : { ok: c.id });
  });

  it.each(vectors.field.map((c) => [c.name, c] as const))("field: %s", (_, c) => {
    const got = outcome(() => vaultItemField(toVaultItem("x", c.item), c.field));
    expect(got).toEqual(c.error ? { error: c.error } : { ok: c.value });
  });
});
