/**
 * What of an entity leaves the device readable (sync protocol 7, docs/decisions/0006): the wire
 * kind it travels as instead of its real kind, the few field names that travel as they are instead
 * of an opaque tag (`public_fields`), and which of those carry a plaintext value
 * (`plaintext_fields`). Everything else, including fields nothing declares yet, travels under a
 * tag in an encrypted value, so a new field cannot leak because a list was forgotten.
 *
 * Two halves make the tables:
 * - the bundled app manifests (`manifests/<app>.json`), which the server compiles in too: an app's
 *   wire kinds and the fields the server reads. `legacy_plaintext_fields` is what protocol 6 sent
 *   unencrypted, which reading the rows written before protocol 7 needs;
 * - the app definitions registered at run time ({@link registerApp}): an app's own kinds, which
 *   travel as `<app>.sealed` unless its manifest says otherwise, and their scope and authorship
 *   rules. A new kind, field or link is the app's business: it needs no change here.
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

/** A kind in a bundled app manifest. */
export interface KindManifest {
  /** The kind the server sees. */
  wire: string;
  public_fields?: readonly string[];
  plaintext_fields?: readonly string[] | "all";
  legacy_plaintext_fields?: readonly string[];
}

/** A bundled app manifest: its id, version, the kinds the server knows of and its token policy. */
export interface AppManifest {
  app: string;
  name: string;
  version: number;
  kinds: Record<string, KindManifest>;
  api_tokens?: Partial<TokenPolicy>;
}

/**
 * The server half of each app, bundled into this client as the server bundles it. Which apps a
 * client syncs is its session's app scope.
 */
export const BUNDLED_MANIFESTS: readonly AppManifest[] = Object.freeze([
  todoManifest as unknown as AppManifest,
  journalManifest as unknown as AppManifest,
  vaultManifest as unknown as AppManifest,
]);

/**
 * Apps whose kinds predate namespacing and keep their bare names (`task`, `project`); every other
 * app's kinds are `<app>.<kind>` (`atlas_core::UNNAMESPACED_APPS`).
 */
export const UNNAMESPACED_APPS: readonly string[] = Object.freeze(["todo"]);

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

/**
 * How an entity finds the share scope whose key encrypts it.
 * - `"self"`: the entity is a share container (a project). Only a kind travelling as its app's
 *   `<app>.project` wire kind is one, and every such kind is one without saying so.
 * - A list of links: the first one that is set wins. `{ field }` names the project directly;
 *   `{ field, kind }` names an entity of `kind`, whose scope it takes.
 * - No rule: personal, under the account's own key.
 */
export type ScopeLink = { readonly field: string; readonly kind?: string };
export type ScopeRule = "self" | readonly ScopeLink[];

/** What an app tells the engine about one of its kinds. Every key is optional. */
export interface KindDefinition {
  /** The wire kind; defaults to the bundled manifest's, else `<app>.sealed`. */
  wire?: string;
  scope?: ScopeRule;
  /**
   * A field naming the account that wrote the entity: an op setting it to anyone but the account
   * that pushed it is dropped as forged, and only that account re-writes the entity.
   */
  actor_field?: string;
}

/**
 * An app's definition: the kinds it syncs and their rules. It adds to the app's bundled manifest
 * (the server's half) and needs no core change. Register it with {@link registerApp} before
 * opening a store or syncing. See docs/architecture.md (App definitions).
 */
export interface AppDefinition {
  app: string;
  kinds: Readonly<Record<string, KindDefinition>>;
}

interface ResolvedKind extends KindManifest {
  app: string;
  scope?: ScopeRule;
  actor_field?: string;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

let definitions: readonly AppDefinition[] = [];
let resolved: Map<string, ResolvedKind> | null = null;

function serverManifest(app: string): AppManifest | undefined {
  return BUNDLED_MANIFESTS.find((m) => m.app === app);
}

function buildTable(defs: readonly AppDefinition[]): Map<string, ResolvedKind> {
  const table = new Map<string, ResolvedKind>();
  for (const m of BUNDLED_MANIFESTS) {
    for (const [kind, spec] of Object.entries(m.kinds)) {
      const self = spec.wire === `${m.app}.project`;
      table.set(kind, { ...spec, app: m.app, ...(self ? { scope: "self" as const } : {}) });
    }
  }
  for (const def of defs) {
    for (const [kind, d] of Object.entries(def.kinds)) {
      const base = table.get(kind);
      const wire = d.wire ?? base?.wire ?? `${def.app}.sealed`;
      const entry: ResolvedKind = { ...(base ?? { wire }), app: def.app, wire };
      if (d.scope !== undefined) entry.scope = d.scope;
      if (d.actor_field !== undefined) entry.actor_field = d.actor_field;
      table.set(kind, entry);
    }
  }
  return table;
}

function table(): Map<string, ResolvedKind> {
  return (resolved ??= buildTable(definitions));
}

/** Why `def` cannot be registered next to `all` (which includes it), or null. */
function definitionError(def: AppDefinition, all: readonly AppDefinition[]): string | null {
  const server = serverManifest(def.app);
  if (!server) return `no bundled manifest for app "${def.app}": the server would refuse it`;
  if (typeof def.kinds !== "object" || def.kinds === null) return `app ${def.app}: no kinds`;
  const wires = new Set(Object.values(server.kinds).map((k) => k.wire));
  const sealed = `${def.app}.sealed`;
  const project = `${def.app}.project`;
  for (const [kind, d] of Object.entries(def.kinds)) {
    const what = `app ${def.app}: kind "${kind}"`;
    const owner = BUNDLED_MANIFESTS.find((m) => has(m.kinds, kind));
    if (owner && owner.app !== def.app) return `${what} belongs to app ${owner.app}`;
    if (!owner && !UNNAMESPACED_APPS.includes(def.app) && !kind.startsWith(`${def.app}.`))
      return `${what} must be named "${def.app}.<kind>"`;
    const base = owner?.kinds[kind];
    const wire = d.wire ?? base?.wire ?? sealed;
    if (base ? wire !== base.wire : wire !== sealed || !wires.has(sealed))
      return `${what} cannot travel as "${wire}"`;
    if (d.actor_field !== undefined && (typeof d.actor_field !== "string" || !d.actor_field))
      return `${what}: actor_field must be a field name`;
    const rule = d.scope;
    if (rule === undefined) continue;
    if (rule === "self") {
      if (wire !== project) return `${what}: only a "${project}" kind is a share container`;
      continue;
    }
    if (!Array.isArray(rule) || rule.length === 0)
      return `${what}: scope must be "self" or a list of links`;
    if (!wires.has(project)) return `${what}: app ${def.app} has no share containers`;
    for (const link of rule as readonly ScopeLink[]) {
      if (typeof link?.field !== "string" || !link.field) return `${what}: a link needs a field`;
      if (link.kind !== undefined) {
        const k = link.kind;
        const known =
          all.some((a) => has(a.kinds, k)) || BUNDLED_MANIFESTS.some((m) => has(m.kinds, k));
        if (!known) return `${what}: links to unknown kind "${k}"`;
      }
    }
  }
  return null;
}

function cycleError(t: Map<string, ResolvedKind>): string | null {
  const walk = (kind: string, path: Set<string>): boolean => {
    if (path.has(kind)) return true;
    const rule = t.get(kind)?.scope;
    if (!Array.isArray(rule)) return false;
    path.add(kind);
    const cyclic = (rule as readonly ScopeLink[]).some(
      (l) => l.kind !== undefined && walk(l.kind, path),
    );
    path.delete(kind);
    return cyclic;
  };
  for (const start of t.keys()) if (walk(start, new Set())) return `"${start}" links in a cycle`;
  return null;
}

/**
 * Register (or replace) an app's definition. Throws when it conflicts with the bundled manifests
 * or with itself; nothing changes then.
 */
export function registerApp(def: AppDefinition): void {
  const next = [...definitions.filter((d) => d.app !== def.app), def];
  const error = definitionError(def, next);
  if (error) throw new Error(`app definition: ${error}`);
  const t = buildTable(next);
  const cycle = cycleError(t);
  if (cycle) throw new Error(`app definition: ${cycle}`);
  definitions = next;
  resolved = t;
}

/** Drop an app's registered definition (tests). */
export function unregisterApp(app: string): void {
  definitions = definitions.filter((d) => d.app !== app);
  resolved = null;
}

/** The registered app definitions. */
export function appDefinitions(): readonly AppDefinition[] {
  return definitions;
}

/** Every kind this client knows: the bundled manifests' and the registered definitions'. */
export function knownKinds(): EntityKind[] {
  return [...table().keys()];
}

/** How `kind` finds its scope; undefined for a personal kind. */
export function scopeRuleOf(kind: string): ScopeRule | undefined {
  return table().get(kind)?.scope;
}

/** The field naming the writer of a `kind` entity, if it has one. */
export function actorFieldOf(kind: string): string | undefined {
  return table().get(kind)?.actor_field;
}

/** Every field a scope link reads, of any kind. */
export function scopeLinkFields(): ReadonlySet<string> {
  const fields = new Set<string>();
  for (const spec of table().values())
    if (Array.isArray(spec.scope))
      for (const l of spec.scope as readonly ScopeLink[]) fields.add(l.field);
  return fields;
}

/** The bundled manifest of the app owning `kind`. */
export function appOfKind(kind: string): AppManifest | undefined {
  const spec = kindSpec(kind);
  return spec ? serverManifest(spec.app) : undefined;
}

function kindSpec(kind: string): ResolvedKind | undefined {
  return table().get(kind);
}

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

/** The wire kind `kind` travels as; null for a kind neither a manifest nor a definition names. */
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
  return shouldEncryptKindField(entity, field);
}

/** Whether protocol 6 encrypted a value of `kind`.`field`: how a legacy row is read. */
export function legacyEncrypted(kind: string, field: string): boolean {
  const spec = kindSpec(kind);
  if (spec?.plaintext_fields === "all") return false;
  return !(spec?.legacy_plaintext_fields ?? []).includes(field);
}

/**
 * Whether `name` is the wire kind of rows written before protocol 7: a real kind a bundled
 * manifest names that now travels as another.
 */
export function isLegacyWireKind(name: string): boolean {
  const owner = BUNDLED_MANIFESTS.find((m) => has(m.kinds, name));
  const spec = owner?.kinds[name];
  return spec !== undefined && spec.wire !== name;
}

/** The real kinds that travel as wire kind `wire`. */
export function kindsOfWire(wire: string): EntityKind[] {
  return knownKinds().filter((k) => kindSpec(k)?.wire === wire);
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
