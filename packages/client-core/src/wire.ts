/**
 * The sync wire format, protocol 7 (docs/decisions/0006): what an {@link Operation} looks like to
 * the server, and back.
 *
 * On the wire an op names a wire kind (`todo.sealed`, …) instead of its real kind, the scope whose
 * key encrypted it (`scope`: a project id, or null for the account's own key), and a field that is
 * an opaque per-entity tag unless the manifest makes it public. The real kind and field travel
 * inside the value's v3 envelope. Rows written before protocol 7 (legacy kinds, real kind names on
 * the wire) are read as before, and re-encoded by the migration (`migrateLegacy`), never by a
 * repair, which would move their timestamps.
 */

import {
  DEK_KEY_ID,
  fieldTag,
  fieldTagKey,
  isFieldEnvelopeV3,
  openSealedField,
  sameKeyScope,
  sealField,
  type FieldEnvelopeV3,
  type KeyScope,
  type Keyring,
} from "./crypto";
import {
  isLegacyWireKind,
  isPublicField,
  kindsOfWire,
  legacyEncrypted,
  realKindOf,
  shouldEncryptField,
  wireKindOf,
} from "./fieldPolicy";
import type { Hlc } from "./hlc";
import type { Repair, ScopeKey } from "./scope";
import type { EntityKind, Operation } from "./types";

export type WireOp = {
  id: string;
  /** A wire kind, or a real kind name on a row written before protocol 7. */
  entity: string;
  entity_id: string;
  /** The project whose key encrypted the op; null for the account's own key. */
  scope?: string | null;
  /** The account that pushed it, as the server says; null for the server's own ops. */
  pushed_by?: string | null;
  ts: { wall_ms: number; counter: number; node: string };
} & ({ op: "set"; field: string; value: unknown } | { op: "delete" });

/** A v3 value no key here opened yet: kept where it arrived, with the scope it was written in. */
export type SealedPlaceholder = FieldEnvelopeV3 & { scope: string | null };

export function isSealedPlaceholder(v: unknown): v is SealedPlaceholder {
  return isFieldEnvelopeV3(v) && "scope" in (v as object);
}

/** Whether `name` is a wire kind of the current protocol (not a legacy or server-authored one). */
export function isSealedWireKind(name: string): boolean {
  return kindsOfWire(name).length > 0 && !isLegacyWireKind(name) && name !== "project_member";
}

const tagKeys = new WeakMap<Uint8Array, Uint8Array>();

function tagKeyOf(key: Uint8Array): Uint8Array {
  let tagKey = tagKeys.get(key);
  if (!tagKey) tagKeys.set(key, (tagKey = fieldTagKey(key)));
  return tagKey;
}

/** The wire name of `field` of `kind` entity `entityId` under `key`: its tag, or the field itself
 * when public. */
export function wireFieldOf(
  key: Uint8Array,
  kind: string,
  entityId: string,
  field: string,
): string {
  return isPublicField(kind, field) ? field : fieldTag(tagKeyOf(key), entityId, kind, field);
}

function scopeOfKey(scope: KeyScope): string | null {
  return scope.kind === "project" ? scope.projectId : null;
}

/**
 * Encode `op` for the wire with `k`, the key of its scope. Throws for a kind no manifest names
 * (the server would refuse it) and for server-authored kinds.
 */
export function encodeOp(op: Operation, k: ScopeKey): WireOp {
  const wire = wireKindOf(op.entity);
  if (!wire || wire === "project_member") throw new Error(`cannot push ${op.entity} ops`);
  const ts = { wall_ms: op.ts.wallMs, counter: op.ts.counter, node: op.ts.node };
  const base = { id: op.id, entity: wire, entity_id: op.entityId, scope: scopeOfKey(k.scope), ts };
  if (op.op === "delete") return { ...base, op: "delete" };
  const field = wireFieldOf(k.key, op.entity, op.entityId, op.field);
  const value = shouldEncryptField(op.entity, op.field)
    ? sealField(
        k.key,
        k.keyId,
        k.scope,
        { entity: wire, entityId: op.entityId, field },
        { kind: op.entity, field: op.field, value: op.value },
      )
    : op.value;
  return { ...base, op: "set", field, value };
}

/** The keys a v3 envelope in `scope` with key id `kid` may be opened with. */
function keysFor(keyring: Keyring, scope: string | null, kid: string): ScopeKey[] {
  if (scope === null) {
    if (kid !== DEK_KEY_ID) return [];
    return [{ key: keyring.getDek(), keyId: DEK_KEY_ID, scope: { kind: "personal" } }];
  }
  const key = keyring.projectKey(scope, kid);
  return key ? [{ key, keyId: kid, scope: { kind: "project", projectId: scope } }] : [];
}

export interface OpenedSealed {
  kind: EntityKind;
  field: string;
  value: unknown;
  keyId: string;
  scope: KeyScope;
}

/**
 * Open a v3 value that arrived as `wire`.`wireField` of `entityId` in `scope`. Null unless a held
 * key of that scope opens it there, its plaintext names a kind of that wire kind, and the wire field
 * is that field's tag (or the field itself, when public).
 */
export function openSealed(
  keyring: Keyring,
  wire: string,
  entityId: string,
  wireField: string,
  scope: string | null,
  envelope: FieldEnvelopeV3,
): OpenedSealed | null {
  for (const k of keysFor(keyring, scope, envelope.kid)) {
    let sealed;
    try {
      sealed = openSealedField(
        k.key,
        k.scope,
        { entity: wire, entityId, field: wireField },
        envelope,
      );
    } catch {
      continue; // not bound to this key, scope and place
    }
    const kind = sealed.kind as EntityKind;
    if (wireKindOf(kind) !== wire) return null;
    if (wireFieldOf(k.key, kind, entityId, sealed.field) !== wireField) return null;
    return { kind, field: sealed.field, value: sealed.value, keyId: k.keyId, scope: k.scope };
  }
  return null;
}

/** Where the decoder finds an entity's real kind and its own entities. */
export interface DecodeStore {
  /** The real kind of an entity this device holds, if it holds one by that id. */
  kindOf(entityId: string): EntityKind | null;
}

export interface DecodeContext {
  /** Null decodes nothing: every current value stays sealed. */
  keyring: Keyring | null;
  store: DecodeStore;
  /** The legacy (protocol 6) decode of one op: the old envelope rules. */
  openLegacy(op: Operation & { op: "set" }): Operation | null;
}

export interface DecodedOp {
  op: Operation;
  /** For a value opened from a v3 envelope: the key and scope it opened with. */
  opened?: { keyId: string; scope: KeyScope };
  /** The op arrived under a legacy kind. */
  legacy: boolean;
}

function hlcOf(w: WireOp): Hlc {
  return { wallMs: w.ts.wall_ms, counter: w.ts.counter, node: w.ts.node };
}

/**
 * Decode one page of wire ops. A delete names no real kind: it takes the kind of the entity this
 * device or the same page knows by its id, else stays under its wire kind until one arrives
 * (`LocalStore` hands such a tombstone on). A value no held key opens stays a
 * {@link SealedPlaceholder} under its wire kind and tag; `reviveLockedValues` opens it once a key
 * arrives.
 */
export function decodeOps(wireOps: readonly WireOp[], ctx: DecodeContext): DecodedOp[] {
  const out: (DecodedOp | null)[] = [];
  const pageKinds = new Map<string, EntityKind>();
  const pendingDeletes: number[] = [];
  for (const w of wireOps) {
    const ts = hlcOf(w);
    const base = { id: w.id, entityId: w.entity_id, ts };
    if (isLegacyWireKind(w.entity) || w.entity === "project_member") {
      const kind = w.entity as EntityKind;
      pageKinds.set(w.entity_id, kind);
      if (w.op === "delete") {
        out.push({
          op: { ...base, entity: kind, op: "delete" },
          legacy: w.entity !== "project_member",
        });
        continue;
      }
      const op = { ...base, entity: kind, op: "set" as const, field: w.field, value: w.value };
      if (w.entity === "project_member" || !legacyEncrypted(kind, w.field)) {
        out.push({ op, legacy: w.entity !== "project_member" });
        continue;
      }
      const opened = ctx.openLegacy(op);
      out.push(opened ? { op: opened, legacy: true } : null);
      continue;
    }
    if (w.op === "delete") {
      const kind = realKindOf(w.entity) ?? ctx.store.kindOf(w.entity_id);
      out.push({
        op: { ...base, entity: (kind ?? w.entity) as EntityKind, op: "delete" },
        legacy: false,
      });
      if (!kind) pendingDeletes.push(out.length - 1);
      continue;
    }
    const scope = w.scope ?? null;
    const publicKind = isPublicFieldOfWire(w.entity, w.field)
      ? realKindOf(w.entity, w.field)
      : null;
    if (publicKind && !shouldEncryptField(publicKind, w.field)) {
      pageKinds.set(w.entity_id, publicKind);
      out.push({
        op: { ...base, entity: publicKind, op: "set", field: w.field, value: w.value },
        legacy: false,
      });
      continue;
    }
    if (!isFieldEnvelopeV3(w.value)) {
      console.warn(`[atlas-e2ee] dropped a value that is no sealed envelope (${w.entity_id})`);
      out.push(null);
      continue;
    }
    const opened = ctx.keyring
      ? openSealed(ctx.keyring, w.entity, w.entity_id, w.field, scope, w.value)
      : null;
    if (!opened) {
      // Kept as it arrived: a key that comes later may open it.
      console.warn(`[atlas-e2ee] no key opens ${w.entity} ${w.field} (${w.entity_id})`);
      const placeholder: SealedPlaceholder = { ...w.value, scope };
      out.push({
        op: {
          ...base,
          entity: w.entity as EntityKind,
          op: "set",
          field: w.field,
          value: placeholder,
        },
        legacy: false,
      });
      continue;
    }
    if (opened.kind === "activity" && opened.field === "actor_id") {
      // The server says who pushed an op; an activity naming someone else is forged.
      if (!w.pushed_by || opened.value !== w.pushed_by) {
        console.warn(
          `[atlas-e2ee] dropped an activity whose actor did not push it (${w.entity_id})`,
        );
        out.push(null);
        continue;
      }
    }
    pageKinds.set(w.entity_id, opened.kind);
    out.push({
      op: { ...base, entity: opened.kind, op: "set", field: opened.field, value: opened.value },
      opened: { keyId: opened.keyId, scope: opened.scope },
      legacy: false,
    });
  }
  // A delete whose entity only this page names.
  for (const i of pendingDeletes) {
    const d = out[i]!;
    const kind = pageKinds.get(d.op.entityId);
    if (kind) d.op = { ...d.op, entity: kind };
  }
  return out.filter((d): d is DecodedOp => d !== null);
}

function isPublicFieldOfWire(wire: string, field: string): boolean {
  return kindsOfWire(wire).some((k) => isPublicField(k, field));
}

/**
 * A key repair for a v3 value that opened under a scope other than its entity's (`expected`) or
 * with a key other than the canonical one: `confirmRepairs` decides whether to re-write it.
 */
export function sealedRepair(
  d: DecodedOp,
  expected: KeyScope | null,
  isCanonical: (keyId: string, scope: KeyScope) => boolean,
): Repair | null {
  if (d.op.op !== "set" || !d.opened) return null;
  const { keyId, scope } = d.opened;
  if (expected && sameKeyScope(expected, scope) && isCanonical(keyId, expected)) return null;
  return {
    entity: d.op.entity,
    entityId: d.op.entityId,
    field: d.op.field,
    ts: d.op.ts,
    value: d.op.value,
    reason: "key",
    keyId,
    scope,
    version: 3,
  };
}
