/**
 * Which field values leave the device in plaintext. Everything else, including fields nothing
 * declares yet, is end-to-end encrypted, so a new field cannot leak because a list was forgotten.
 *
 * The table is the `plaintext_fields` of each kind in the bundled app manifests
 * (`manifests/<app>.json`), which the server compiles in too and checks every field value it
 * reads against.
 */

import journalManifest from "../../../manifests/journal.json";
import todoManifest from "../../../manifests/todo.json";
import vaultManifest from "../../../manifests/vault.json";
import type { EntityKind } from "./types";

/**
 * What an app asks of the API tokens that include it (`api_tokens` in its manifest), which the
 * server enforces. Absent keys are the defaults: no expiry needed, writes allowed.
 */
export interface TokenPolicy {
  /** A token must name an expiry. */
  expiry_required: boolean;
  /** The latest expiry a token may name, in days after it is made; null is no limit. */
  max_lifetime_days: number | null;
  /** Whether a token may write when its creator does not say. */
  write_by_default: boolean;
  /** A token including the app may include no other app (the server refuses the mix). */
  exclusive: boolean;
}

/** A bundled app manifest: its id, version, the entity kinds it syncs and its token policy. */
export interface AppManifest {
  app: string;
  name: string;
  version: number;
  kinds: Record<string, { plaintext_fields: readonly string[] | "all" }>;
  api_tokens?: Partial<TokenPolicy>;
}

/**
 * The manifests bundled into this client, as the server bundles them. `EntityKind` (and so
 * {@link PLAINTEXT_FIELDS}) holds every bundled app's kinds, as `atlas_core::EntityKind` does;
 * which of them a client syncs is its session's app scope. Journal's and the vault's kinds
 * encrypt every field.
 */
export const BUNDLED_MANIFESTS: readonly AppManifest[] = Object.freeze([
  todoManifest as unknown as AppManifest,
  journalManifest as unknown as AppManifest,
  vaultManifest as unknown as AppManifest,
]);

/**
 * The policy of a token for all of `apps` (bundled ids), the strictest of theirs as the server
 * takes it: an expiry required if any requires one, the shortest lifetime, and read-only by
 * default if any is, and exclusive if any is. A client making a token reads it to ask for an expiry
 * and write access, and to offer an exclusive app's token on its own.
 */
export function tokenPolicyFor(apps: readonly string[]): TokenPolicy {
  const policy: TokenPolicy = {
    expiry_required: false,
    max_lifetime_days: null,
    write_by_default: true,
    exclusive: false,
  };
  for (const app of apps) {
    const p = BUNDLED_MANIFESTS.find((m) => m.app === app)?.api_tokens;
    if (!p) continue;
    if (p.expiry_required) policy.expiry_required = true;
    if (p.max_lifetime_days != null) {
      policy.max_lifetime_days =
        policy.max_lifetime_days == null
          ? p.max_lifetime_days
          : Math.min(policy.max_lifetime_days, p.max_lifetime_days);
    }
    if (p.write_by_default === false) policy.write_by_default = false;
    if (p.exclusive) policy.exclusive = true;
  }
  return policy;
}

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
  "journal.entry": true,
  "journal.preference": true,
  "vault.item": true,
  "vault.folder": true,
  "vault.preference": true,
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

/**
 * Whether a value of `entity`.`field` is end-to-end encrypted, for any wire kind: a kind no
 * bundled manifest names encrypts everything.
 */
export function shouldEncryptKindField(entity: string, field: string): boolean {
  const plain = appOfKind(entity)?.kinds[entity]?.plaintext_fields;
  if (plain === "all") return false;
  return !plain?.includes(field);
}

export function shouldEncryptField(entity: EntityKind, field: string): boolean {
  const plain = PLAINTEXT_FIELDS[entity] as readonly string[] | "all" | undefined;
  if (plain === "all") return false;
  return !plain?.includes(field);
}
