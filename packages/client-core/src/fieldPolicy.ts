/**
 * What of an entity leaves the device readable (sync protocol 7, docs/decisions/0006): the wire
 * kind it travels as instead of its real kind, the few field names that travel as they are instead
 * of an opaque tag (`public_fields`), and which of those carry a plaintext value
 * (`plaintext_fields`). Everything else, including fields nothing declares yet, travels under a
 * tag in an encrypted value, so a new field cannot leak because a list was forgotten.
 *
 * The tables are the bundled app manifests (`manifests/<app>.json`), which the server compiles in
 * too. `legacy_plaintext_fields` is what protocol 6 sent unencrypted, which reading the rows
 * written before protocol 7 needs.
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
export interface KindManifest {
  /** The kind the server sees. */
  wire: string;
  public_fields?: readonly string[];
  plaintext_fields?: readonly string[] | "all";
  legacy_plaintext_fields?: readonly string[];
}

export interface AppManifest {
  app: string;
  name: string;
  version: number;
  kinds: Record<string, KindManifest>;
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

function kindSpec(kind: string): KindManifest | undefined {
  return appOfKind(kind)?.kinds[kind];
}

function loadTable(
  manifests: readonly AppManifest[],
): Record<EntityKind, readonly string[] | "all"> {
  const table = {} as Record<EntityKind, readonly string[] | "all">;
  for (const kind of Object.keys(ENTITY_KINDS) as EntityKind[]) {
    const owner = manifests.find((m) => Object.prototype.hasOwnProperty.call(m.kinds, kind));
    const spec = owner?.kinds[kind];
    if (typeof spec?.wire !== "string") {
      throw new Error(`app manifests: no wire kind for "${kind}"`);
    }
    const entry: unknown = spec.plaintext_fields ?? [];
    if (entry === "all") table[kind] = "all";
    else if (Array.isArray(entry) && entry.every((f) => typeof f === "string"))
      table[kind] = Object.freeze([...entry]);
    else throw new Error(`app manifests: no valid plaintext_fields for "${kind}"`);
  }
  return Object.freeze(table);
}

/** Per real kind, the fields whose value travels unencrypted. */
export const PLAINTEXT_FIELDS: Readonly<Record<EntityKind, readonly string[] | "all">> =
  loadTable(BUNDLED_MANIFESTS);

/**
 * The app owning wire name `name`: a wire kind (`todo.sealed`), or a real kind name, which rows
 * written before protocol 7 carry.
 */
export function appOfWire(name: string): AppManifest | undefined {
  return (
    appOfKind(name) ??
    BUNDLED_MANIFESTS.find((m) => Object.values(m.kinds).some((k) => k.wire === name))
  );
}

/** The wire kind `kind` travels as; null for a kind no bundled manifest names. */
export function wireKindOf(kind: string): string | null {
  return kindSpec(kind)?.wire ?? null;
}

/** Whether `field` of `kind` goes on the wire under its name rather than an opaque tag. */
export function isPublicField(kind: string, field: string): boolean {
  const spec = kindSpec(kind);
  if (!spec) return false;
  return spec.plaintext_fields === "all" || (spec.public_fields ?? []).includes(field);
}

/** Whether a value of `kind`.`field` leaves the device encrypted (protocol 7). */
export function shouldEncryptKindField(entity: string, field: string): boolean {
  const plain = kindSpec(entity)?.plaintext_fields;
  if (plain === "all") return false;
  return !plain?.includes(field);
}

export function shouldEncryptField(entity: EntityKind, field: string): boolean {
  const plain = PLAINTEXT_FIELDS[entity] as readonly string[] | "all" | undefined;
  if (plain === "all") return false;
  return !plain?.includes(field);
}

/** Whether protocol 6 encrypted a value of `kind`.`field`: how a legacy row is read. */
export function legacyEncrypted(kind: string, field: string): boolean {
  const spec = kindSpec(kind);
  if (spec?.plaintext_fields === "all") return false;
  return !(spec?.legacy_plaintext_fields ?? []).includes(field);
}

/** Whether `name` is the wire kind of rows written before protocol 7: a real kind that now
 * travels as another. */
export function isLegacyWireKind(name: string): boolean {
  const spec = kindSpec(name);
  return spec !== undefined && spec.wire !== name;
}

/** The real kinds that travel as wire kind `wire`. */
export function kindsOfWire(wire: string): EntityKind[] {
  return (Object.keys(ENTITY_KINDS) as EntityKind[]).filter((k) => kindSpec(k)?.wire === wire);
}

/**
 * The real kind a public field names on wire kind `wire` (`blob_sha` on `todo.sealed` is an
 * attachment's), or the wire kind's only real kind; null when neither tells.
 */
export function realKindOf(wire: string, publicField?: string): EntityKind | null {
  const kinds = kindsOfWire(wire);
  if (kinds.length === 1) return kinds[0]!;
  if (publicField === undefined) return null;
  const naming = kinds.filter((k) => isPublicField(k, publicField));
  return naming.length === 1 ? naming[0]! : null;
}
