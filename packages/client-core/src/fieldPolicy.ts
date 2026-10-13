/**
 * Which field values leave the device in plaintext. Everything else, including fields nothing
 * declares yet, is end-to-end encrypted, so a new field cannot leak because a list was forgotten.
 *
 * The table is the `plaintext_fields` of each kind in the bundled app manifests
 * (`manifests/<app>.json`), which the server compiles in too and checks every field value it
 * reads against.
 */

import todoManifest from "../../../manifests/todo.json";
import type { EntityKind } from "./types";

/** A bundled app manifest: its id, version and the entity kinds it syncs. */
export interface AppManifest {
  app: string;
  name: string;
  version: number;
  kinds: Record<string, { plaintext_fields: readonly string[] | "all" }>;
}

/** The manifests bundled into this client, as the server bundles them. */
export const BUNDLED_MANIFESTS: readonly AppManifest[] = Object.freeze([
  todoManifest as unknown as AppManifest,
]);

/** The bundled app owning the kind with this wire name, if any. */
export function appOfKind(kind: string): AppManifest | undefined {
  return BUNDLED_MANIFESTS.find((m) => Object.prototype.hasOwnProperty.call(m.kinds, kind));
}

/**
 * Every entity kind, as a record so adding a kind to `EntityKind` fails to compile until listed.
 */
const ENTITY_KINDS: Record<EntityKind, true> = {
  task: true,
  project: true,
  section: true,
  label: true,
  comment: true,
  preference: true,
  saved_filter: true,
  reminder: true,
  project_member: true,
  activity: true,
  focus_session: true,
  habit: true,
  habit_checkin: true,
  attachment: true,
};

function loadTable(
  manifests: readonly AppManifest[],
): Record<EntityKind, readonly string[] | "all"> {
  const table = {} as Record<EntityKind, readonly string[] | "all">;
  for (const kind of Object.keys(ENTITY_KINDS) as EntityKind[]) {
    const owner = manifests.find((m) => Object.prototype.hasOwnProperty.call(m.kinds, kind));
    const entry: unknown = owner?.kinds[kind]?.plaintext_fields;
    if (entry === "all") table[kind] = "all";
    else if (Array.isArray(entry) && entry.every((f) => typeof f === "string"))
      table[kind] = Object.freeze([...entry]);
    else throw new Error(`app manifests: no valid plaintext_fields for "${kind}"`);
  }
  return Object.freeze(table);
}

export const PLAINTEXT_FIELDS: Readonly<Record<EntityKind, readonly string[] | "all">> =
  loadTable(BUNDLED_MANIFESTS);

export function shouldEncryptField(entity: EntityKind, field: string): boolean {
  const plain = PLAINTEXT_FIELDS[entity] as readonly string[] | "all" | undefined;
  if (plain === "all") return false;
  return !plain?.includes(field);
}
