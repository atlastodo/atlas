/**
 * Which key encrypts an entity's fields (shared project: its PEK, else the DEK) and repair of
 * values written with the wrong one. See docs/architecture.md#key-trust.
 *
 * A value is read only with a key of its own scope, and a repair only re-encrypts within that
 * scope: the server can rewrite plaintext links and copy ciphertext, so a cross-scope repair would
 * re-encrypt server-placed content for the target's key holders. Content crosses scopes only when
 * the user moves or shares it ({@link rescopeTask}, {@link rescopeProject}).
 *
 * A repair writes at `successorHlc(ts)` only while the winning write is still the one at `ts`.
 */

import {
  DEK_KEY_ID,
  MissingScopeKey,
  decryptField,
  decryptJson,
  isEncryptedEnvelope,
  isFieldEnvelopeV2,
  isWrappedAttachmentKey,
  sameKeyScope,
  unwrapAttachmentKey,
  unwrapKey,
  wrapAttachmentKey,
  type AttachmentKeyPayload,
  type EncryptedPayload,
  type FieldLocation,
  type KeyScope,
  type Keyring,
} from "./crypto";
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { compareHlc, successorHlc, type Hlc } from "./hlc";
import type { LocalStore } from "./store";
import { KEY_TRUST_ID } from "./trust";
import type { EntityKind, Operation } from "./types";
import { openSealed } from "./wire";

export type ScopeStore = Pick<LocalStore, "list" | "get" | "rawField" | "exists">;

export const EMPTY_SCOPE_STORE: ScopeStore = {
  list: () => [],
  get: () => null,
  rawField: () => undefined,
  exists: () => false,
};

export type Scope =
  { kind: "personal" } | { kind: "project"; projectId: string } | { kind: "unknown" };

export interface BatchLinks {
  links: Map<string, Map<string, { value: unknown; ts: Hlc }>>;
  seen: Set<string>;
}

const LINK_FIELDS = new Set(["project_id", "task_id"]);

export function batchLinksOf(ops: readonly Operation[]): BatchLinks {
  const batch: BatchLinks = { links: new Map(), seen: new Set() };
  for (const op of ops) {
    batch.seen.add(op.entityId);
    if (op.op !== "set" || !LINK_FIELDS.has(op.field)) continue;
    let fields = batch.links.get(op.entityId);
    if (!fields) batch.links.set(op.entityId, (fields = new Map()));
    const prev = fields.get(op.field);
    if (!prev || compareHlc(op.ts, prev.ts) > 0)
      fields.set(op.field, { value: op.value, ts: op.ts });
  }
  return batch;
}

/** The batch's links first, then the store's (tombstones included). */
export function resolveScope(
  store: ScopeStore,
  entity: EntityKind,
  id: string,
  batch?: BatchLinks,
): Scope {
  const link = (kind: EntityKind, eid: string, field: string): string | null => {
    const fromBatch = batch?.links.get(eid)?.get(field);
    const v = fromBatch ? fromBatch.value : store.rawField(kind, eid, field);
    return typeof v === "string" && v !== "" ? v : null;
  };
  const known = (kind: EntityKind, eid: string) =>
    (batch?.seen.has(eid) ?? false) || store.exists(kind, eid);

  switch (entity) {
    case "project":
      return { kind: "project", projectId: id };
    case "task":
    case "section": {
      const projectId = link(entity, id, "project_id");
      if (projectId) return { kind: "project", projectId };
      return known(entity, id) ? { kind: "personal" } : { kind: "unknown" };
    }
    case "comment":
    case "activity":
    case "attachment": {
      const taskId = link(entity, id, "task_id");
      if (!taskId) return known(entity, id) ? { kind: "personal" } : { kind: "unknown" };
      const projectId = link("task", taskId, "project_id");
      if (projectId) return { kind: "project", projectId };
      return known("task", taskId) ? { kind: "personal" } : { kind: "unknown" };
    }
    default:
      return { kind: "personal" };
  }
}

function activeMembers(store: Pick<ScopeStore, "list">, projectId: string) {
  return store
    .list("project_member")
    .filter((e) => e.fields.project_id === projectId && e.fields.state === "active");
}

export function sharedProjectIds(store: Pick<ScopeStore, "list">): Set<string> {
  const ids = new Set<string>();
  for (const e of store.list("project_member")) {
    if (e.fields.state === "active" && typeof e.fields.project_id === "string")
      ids.add(e.fields.project_id);
  }
  return ids;
}

const MEMBER_NAMESPACE = hexToBytes("4d355f70726f6a5f6d656d6265720001");

/** UUID v5 of `"<projectId>:<userId>"`, so every copy converges on one entity. */
export function memberEntityId(projectId: string, userId: string): string {
  const hash = sha1(concatBytes(MEMBER_NAMESPACE, utf8ToBytes(`${projectId}:${userId}`)));
  const b = hash.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = bytesToHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The server takes no writes from a non-member, so these would wait for a key forever. */
export function revokedProjectOps(
  store: Pick<LocalStore, "unsyncedOps" | "exists" | "get" | "rawField" | "list">,
  userId: string,
): Operation[] {
  const ops = store.unsyncedOps();
  if (ops.length === 0) return [];
  const batch = batchLinksOf(ops);
  const revoked = new Map<string, boolean>();
  const isRevoked = (projectId: string) => {
    let answer = revoked.get(projectId);
    if (answer === undefined) {
      const membership = memberEntityId(projectId, userId);
      answer =
        store.exists("project", projectId) &&
        store.get("project", projectId) === null &&
        store.exists("project_member", membership) &&
        store.get("project_member", membership) === null;
      revoked.set(projectId, answer);
    }
    return answer;
  };
  return ops.filter((op) => {
    const scope = resolveScope(store, op.entity, op.entityId, batch);
    return scope.kind === "project" && isRevoked(scope.projectId);
  });
}

export function isProjectShared(store: Pick<ScopeStore, "list">, projectId: string): boolean {
  return activeMembers(store, projectId).length > 0;
}

/** An active owner row, or the project is unshared and in their store (only its creator holds one). */
export function isProjectCreator(
  store: Pick<ScopeStore, "list" | "get">,
  projectId: string,
  userId: string,
): boolean {
  const rows = activeMembers(store, projectId);
  if (rows.length === 0) return store.get("project", projectId) !== null;
  return rows.some((e) => e.fields.user_id === userId && e.fields.role === "owner");
}

export interface ScopeKey {
  key: Uint8Array;
  keyId: string;
  scope: KeyScope;
}

const PERSONAL: KeyScope = { kind: "personal" };

/** The canonical project key; {@link MissingScopeKey} for a shared project without it; else the DEK. */
export function keyForScope(keyring: Keyring, scope: Scope, shared: ReadonlySet<string>): ScopeKey {
  if (scope.kind === "project") {
    const key = keyring.getProjectKey(scope.projectId);
    if (key) {
      const projectScope: KeyScope = { kind: "project", projectId: scope.projectId };
      return { key, keyId: keyring.canonicalKeyId(scope.projectId)!, scope: projectScope };
    }
    if (shared.has(scope.projectId)) throw new MissingScopeKey(scope.projectId);
  }
  return { key: keyring.getDek(), keyId: DEK_KEY_ID, scope: PERSONAL };
}

/** The project's while shared or its key is held, else personal. Null while unknown. */
export function expectedKeyScope(
  keyring: Keyring,
  scope: Scope,
  shared: ReadonlySet<string>,
): KeyScope | null {
  if (scope.kind === "unknown") return null;
  if (scope.kind === "project") {
    if (keyring.getProjectKey(scope.projectId) || shared.has(scope.projectId)) {
      return { kind: "project", projectId: scope.projectId };
    }
  }
  return PERSONAL;
}

function preferredKey(
  keyring: Keyring,
  scope: Scope,
  shared: ReadonlySet<string>,
): ScopeKey | null {
  if (scope.kind === "unknown") return null;
  try {
    return keyForScope(keyring, scope, shared);
  } catch (err) {
    if (err instanceof MissingScopeKey) return null;
    throw err;
  }
}

function keysOfScope(keyring: Keyring, scope: KeyScope): ScopeKey[] {
  if (scope.kind === "personal") return [{ key: keyring.getDek(), keyId: DEK_KEY_ID, scope }];
  return keyring.projectKeys(scope.projectId).map((k) => ({ ...k, scope }));
}

export interface OpenedValue {
  value: unknown;
  keyId: string;
  scope: KeyScope;
  version: 1 | 2;
}

export interface OpenOptions {
  /** After the account's own values are rewritten, a v1 personal value can only be server-copied. */
  personalV1?: boolean;
  v2Only?: boolean;
  /** Read v1 personal-key values in a project scope, only for projects whose sole member is the user. */
  adoptPersonalV1?: boolean;
}

/** Only `expected`'s keys are tried and a v2 value opens only where written, so copied ciphertext stays unread. */
export function openFieldValue(
  keyring: Keyring,
  envelope: unknown,
  at: FieldLocation,
  expected: KeyScope | null,
  opts: OpenOptions = {},
): OpenedValue | null {
  if (isFieldEnvelopeV2(envelope)) {
    let candidates: ScopeKey[];
    if (envelope.kid === DEK_KEY_ID) {
      candidates = expected && expected.kind !== "personal" ? [] : keysOfScope(keyring, PERSONAL);
    } else {
      const projects =
        expected === null
          ? keyring.projectsWithKey(envelope.kid)
          : expected.kind === "project"
            ? [expected.projectId]
            : [];
      candidates = projects.flatMap((projectId) => {
        const key = keyring.projectKey(projectId, envelope.kid);
        const scope: KeyScope = { kind: "project", projectId };
        return key ? [{ key, keyId: envelope.kid, scope }] : [];
      });
    }
    for (const k of candidates) {
      try {
        return {
          value: decryptField(k.key, k.scope, at, envelope),
          keyId: k.keyId,
          scope: k.scope,
          version: 2,
        };
      } catch {
        // not bound to this key, scope and place
      }
    }
    return null;
  }
  if (opts.v2Only || !isEncryptedEnvelope(envelope)) return null;
  // Version 1 binds nothing, so the scope check is all there is: only its keys are tried.
  const candidates = expected
    ? keysOfScope(keyring, expected)
    : keyring.allKeys().map((k) => ({
        key: k.key,
        keyId: k.keyId,
        scope:
          k.projectId === null
            ? PERSONAL
            : ({ kind: "project", projectId: k.projectId } as KeyScope),
      }));
  for (const k of candidates) {
    if (k.scope.kind === "personal" && opts.personalV1 === false) continue;
    try {
      const value = decryptJson(k.key, { iv: envelope.iv, ct: envelope.ct });
      return { value, keyId: k.keyId, scope: k.scope, version: 1 };
    } catch {
      // not this key
    }
  }
  if (opts.adoptPersonalV1 && expected?.kind === "project") {
    try {
      const value = decryptJson(keyring.getDek(), { iv: envelope.iv, ct: envelope.ct });
      return { value, keyId: DEK_KEY_ID, scope: expected, version: 1 };
    } catch {
      // not the personal key either
    }
  }
  return null;
}

/** Projects whose only member is `userId` as active owner: nobody else can read them. */
export function soleOwnedProjects(store: Pick<ScopeStore, "list">, userId: string): Set<string> {
  const others = new Set<string>();
  const owned = new Set<string>();
  for (const e of store.list("project_member")) {
    const projectId = e.fields.project_id;
    if (typeof projectId !== "string") continue;
    if (e.fields.user_id !== userId) {
      if (e.fields.state === "active" || e.fields.state === "pending") others.add(projectId);
    } else if (e.fields.role === "owner" && e.fields.state === "active") {
      owned.add(projectId);
    }
  }
  for (const projectId of others) owned.delete(projectId);
  return owned;
}

function unwrapUnbound(wrapped: EncryptedPayload, keys: readonly Uint8Array[]): Uint8Array | null {
  for (const key of keys) {
    try {
      return unwrapKey(wrapped, key);
    } catch {
      // not this key
    }
  }
  return null;
}

/** A bound key opens only with the key its `kid` names; an unbound one tries each of `scopes`, `preferred` first. */
export function unwrapWithScopeKeys(
  wrapped: AttachmentKeyPayload,
  keyring: Keyring,
  scopes: readonly KeyScope[],
  attachmentId: string,
  preferred?: Uint8Array | null,
): Uint8Array | null {
  if (isWrappedAttachmentKey(wrapped)) {
    for (const scope of scopes) {
      const k = keysOfScope(keyring, scope).find((held) => held.keyId === wrapped.kid);
      if (!k) continue;
      try {
        return unwrapAttachmentKey(wrapped, k.key, scope, attachmentId);
      } catch {
        // not wrapped for this attachment in this scope
      }
    }
    return null;
  }
  const keys = scopes.flatMap((s) => keysOfScope(keyring, s).map((k) => k.key));
  return unwrapUnbound(wrapped, preferred ? [preferred, ...keys] : keys);
}

/** Reading only: never re-wrap the result under another scope's key. */
export function unwrapWithAnyKey(
  wrapped: AttachmentKeyPayload,
  keyring: Keyring,
  attachmentId: string,
  preferred?: Uint8Array | null,
): Uint8Array | null {
  if (isWrappedAttachmentKey(wrapped)) {
    const scopes: KeyScope[] =
      wrapped.kid === DEK_KEY_ID
        ? [PERSONAL]
        : keyring.projectsWithKey(wrapped.kid).map((projectId) => ({ kind: "project", projectId }));
    return unwrapWithScopeKeys(wrapped, keyring, scopes, attachmentId);
  }
  const keys = keyring.allKeys().map((k) => k.key);
  return unwrapUnbound(wrapped, preferred ? [preferred, ...keys] : keys);
}

export interface Repair {
  entity: EntityKind;
  entityId: string;
  field: string;
  ts: Hlc;
  value: unknown;
  /** `key`: non-canonical key or v1 format; `plaintext`: arrived unencrypted (until legacy migration is done). */
  reason: "key" | "plaintext";
  keyId?: string;
  scope?: KeyScope;
  version?: 1 | 2 | 3;
}

function mayRepairProject(store: Pick<ScopeStore, "list">, userId: string | undefined, r: Repair) {
  const rows = activeMembers(store, r.entityId);
  if (rows.length === 0) return true; // unshared: the caller's own project
  const mine = rows.find((e) => e.fields.user_id === userId);
  if (!mine) return false;
  if (r.field === "deleted_at" || r.field === "archived_at") return mine.fields.role === "owner";
  return mine.fields.role === "owner" || mine.fields.role === "editor";
}

/** A current value under a rotation-retired key is history and stays. */
export function confirmRepairs(
  store: ScopeStore,
  keyring: Keyring,
  userId: string | undefined,
  repairs: readonly Repair[],
): Repair[] {
  if (repairs.length === 0) return [];
  const shared = sharedProjectIds(store);
  return repairs.filter((r) => {
    if (r.reason === "key") {
      const desired = preferredKey(keyring, resolveScope(store, r.entity, r.entityId), shared);
      if (!desired || !r.scope || !sameKeyScope(desired.scope, r.scope)) return false;
      if (desired.keyId === r.keyId && (r.version === 2 || r.version === 3)) return false;
      if (
        (r.version === 2 || r.version === 3) &&
        r.keyId !== undefined &&
        r.scope.kind === "project" &&
        keyring.isRetired(r.scope.projectId, r.keyId)
      ) {
        return false;
      }
    }
    return r.entity !== "project" || mayRepairProject(store, userId, r);
  });
}

/** Skips fields whose winning write moved on. Returns the count written. */
export function applyRepairs(
  store: Pick<LocalStore, "fieldTs" | "rewriteField">,
  repairs: readonly Repair[],
): number {
  let written = 0;
  for (const r of repairs) {
    const current = store.fieldTs(r.entity, r.entityId, r.field);
    if (!current || compareHlc(current, r.ts) !== 0) continue;
    try {
      if (store.rewriteField(r.entity, r.entityId, r.field, r.value, successorHlc(r.ts))) written++;
    } catch (err) {
      console.warn(`[atlas-e2ee] could not repair ${r.entity}.${r.field} (${r.entityId}):`, err);
    }
  }
  return written;
}

export function openOptionsFor(entity: EntityKind, id: string, personalV1: boolean): OpenOptions {
  return { personalV1, v2Only: entity === "preference" && id === KEY_TRUST_ID };
}

/** Opens stored envelopes with the keys now held (keeping timestamps) and repairs the rest. */
export function reviveLockedValues(
  store: LocalStore,
  keyring: Keyring,
  userId?: string,
  personalV1 = true,
): { revived: number; repaired: number } {
  if (!keyring.hasKeys()) return { revived: 0, repaired: 0 };
  const shared = sharedProjectIds(store);
  const sole = userId ? soleOwnedProjects(store, userId) : new Set<string>();
  const revived = store.reviveLocked((entity, entityId, field, envelope) => {
    const expected = expectedKeyScope(keyring, resolveScope(store, entity, entityId), shared);
    return openFieldValue(keyring, envelope, { entity, entityId, field }, expected, {
      ...openOptionsFor(entity, entityId, personalV1),
      adoptPersonalV1: expected?.kind === "project" && sole.has(expected.projectId),
    });
  });
  // Values that arrived sealed (protocol 7) open with the keys of the scope they arrived in.
  const sealed = store.reviveSealed((wire, entityId, wireField, placeholder) =>
    openSealed(keyring, wire, entityId, wireField, placeholder.scope, placeholder),
  );
  const repairs = confirmRepairs(store, keyring, userId, [
    ...revived.map((r) => ({ ...r, reason: "key" as const })),
    ...sealed.map((r) => ({
      entity: r.entity,
      entityId: r.entityId,
      field: r.field,
      ts: r.ts,
      value: r.value,
      reason: "key" as const,
      keyId: r.keyId,
      scope: r.scope,
      version: 3 as const,
    })),
  ]);
  return { revived: revived.length + sealed.length, repaired: applyRepairs(store, repairs) };
}

type RescopeStore = Pick<
  LocalStore,
  "list" | "get" | "rawField" | "exists" | "visibleFieldStates" | "rewriteField"
>;

function isPayload(v: unknown): v is EncryptedPayload {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).iv === "string" &&
    typeof (v as Record<string, unknown>).ct === "string"
  );
}

function rewriteEntity(
  store: RescopeStore,
  entity: EntityKind,
  id: string,
  transform?: (field: string, value: unknown) => unknown,
): number {
  let written = 0;
  for (const { field, value, ts } of store.visibleFieldStates(entity, id)) {
    if (isEncryptedEnvelope(value)) continue; // nothing readable to re-encrypt
    const next = transform ? transform(field, value) : value;
    if (store.rewriteField(entity, id, field, next, successorHlc(ts))) written++;
  }
  return written;
}

function projectKeyScope(
  store: Pick<ScopeStore, "list">,
  keyring: Keyring,
  projectId: string | null | undefined,
): KeyScope {
  if (!projectId) return PERSONAL;
  const scope: Scope = { kind: "project", projectId };
  return expectedKeyScope(keyring, scope, sharedProjectIds(store)) ?? PERSONAL;
}

/** Whether moving from project `from` to `to` (null: none) changes key scope here. */
export function rescopeNeeded(
  store: Pick<ScopeStore, "list">,
  keyring: Keyring | null,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (!keyring?.hasKeys()) {
    const shared = (p: string | null | undefined) => !!p && isProjectShared(store, p);
    return shared(from) || shared(to);
  }
  return !sameKeyScope(projectKeyScope(store, keyring, from), projectKeyScope(store, keyring, to));
}

/**
 * Unwrapped only with keys of `from`, never every key held: a key the server copied in from another
 * project would otherwise be re-wrapped for this one's members. Only for user-started flows.
 */
export function rewrapAttachmentKey(
  store: RescopeStore,
  keyring: Keyring | null,
  attachmentId: string,
  wrapped: unknown,
  from: readonly KeyScope[],
): unknown {
  if (!keyring?.hasKeys() || !isPayload(wrapped)) return wrapped;
  const scope = resolveScope(store, "attachment", attachmentId);
  let target: ScopeKey;
  try {
    target = keyForScope(keyring, scope, sharedProjectIds(store));
  } catch (err) {
    if (!(err instanceof MissingScopeKey)) throw err;
    console.warn(`[atlas-e2ee] attachment ${attachmentId} keeps its old key: ${err.message}`);
    return wrapped;
  }
  const aek = unwrapWithScopeKeys(wrapped, keyring, [...from, target.scope], attachmentId);
  if (!aek) return wrapped;
  return wrapAttachmentKey(aek, target.key, target.keyId, target.scope, attachmentId);
}

/** Re-writes the task, its comments, activity and attachments under the new key. Only `fromProjectId`'s keys and the DEK may unwrap. */
export function rescopeTask(
  store: RescopeStore,
  keyring: Keyring | null,
  taskId: string,
  fromProjectId?: string | null,
): number {
  const from: KeyScope[] = [PERSONAL];
  if (keyring?.hasKeys() && fromProjectId) {
    const scope = projectKeyScope(store, keyring, fromProjectId);
    if (scope.kind === "project") from.push(scope);
  }
  let written = rewriteEntity(store, "task", taskId);
  for (const kind of ["comment", "activity"] as const) {
    for (const e of store.list(kind)) {
      if (e.fields.task_id === taskId) written += rewriteEntity(store, kind, e.id);
    }
  }
  for (const e of store.list("attachment")) {
    if (e.fields.task_id !== taskId) continue;
    written += rewriteEntity(store, "attachment", e.id, (field, value) =>
      field === "wrapped_key" ? rewrapAttachmentKey(store, keyring, e.id, value, from) : value,
    );
  }
  return written;
}

export function rescopeSection(
  store: RescopeStore,
  keyring: Keyring | null,
  sectionId: string,
  fromProjectId?: string | null,
): number {
  let written = rewriteEntity(store, "section", sectionId);
  for (const e of store.list("task")) {
    if (e.fields.section_id === sectionId) {
      written += rescopeTask(store, keyring, e.id, fromProjectId);
    }
  }
  return written;
}

/** On first share: re-write the project, sections and all tasks under the project key. */
export function rescopeProject(
  store: RescopeStore,
  keyring: Keyring | null,
  projectId: string,
): number {
  let written = rewriteEntity(store, "project", projectId);
  for (const e of store.list("section")) {
    if (e.fields.project_id === projectId) written += rewriteEntity(store, "section", e.id);
  }
  // Before its first share the project's content was personal: only the DEK unwraps.
  for (const e of store.list("task")) {
    if (e.fields.project_id === projectId) written += rescopeTask(store, keyring, e.id, null);
  }
  return written;
}
