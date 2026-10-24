/**
 * Local-first store. Entities are bags of fields resolved by field-level LWW over HLC (as on the
 * server). Local mutations stamp an HLC and enqueue an {@link Operation}; remote ops merge idempotently.
 *
 * What the sync decoder could not attribute to a real kind waits under its wire kind (sync protocol
 * 7): a value no key here opened ({@link SealedPlaceholder}, revived by {@link LocalStore.reviveSealed})
 * and a tombstone of an entity not seen yet, which the entity takes over when it arrives.
 */

import { isEncryptedEnvelope } from "./crypto/envelope";
import { HlcClock, compareHlc, type Hlc } from "./hlc";
import type { PersistedOp, Persistence } from "./persistence";
import type { EntityKind, Operation } from "./types";
import { isSealedPlaceholder, isSealedWireKind, type SealedPlaceholder } from "./wire";

interface FieldState {
  value: unknown;
  ts: Hlc;
  op: string;
}
interface EntityState {
  fields: Map<string, FieldState>;
  deleted: Hlc | null;
  deletedOp: string | null;
}

/** Superseded ops tolerated in the log before a hydrate compacts it (see `LocalStore.compact`). */
export const COMPACT_AFTER_SUPERSEDED = 1000;

/** The server's `MAX_FUTURE_SKEW_MS`: a later timestamp would pin the clock and get every local op refused. */
export const MAX_CLOCK_DRIFT_MS = 5 * 60_000;

export interface ResolvedEntity {
  id: string;
  fields: Record<string, unknown>;
}

/** Constant unless the device clock is set. Null without a monotonic clock. */
function monotonicAnchor(): number | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? Date.now() - perf.now() : null;
}

export interface RevivedField {
  entity: EntityKind;
  entityId: string;
  field: string;
  ts: Hlc;
  value: unknown;
  keyId: string;
}

export interface LocalStoreOptions {
  now?: () => number;
  newId?: () => string;
  /** Without it the store is in-memory. */
  persistence?: Persistence;
  onPersistError?: (err: unknown) => void;
  compactAfter?: number;
}

/** Ops are still not in the durable log; the sync cursor must not move past them. */
export class PersistError extends Error {
  constructor(
    readonly unsaved: number,
    readonly reason: unknown,
  ) {
    super(
      `${unsaved} change(s) could not be saved on this device: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = "PersistError";
  }
}

export class LocalStore {
  private readonly clock: HlcClock;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly entities = new Map<EntityKind, Map<string, EntityState>>();
  private readonly kindChanged = new Map<EntityKind, number>();
  private changeSeq = 0;
  private resetSeq = 0;
  private readonly outbox = new Map<string, Operation>();
  private readonly applied = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly persistence: Persistence | null;
  private readonly onPersistError?: (err: unknown) => void;
  private writeChain: Promise<void> = Promise.resolve();
  /** Ops whose durable write failed. `applied` already holds their ids, so a re-delivery is skipped. */
  private readonly unsaved = new Map<string, PersistedOp>();
  /** Ops `restampAhead` re-stamped whose rows may still hold the old stamp; `flush` retries them. */
  private readonly restamped = new Map<string, Operation>();
  /** The newest stamp of the ops the server holds that this store has seen: pulled or acknowledged. */
  private acknowledged: Hlc | null = null;
  private lastPersistError: unknown = null;
  private readonly compactAfter: number;
  private batching = false;
  private readonly wallClock: () => number;
  private clockOffset = 0;
  private clockAnchor: number | null = null;
  private warnedDrift = false;

  constructor(node: string, opts: LocalStoreOptions = {}) {
    this.clock = new HlcClock(node);
    this.wallClock = opts.now ?? Date.now;
    this.now = () => this.wallClock() + this.currentClockOffset();
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.persistence = opts.persistence ?? null;
    this.onPersistError = opts.onPersistError;
    this.compactAfter = opts.compactAfter ?? COMPACT_AFTER_SUPERSEDED;
  }

  /** Call once, before listeners and sync. */
  async hydrate(): Promise<void> {
    if (!this.persistence) return;
    const persisted = (await this.persistence.load()).filter(({ op }) => {
      if (isWellFormedOp(op)) return true;
      // One bad row must not keep the whole log from loading.
      console.warn("[atlas] skipped a malformed op in the local log:", op);
      return false;
    });
    for (const { op, synced } of persisted) {
      this.observe(op.ts);
      if (synced) this.noteAcknowledged(op.ts);
      const changed = this.merge(op);
      if (changed && !synced) this.outbox.set(op.id, op);
    }
    // Once most of the log is superseded, rewrite it to what the state needs.
    if (this.supersededIn(persisted).length >= this.compactAfter) await this.compact(persisted);
  }

  /** An entity with unsynced ops keeps its whole history: the server may refuse those (see `discard`). */
  private supersededIn(persisted: PersistedOp[]): string[] {
    const keep = this.winningOps();
    const pending = new Set<string>();
    for (const op of this.outbox.values()) pending.add(`${op.entity}:${op.entityId}`);
    return persisted
      .filter(
        ({ op, synced }) =>
          synced && !keep.has(op.id) && !pending.has(`${op.entity}:${op.entityId}`),
      )
      .map(({ op }) => op.id);
  }

  /** Skipped while a write is failing: a superseded op may be the only copy on disk. */
  async compact(persisted?: PersistedOp[]): Promise<number> {
    const p = this.persistence;
    if (!p?.compact || this.unsaved.size > 0) return 0;
    await this.writeChain;
    const drop = this.supersededIn(persisted ?? (await p.load()));
    if (drop.length === 0) return 0;
    // A dropped op that is delivered again only loses to the write that beat it once more.
    for (const id of drop) this.applied.delete(id);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await p.compact!(drop);
      } catch (err) {
        this.reportPersistError(err);
      }
    });
    await this.writeChain;
    return drop.length;
  }

  /** The ids of the ops the current state is built from: each field's winner and each tombstone. */
  private winningOps(): Set<string> {
    const keep = new Set<string>();
    for (const state of this.allStates()) {
      for (const fs of state.fields.values()) keep.add(fs.op);
      if (state.deletedOp) keep.add(state.deletedOp);
    }
    return keep;
  }

  /**
   * For a store with no server (local-only mode): drop every op, unsynced ones included, that the
   * current state no longer needs. `compact` keeps unsynced history because the server may refuse
   * part of it; with no server nothing is ever refused, so without this the log would keep every
   * edit forever, and an account created later would push all of it. Skipped while a write is
   * failing, and on a backend that cannot delete. Returns how many ops were dropped.
   */
  async compactLocal(): Promise<number> {
    const p = this.persistence;
    if (!p?.deleteOps || this.unsaved.size > 0) return 0;
    await this.writeChain;
    const keep = this.winningOps();
    const drop = (await p.load()).map(({ op }) => op.id).filter((id) => !keep.has(id));
    if (drop.length === 0) return 0;
    for (const id of drop) {
      this.outbox.delete(id);
      this.applied.delete(id);
    }
    this.writeChain = this.writeChain.then(async () => {
      try {
        await p.deleteOps!(drop);
      } catch (err) {
        this.reportPersistError(err);
      }
    });
    await this.writeChain;
    return drop.length;
  }

  /** Keeps the unsynced outbox so local edits never vanish; durable in one step with the cursor reset. */
  async resetSynced(): Promise<void> {
    this.entities.clear();
    this.applied.clear();
    this.resetSeq = ++this.changeSeq;
    const wasBatching = this.batching;
    this.batching = true;
    try {
      for (const op of this.outbox.values()) this.merge(op);
    } finally {
      this.batching = wasBatching;
    }
    for (const [id, entry] of this.unsaved) if (entry.synced) this.unsaved.delete(id);
    const p = this.persistence;
    const outcome: { failed: boolean; err?: unknown } = { failed: false };
    if (p) {
      const keep = [...this.outbox.values()];
      this.writeChain = this.writeChain.then(async () => {
        try {
          if (p.clearSynced) return await p.clearSynced();
          await p.clear?.();
          for (const op of keep) await p.append(op, false);
        } catch (err) {
          outcome.failed = true;
          outcome.err = err;
          this.reportPersistError(err);
        }
      });
    }
    this.emit();
    await this.flush();
    if (outcome.failed) throw outcome.err;
  }

  /** Stamp new ops by the server's clock after a fast-clock refusal; the offset is dropped if the device clock is set since. */
  /** Beyond {@link MAX_CLOCK_DRIFT_MS} ahead the op still merges; only the clock does not follow. */
  private observe(ts: Hlc): void {
    const now = this.now();
    if (ts.wallMs > now + MAX_CLOCK_DRIFT_MS) {
      if (!this.warnedDrift) {
        this.warnedDrift = true;
        console.warn(
          `[atlas] ignoring a timestamp ${ts.wallMs - now} ms in the future for the clock`,
        );
      }
      return;
    }
    this.clock.update(ts, now);
  }

  alignClock(serverTimeMs: number): number {
    this.clockOffset = serverTimeMs - this.wallClock();
    this.clockAnchor = monotonicAnchor();
    return this.clockOffset;
  }

  private noteAcknowledged(ts: Hlc): void {
    if (this.acknowledged === null || compareHlc(ts, this.acknowledged) > 0)
      this.acknowledged = { ...ts };
  }

  /**
   * After a `clock_skew` refusal, once `alignClock` has run: gives the unsynced ops stamped past
   * `serverTimeMs` + {@link MAX_CLOCK_DRIFT_MS} new stamps from the corrected clock, and winds the
   * clock back. The server never accepted those ops, even in a push whose answer was lost, so they
   * keep their ids. They are stamped in their old order above a floor (every op the server holds
   * that this store has seen, and the unsynced ops left alone), so each still beats exactly the
   * ops it beat before: no value in the read model changes, only the stamps the re-stamped ops
   * hold there. Returns how many ops were re-stamped; a second call changes nothing.
   */
  restampAhead(serverTimeMs: number): number {
    // A log that cannot take the new stamps would reload the old ones, as acknowledged.
    if (this.persistence && !this.persistence.restamp) return 0;
    const limit = serverTimeMs + MAX_CLOCK_DRIFT_MS;
    const ahead: Operation[] = [];
    let floor = this.acknowledged;
    for (const op of this.outbox.values()) {
      if (op.ts.wallMs > limit) ahead.push(op);
      else if (floor === null || compareHlc(op.ts, floor) > 0) floor = op.ts;
    }
    if (ahead.length === 0 && this.clock.current().wallMs <= limit) return 0;
    // The server accepted every acknowledged op by an earlier reading of its clock, so the floor is
    // within the limit unless that clock went back. Then no stamp the server takes beats it.
    if (floor !== null && floor.wallMs > limit) return 0;
    this.clock.rewind(floor ?? { wallMs: 0, counter: 0, node: "" });
    if (ahead.length === 0) return 0;

    ahead.sort((a, b) => compareHlc(a.ts, b.ts));
    const now = this.now();
    const ops = ahead.map((op): Operation => ({ ...op, ts: this.clock.now(now) }));
    for (const op of ops) {
      this.outbox.set(op.id, op);
      const unsaved = this.unsaved.get(op.id);
      if (unsaved) unsaved.op = op;
      if (this.persistence) this.restamped.set(op.id, op);
      const state = this.state(op.entity, op.entityId);
      if (op.op === "delete") {
        if (state?.deletedOp === op.id) state.deleted = op.ts;
      } else {
        const fs = state?.fields.get(op.field);
        if (fs?.op === op.id) fs.ts = op.ts;
      }
      this.kindChanged.set(op.entity, ++this.changeSeq);
    }
    this.writeRestamps();
    this.emit();
    return ops.length;
  }

  private writeRestamps(): void {
    const p = this.persistence;
    if (!p?.restamp) return;
    this.writeChain = this.writeChain.then(async () => {
      const ops = [...this.restamped.values()];
      if (ops.length === 0) return;
      try {
        await p.restamp!(ops);
        for (const op of ops) if (this.restamped.get(op.id) === op) this.restamped.delete(op.id);
      } catch (err) {
        this.reportPersistError(err);
      }
    });
  }

  private currentClockOffset(): number {
    if (this.clockOffset === 0) return 0;
    const anchor = monotonicAnchor();
    if (
      anchor !== null &&
      this.clockAnchor !== null &&
      Math.abs(anchor - this.clockAnchor) > 60_000
    ) {
      this.clockOffset = 0;
      this.clockAnchor = null;
    }
    return this.clockOffset;
  }

  /** Failed writes are retried first; rejects with {@link PersistError}, and the caller must keep its cursor. */
  async flush(): Promise<void> {
    await this.writeChain;
    if (this.unsavedCount() === 0) return;
    const p = this.persistence;
    if (p) {
      this.writeChain = this.writeChain.then(async () => {
        for (const synced of [false, true]) {
          const ops = [...this.unsaved.values()]
            .filter((e) => e.synced === synced)
            .map((e) => e.op);
          if (ops.length === 0) continue;
          try {
            await appendOps(p, ops, synced);
            for (const op of ops) this.unsaved.delete(op.id);
          } catch (err) {
            this.reportPersistError(err);
          }
        }
      });
      this.writeRestamps();
      await this.writeChain;
    }
    const failed = this.unsavedCount();
    if (failed > 0) throw new PersistError(failed, this.lastPersistError);
  }

  /** Ops whose write failed, a new stamp from `restampAhead` included. */
  unsavedCount(): number {
    let n = this.unsaved.size;
    for (const id of this.restamped.keys()) if (!this.unsaved.has(id)) n++;
    return n;
  }

  private reportPersistError(err: unknown): void {
    this.lastPersistError = err;
    this.onPersistError?.(err);
  }

  private persist(op: Operation, synced: boolean): void {
    this.persistBatch([op], synced);
  }

  private persistBatch(ops: Operation[], synced: boolean): void {
    const p = this.persistence;
    if (!p || ops.length === 0) return;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await appendOps(p, ops, synced);
      } catch (err) {
        for (const op of ops) {
          const known = this.unsaved.get(op.id);
          this.unsaved.set(op.id, { op, synced: synced || known?.synced === true });
        }
        this.reportPersistError(err);
      }
    });
  }

  /** Must be a valid UUID (a malformed `entity_id` 422s the whole push); Hermes lacks `crypto.randomUUID()`. */
  newEntityId(): string {
    return this.newId();
  }

  set(entity: EntityKind, entityId: string, field: string, value: unknown): Operation {
    const op: Operation = {
      id: this.newId(),
      entity,
      entityId,
      ts: this.clock.now(this.now()),
      op: "set",
      field,
      value,
    };
    this.merge(op);
    this.outbox.set(op.id, op);
    this.persist(op, false);
    return op;
  }

  /** Returns null when `ts` does not beat the current value. */
  rewriteField(
    entity: EntityKind,
    entityId: string,
    field: string,
    value: unknown,
    ts: Hlc,
  ): Operation | null {
    const op: Operation = { id: this.newId(), entity, entityId, ts, op: "set", field, value };
    this.observe(ts);
    if (!this.merge(op)) return null;
    this.outbox.set(op.id, op);
    this.persist(op, false);
    return op;
  }

  remove(entity: EntityKind, entityId: string): Operation {
    const op: Operation = {
      id: this.newId(),
      entity,
      entityId,
      ts: this.clock.now(this.now()),
      op: "delete",
    };
    this.merge(op);
    this.outbox.set(op.id, op);
    this.persist(op, false);
    return op;
  }

  /** Idempotent; enqueues nothing. */
  applyRemote(op: Operation): boolean {
    this.observe(op.ts);
    this.noteAcknowledged(op.ts);
    this.noteDelivered(op);
    const fresh = !this.applied.has(op.id);
    const changed = this.merge(op);
    if (changed || (fresh && this.shadowedByOutbox(op))) this.persist(op, true);
    return changed;
  }

  /** Stored anyway: if the local op is discarded for good, `op` is the fallback. */
  private shadowedByOutbox(op: Operation): boolean {
    const state = this.state(op.entity, op.entityId);
    const winner = op.op === "delete" ? state?.deletedOp : state?.fields.get(op.field)?.op;
    return winner != null && this.outbox.has(winner);
  }

  /** `merge` skips it as applied, so make the retry store it, now as synced. */
  private noteDelivered(op: Operation): void {
    const entry = this.unsaved.get(op.id);
    if (entry) entry.synced = true;
  }

  /** One change notification, so a backfill never paints intermediate states. */
  applyRemoteBatch(ops: Operation[]): boolean {
    const wasBatching = this.batching;
    this.batching = true;
    let changed = false;
    const changedOps: Operation[] = [];
    try {
      for (const op of ops) {
        this.observe(op.ts);
        this.noteAcknowledged(op.ts);
        this.noteDelivered(op);
        const fresh = !this.applied.has(op.id);
        if (this.merge(op)) {
          changed = true;
          changedOps.push(op);
        } else if (fresh && this.shadowedByOutbox(op)) {
          changedOps.push(op);
        }
      }
    } finally {
      this.batching = wasBatching;
    }
    if (changedOps.length > 0) {
      this.persistBatch(changedOps, true);
    }
    if (changed && !this.batching) this.emit();
    return changed;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    if (this.batching) return; // coalesced by applyRemoteBatch, which emits once at the end
    for (const listener of this.listeners) listener();
  }

  private merge(op: Operation): boolean {
    if (this.applied.has(op.id)) return false;
    this.applied.add(op.id);
    const changed = this.mergeInto(op);
    if (changed) this.emit();
    return changed;
  }

  private mergeInto(op: Operation): boolean {
    let byId = this.entities.get(op.entity);
    if (!byId) {
      byId = new Map();
      this.entities.set(op.entity, byId);
    }
    let state = byId.get(op.entityId);
    if (!state) {
      state = { fields: new Map(), deleted: null, deletedOp: null };
      if (!isSealedWireKind(op.entity)) this.inheritTombstone(op.entityId, state);
      byId.set(op.entityId, state);
    }

    let changed: boolean;
    if (op.op === "delete") {
      changed = state.deleted === null || compareHlc(op.ts, state.deleted) > 0;
      if (changed) {
        state.deleted = op.ts;
        state.deletedOp = op.id;
      }
    } else {
      const existing = state.fields.get(op.field);
      const order = existing ? compareHlc(op.ts, existing.ts) : 1;
      // At an equal timestamp a readable value replaces an envelope (the same write, opened), so a
      // revived value survives a reload.
      changed =
        order > 0 ||
        (order === 0 && isEncryptedEnvelope(existing!.value) && !isEncryptedEnvelope(op.value));
      if (changed) state.fields.set(op.field, { value: op.value, ts: op.ts, op: op.id });
    }

    if (changed) this.kindChanged.set(op.entity, ++this.changeSeq);
    return changed;
  }

  /** A tombstone that arrived before its entity's kind was known, now the entity's. */
  private inheritTombstone(entityId: string, state: EntityState): void {
    for (const [kind, byId] of this.entities) {
      if (!isSealedWireKind(kind)) continue;
      const pending = byId.get(entityId);
      if (!pending?.deleted) continue;
      if (state.deleted === null || compareHlc(pending.deleted, state.deleted) > 0) {
        state.deleted = pending.deleted;
        state.deletedOp = pending.deletedOp;
      }
    }
  }

  /** The real kind of the entity held by this id, or null. */
  kindOf(entityId: string): EntityKind | null {
    for (const [kind, byId] of this.entities) {
      if (!isSealedWireKind(kind) && byId.has(entityId)) return kind;
    }
    return null;
  }

  private state(entity: EntityKind, entityId: string): EntityState | undefined {
    return this.entities.get(entity)?.get(entityId);
  }

  private *allStates(): Iterable<EntityState> {
    for (const byId of this.entities.values()) yield* byId.values();
  }

  revision(entity: EntityKind): number {
    return Math.max(this.kindChanged.get(entity) ?? 0, this.resetSeq);
  }

  get(entity: EntityKind, entityId: string): Record<string, unknown> | null {
    const state = this.state(entity, entityId);
    if (!state) return null;
    const visible = this.visibleFields(state);
    if (state.deleted !== null && Object.keys(visible).length === 0) return null;
    return visible;
  }

  list(entity: EntityKind): ResolvedEntity[] {
    const out: ResolvedEntity[] = [];
    for (const [id, state] of this.entities.get(entity) ?? []) {
      const visible = this.visibleFields(state);
      if (state.deleted !== null && Object.keys(visible).length === 0) continue;
      out.push({ id, fields: visible });
    }
    return out;
  }

  isEmpty(): boolean {
    for (const byId of this.entities.values()) if (byId.size > 0) return false;
    return true;
  }

  exists(entity: EntityKind, entityId: string): boolean {
    return this.state(entity, entityId) !== undefined;
  }

  rawField(entity: EntityKind, entityId: string, field: string): unknown {
    return this.state(entity, entityId)?.fields.get(field)?.value;
  }

  fieldTs(entity: EntityKind, entityId: string, field: string): Hlc | null {
    const state = this.state(entity, entityId);
    const fs = state?.fields.get(field);
    if (!state || !fs) return null;
    if (state.deleted !== null && compareHlc(fs.ts, state.deleted) <= 0) return null;
    return { ...fs.ts };
  }

  /** The entity's tombstone stamp, or null. */
  tombstoneTs(entity: EntityKind, entityId: string): Hlc | null {
    const deleted = this.state(entity, entityId)?.deleted;
    return deleted ? { ...deleted } : null;
  }

  visibleFieldStates(
    entity: EntityKind,
    entityId: string,
  ): { field: string; value: unknown; ts: Hlc }[] {
    const state = this.state(entity, entityId);
    if (!state) return [];
    const out: { field: string; value: unknown; ts: Hlc }[] = [];
    for (const [field, fs] of state.fields) {
      if (state.deleted === null || compareHlc(fs.ts, state.deleted) > 0)
        out.push({ field, value: fs.value, ts: { ...fs.ts } });
    }
    return out;
  }

  lockedCount(): number {
    let n = 0;
    for (const state of this.allStates()) {
      for (const fs of state.fields.values()) {
        if (!isEncryptedEnvelope(fs.value)) continue;
        if (state.deleted === null || compareHlc(fs.ts, state.deleted) > 0) n++;
      }
    }
    return n;
  }

  /** An opened value replaces the envelope at the same timestamp, so nothing is pushed. */
  reviveLocked<O extends { value: unknown; keyId: string }>(
    open: (entity: EntityKind, entityId: string, field: string, envelope: unknown) => O | null,
  ): (O & RevivedField)[] {
    const revived: (O & RevivedField)[] = [];
    const ops: Operation[] = [];
    for (const [entity, byId] of this.entities) {
      if (isSealedWireKind(entity)) continue; // reviveSealed opens these
      for (const [entityId, state] of byId) {
        for (const [field, fs] of state.fields) {
          if (!isEncryptedEnvelope(fs.value)) continue;
          const opened = open(entity, entityId, field, fs.value);
          if (!opened) continue;
          const op: Operation = {
            id: this.newId(),
            entity,
            entityId,
            ts: { ...fs.ts },
            op: "set",
            field,
            value: opened.value,
          };
          fs.value = opened.value;
          fs.op = op.id;
          this.applied.add(op.id);
          ops.push(op);
          revived.push({ ...opened, entity, entityId, field, ts: { ...fs.ts } });
          this.kindChanged.set(entity, ++this.changeSeq);
        }
      }
    }
    if (ops.length > 0) {
      this.persistBatch(ops, true);
      this.emit();
    }
    return revived;
  }

  /**
   * Opens the values that arrived sealed under a wire kind (protocol 7) with the keys now held:
   * each becomes its real kind's field at the same timestamp, and the sealed copy goes. Nothing is
   * pushed.
   */
  reviveSealed<O extends { kind: EntityKind; field: string; value: unknown; keyId: string }>(
    open: (
      wire: string,
      entityId: string,
      wireField: string,
      sealed: SealedPlaceholder,
    ) => O | null,
  ): (O & RevivedField)[] {
    const revived: (O & RevivedField)[] = [];
    const ops: Operation[] = [];
    const gone: string[] = [];
    for (const [wire, byId] of this.entities) {
      if (!isSealedWireKind(wire)) continue;
      for (const [entityId, state] of byId) {
        for (const [wireField, fs] of state.fields) {
          if (!isSealedPlaceholder(fs.value)) continue;
          const opened = open(wire, entityId, wireField, fs.value);
          if (!opened) continue;
          state.fields.delete(wireField);
          gone.push(fs.op);
          const op: Operation = {
            id: this.newId(),
            entity: opened.kind,
            entityId,
            ts: { ...fs.ts },
            op: "set",
            field: opened.field,
            value: opened.value,
          };
          this.applied.add(op.id);
          if (this.mergeInto(op)) ops.push(op);
          revived.push({
            ...opened,
            entity: opened.kind,
            entityId,
            field: opened.field,
            ts: { ...fs.ts },
          });
        }
        if (state.fields.size === 0 && state.deleted === null) byId.delete(entityId);
      }
    }
    if (ops.length > 0) this.persistBatch(ops, true);
    const p = this.persistence;
    if (p?.deleteOps && gone.length > 0) {
      this.writeChain = this.writeChain
        .then(() => p.deleteOps!(gone))
        .catch((err) => this.reportPersistError(err));
    }
    if (revived.length > 0) this.emit();
    return revived;
  }

  private visibleFields(state: EntityState): Record<string, unknown> {
    const visible: Record<string, unknown> = {};
    for (const [name, fs] of state.fields) {
      if (state.deleted === null || compareHlc(fs.ts, state.deleted) > 0) visible[name] = fs.value;
    }
    return visible;
  }

  unsyncedOps(): Operation[] {
    return [...this.outbox.values()];
  }

  /** Rebuilds their entities from the remaining ops so they stop masking the server's values. */
  discard(opIds: Iterable<string>): void {
    const ids = new Set(opIds);
    const touched = new Map<EntityKind, Set<string>>();
    for (const id of ids) {
      const op = this.outbox.get(id);
      this.unsaved.delete(id);
      this.restamped.delete(id);
      if (!op) continue;
      this.outbox.delete(id);
      const state = this.state(op.entity, op.entityId);
      if (op.op === "delete" && state?.deletedOp === op.id) {
        state.deleted = null;
        state.deletedOp = null;
      } else if (op.op === "set" && state?.fields.get(op.field)?.op === op.id) {
        state.fields.delete(op.field);
      }
      const byKind = touched.get(op.entity) ?? new Set<string>();
      touched.set(op.entity, byKind);
      byKind.add(op.entityId);
      this.kindChanged.set(op.entity, ++this.changeSeq);
    }
    if (touched.size === 0) return;
    const p = this.persistence;
    if (!p) {
      this.dropEmpty(touched);
      this.emit();
      return;
    }
    this.emit();
    this.writeChain = this.writeChain.then(async () => {
      try {
        if (p.deleteOps) await p.deleteOps([...ids]);
        // A backend that cannot delete keeps them, acknowledged, so they are not pushed again.
        else await p.markSynced([...ids]);
        const rows = await p.load();
        const replay = [
          ...rows.map((r) => r.op),
          ...[...this.unsaved.values()].map((e) => e.op),
        ].filter((op) => !ids.has(op.id) && touched.get(op.entity)?.has(op.entityId));
        for (const op of replay) this.mergeInto(op);
        this.dropEmpty(touched);
        for (const kind of touched.keys()) this.kindChanged.set(kind, ++this.changeSeq);
        this.emit();
      } catch (err) {
        this.reportPersistError(err);
      }
    });
  }

  private dropEmpty(entities: Map<EntityKind, Set<string>>): void {
    for (const [kind, ids] of entities) {
      const byId = this.entities.get(kind);
      for (const id of ids) {
        const state = byId?.get(id);
        if (state && state.fields.size === 0 && state.deleted === null) byId!.delete(id);
      }
    }
  }

  markSynced(opIds: Iterable<string>): void {
    const done = new Set(opIds);
    for (const id of done) {
      const op = this.outbox.get(id);
      if (op) this.noteAcknowledged(op.ts);
      this.outbox.delete(id);
    }
    for (const id of done) {
      const entry = this.unsaved.get(id);
      if (entry) entry.synced = true;
    }
    const p = this.persistence;
    if (p && done.size > 0) {
      const ids = [...done];
      // A failure only leaves the rows unsynced: they are pushed again, which the server ignores.
      this.writeChain = this.writeChain
        .then(() => p.markSynced(ids))
        .catch((err) => this.reportPersistError(err));
    }
  }
}

/** Whether `op` has the shape of an {@link Operation} (a row read from disk or a file may not). */
export function isWellFormedOp(op: unknown): op is Operation {
  const o = op as Partial<Operation> | null | undefined;
  const ts = o?.ts as Partial<Hlc> | undefined;
  return (
    typeof o?.id === "string" &&
    typeof o.entity === "string" &&
    typeof o.entityId === "string" &&
    typeof ts?.wallMs === "number" &&
    typeof ts.counter === "number" &&
    typeof ts.node === "string" &&
    (o.op === "delete" || (o.op === "set" && typeof (o as { field?: unknown }).field === "string"))
  );
}

async function appendOps(p: Persistence, ops: Operation[], synced: boolean): Promise<void> {
  if (typeof p.appendBatch === "function") await p.appendBatch(ops, synced);
  else for (const op of ops) await p.append(op, synced);
}
