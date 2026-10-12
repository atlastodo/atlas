/**
 * Pushes the outbox, then pulls and applies ops after the cursor; both paths are idempotent.
 * A payload covers `(from, cursor]`: the cursor moves only if we already hold everything up to
 * `from`. Realtime only speeds delivery up; the poll stays authoritative.
 */

import { ApiError, E2eeLockedError, UpgradeRequiredError, apiErrorCode } from "./api";
import { RealtimeClient, WS_CLOSE, type RealtimeSocket } from "./realtime";
import type { BootstrapProgress, PageRepairs } from "./persistence";
import { applyRepairs, type Repair } from "./scope";
import type { LocalStore } from "./store";
import type { Operation } from "./types";

/** Ops per push request; the server caps a push by body size and op count. */
export const MAX_PUSH_OPS = 500;

/** Estimated bytes per push request; the server answers 413 over its cap (2 MiB by default). */
export const MAX_PUSH_BYTES = 1.5 * 1024 * 1024;

/** UTF-8 length of `s` without allocating (TextEncoder is not on every React Native engine). */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a surrogate pair is one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

/** Estimated wire size: UTF-8 JSON plus a third for base64, key id and nonce. */
function estimateWireBytes(op: Operation): number {
  return Math.ceil((utf8Length(JSON.stringify(op)) * 4) / 3) + 256;
}

export class PushTooLargeError extends ApiError {
  constructor(
    readonly op: Operation,
    cause: unknown,
  ) {
    const kb = Math.round(estimateWireBytes(op) / 1024);
    super(
      413,
      `This change is too large to sync (about ${kb} KB, more than the server accepts in one request).`,
      cause instanceof ApiError ? cause.data : undefined,
    );
    this.name = "PushTooLargeError";
  }
}

/**
 * A push failure rejected identically on every retry (403, 400/422): the op is bisected out and
 * quarantined. Not 401, and not a locked keyring, which would discard edits.
 */
function isPermanentPushError(err: unknown): boolean {
  if (err instanceof E2eeLockedError) return false;
  if (isClockSkew(err)) return false;
  return (
    err instanceof ApiError && (err.status === 400 || err.status === 403 || err.status === 422)
  );
}

/** 400 `clock_skew`: this clock runs fast. Never quarantined. */
function isClockSkew(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 400 && apiErrorCode(err) === "clock_skew";
}

function isCursorExpired(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 410) return false;
  const code = apiErrorCode(err);
  return code === undefined || code === "cursor_expired";
}

/** A snapshot page request failed on its resume token (400); the walk restarts from page one. */
function isBadSnapshotToken(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400;
}

function isSnapshotUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export interface SyncTransport {
  syncPush(
    ops: Operation[],
  ): Promise<{ cursor: number; applied: number; from?: number; deferred?: string[] }>;
  syncPull(since: number): Promise<{ operations: Operation[]; cursor: number; repairs?: Repair[] }>;
  /** `next` absent means drained. Without it the legacy replay runs. */
  syncSnapshot?(next?: string): Promise<{
    operations: Operation[];
    cursor: number;
    next?: string;
    repairs?: Repair[];
  }>;
  /** Without it WS payloads are ignored. */
  decodeWirePayload?(payload: unknown): {
    operations: Operation[];
    cursor: number;
    /** The seq the payload follows on from; absent means its continuity is unknown (a gap). */
    from?: number;
    repairs?: Repair[];
  };
  confirmRepairs?(repairs: Repair[]): Repair[];
}

type SnapshotPage = Awaited<ReturnType<NonNullable<SyncTransport["syncSnapshot"]>>>;

export type SyncStatus = "idle" | "syncing" | "offline" | "throttled" | "live-ws";

export const THROTTLE_BASE_MS = 5_000;
export const THROTTLE_MAX_MS = 5 * 60_000;

function isRateLimited(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 429;
}

export interface SyncRealtimeOptions {
  /** One connect attempt (fresh ticket, backfill cursor); null while signed out. */
  url: (since: number) => Promise<string | null>;
  socketFactory?: (url: string) => RealtimeSocket;
}

export interface SyncClientOptions {
  cursor?: number;
  onCursor?: (cursor: number) => void;
  /** Cursor 0: continue the walk there; above 0: the walk ended and only the repairs are used. */
  bootstrap?: BootstrapProgress | null;
  /** Called after each flushed page; null once the repairs are written or the walk is abandoned. */
  onBootstrapProgress?: (progress: BootstrapProgress | null, page?: PageRepairs) => void;
  onStatus?: (status: SyncStatus) => void;
  onSynced?: (result: SyncResult) => void;
  onError?: (err: unknown) => void;
  onQuarantine?: (op: Operation, err: unknown) => void;
  /** Omit for polling only. The poll reconciles messages the hub dropped for a lagging device. */
  realtime?: SyncRealtimeOptions;
  onRemoteApplied?: (ops: Operation[]) => void;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  cursor: number;
  deferred: number;
  repaired: number;
  skipped?: "halted" | "throttled";
}

export class SyncClient {
  private cursor: number;
  private inFlight: Promise<SyncResult> | null = null;
  private status: SyncStatus = "idle";
  private initialSyncDone = false;
  private firstCycleDone = false;
  private realtime: RealtimeClient | null = null;
  private realtimeLive = false;
  private halted = false;
  private deferredIds = new Set<string>();
  private cycleRepairs: Repair[] = [];
  private realtimeQueue: unknown[] = [];
  private realtimeDraining = false;
  /** A cycle was requested while one was in flight (a gap it may predate): run another after it. */
  private rerunRequested = false;
  /** The server revoked this session's socket (4403): realtime stays off; auth ends the session. */
  private realtimeRevoked = false;
  /** `dispose()` was called: realtime stays down even when a cycle in flight completes later. */
  private disposed = false;
  /** No replay position (fresh device or reset cursor); cleared once a walk completes. */
  private needsBootstrap: boolean;
  private bootstrapProgress: BootstrapProgress | null;
  /** Repairs from the current snapshot walk; applied when it finishes. */
  private walkRepairs: Repair[];
  private walkFinished: boolean;
  private resetRequested = false;
  private resetting: Promise<SyncResult> | null = null;
  private throttledUntil = 0;
  private throttleStreak = 0;
  private clockSkew: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;

  constructor(
    private readonly store: LocalStore,
    private readonly transport: SyncTransport,
    private readonly opts: SyncClientOptions = {},
  ) {
    this.cursor = opts.cursor ?? 0;
    this.initialSyncDone = this.cursor > 0;
    this.needsBootstrap = this.cursor === 0;
    this.bootstrapProgress = this.cursor === 0 ? (opts.bootstrap ?? null) : null;
    this.walkRepairs = [...(opts.bootstrap?.repairs ?? [])];
    // Stored progress next to a cursor above 0: the walk ended, but not the cycle that writes its
    // repairs.
    this.walkFinished = this.cursor > 0 && opts.bootstrap != null;
  }

  currentCursor(): number {
    return this.cursor;
  }

  currentStatus(): SyncStatus {
    return this.status;
  }

  deferredCount(): number {
    return this.deferredIds.size;
  }

  clockSkewMs(): number | null {
    return this.clockSkew;
  }

  isRealtimeLive(): boolean {
    return this.realtimeLive;
  }

  hasPendingPush(): boolean {
    return this.store.unsyncedOps().some((o) => !this.deferredIds.has(o.id));
  }

  dispose(): void {
    this.disposed = true;
    this.teardownRealtime();
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  /**
   * Rebuild synced state from the snapshot, keeping the outbox. Drops state only once the first
   * page arrived, so an offline device keeps what it has.
   */
  resetAndBootstrap(): Promise<SyncResult> {
    this.resetting ??= this.runReset().finally(() => {
      this.resetting = null;
    });
    return this.resetting;
  }

  private async runReset(): Promise<SyncResult> {
    // A cycle already running predates the request: the rebuild is the next one, and only its
    // outcome answers the caller.
    while (this.inFlight) await this.inFlight.catch(() => {});
    // From here to `sync()` nothing awaits, so no other cycle can start in between.
    if (this.halted) return this.skippedResult("halted");
    this.resetRequested = true;
    return this.sync();
  }

  sync(): Promise<SyncResult> {
    if (this.halted) return Promise.resolve(this.skippedResult("halted"));
    if (this.inFlight) return this.inFlight;
    // Inside a rate-limit wait: asking again would only extend it. The resume timer runs the cycle.
    if (Date.now() < this.throttledUntil) return Promise.resolve(this.skippedResult("throttled"));
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.requestSync();
      }
    });
    return this.inFlight;
  }

  private skippedResult(skipped: SyncResult["skipped"]): SyncResult {
    return {
      pushed: 0,
      pulled: 0,
      cursor: this.cursor,
      deferred: this.deferredIds.size,
      repaired: 0,
      skipped,
    };
  }

  private throttle(err: ApiError): void {
    this.throttleStreak++;
    const backoff =
      this.throttleStreak > 1
        ? Math.min(THROTTLE_BASE_MS * 2 ** (this.throttleStreak - 2), THROTTLE_MAX_MS)
        : 0;
    const wait = Math.min(
      Math.max(err.retryAfterMs ?? THROTTLE_BASE_MS, backoff),
      2 * THROTTLE_MAX_MS,
    );
    this.throttledUntil = Date.now() + wait;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.requestSync();
    }, wait);
  }

  private requestSync(): void {
    if (this.halted || this.disposed) return;
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this.sync().catch(() => {});
  }

  private async run(): Promise<SyncResult> {
    // Taken by this cycle whatever happens to it: a rebuild that fails is reported to the one who
    // asked, not left to surprise a later cycle.
    const reset = this.resetRequested;
    this.resetRequested = false;
    try {
      // "syncing" only for real work: a push or the first sync (a large backfill). Empty polls stay
      // "idle" to avoid flicker.
      const unsynced = this.store.unsyncedOps();
      // Ops still waiting for a key are not work this cycle can do: no spinner for them alone.
      const fresh = unsynced.filter((o) => !this.deferredIds.has(o.id));
      if (fresh.length > 0 || !this.initialSyncDone || reset) this.setStatus("syncing");
      this.cycleRepairs = [];

      if (unsynced.length > 0) await this.pushOutbox(unsynced);

      // Fold the snapshot when we hold no replay position, then pull. The push runs first so outbox
      // ops of a reset cursor go out before re-download.
      let pulledOps: Operation[];
      try {
        pulledOps = await this.pullPhase(reset ? await this.resetFromServer() : null);
      } catch (err) {
        if (!isCursorExpired(err)) throw err;
        // Purged ops this device never received: a purged delete would leave a ghost, so rebuild
        // from the snapshot (since=0 is never refused).
        pulledOps = await this.pullPhase(await this.resetFromServer());
      }

      // Re-write values that arrived under the wrong key or unencrypted, then push them.
      const walkDone = this.walkFinished;
      const repaired = this.applyRepairs(
        walkDone ? [...this.walkRepairs, ...this.cycleRepairs] : this.cycleRepairs,
      );
      this.cycleRepairs = [];
      if (walkDone) {
        this.walkFinished = false;
        this.walkRepairs = [];
        this.saveBootstrapProgress(null);
      }
      if (repaired > 0) await this.pushOutbox(this.store.unsyncedOps());

      this.initialSyncDone = true;
      this.firstCycleDone = true;
      this.throttleStreak = 0;
      // The cursor is meaningful for a WS connect backfill only after the first successful cycle.
      this.ensureRealtime();
      this.setStatus(this.restingStatus());
      const result: SyncResult = {
        pushed: unsynced.length,
        pulled: pulledOps.length,
        cursor: this.cursor,
        deferred: this.deferredIds.size,
        repaired,
      };
      this.opts.onSynced?.(result);
      return result;
    } catch (err) {
      if (err instanceof UpgradeRequiredError) {
        this.halted = true;
        this.dispose();
      }
      // Leave the outbox intact so the next sync retries. A rate limit is not an outage: say so,
      // and wait it out rather than retry on every poll.
      if (isRateLimited(err)) {
        this.throttle(err);
        this.setStatus("throttled");
      } else {
        this.setStatus("offline");
      }
      this.opts.onError?.(err);
      throw err;
    }
  }

  /** Applies all pages at once so listeners render only the converged state. */
  private async pullPhase(firstPage: SnapshotPage | null): Promise<Operation[]> {
    if (this.needsBootstrap && (await this.bootstrapFromSnapshot(firstPage)) === null) {
      return this.replayFromZero();
    }

    // After a bootstrap this is the overlap pass from the walk's pinned cursor: it re-delivers
    // what was committed while pages streamed (idempotent).
    const since = this.cursor;
    const { ops, cursor } = await this.pullAll(since);

    // Orphaned cursor: the first pull starts above 0, brings nothing, and the store is empty (data
    // lost, cursor kept). Rebuild from the snapshot or replay; first cycle only.
    if (!this.firstCycleDone && since > 0 && ops.length === 0 && this.store.isEmpty()) {
      console.warn(
        "[atlas SyncClient] detected 0 entities with cursor > 0; rebuilding from the snapshot",
      );
      if ((await this.bootstrapFromSnapshot()) === null) return this.replayFromZero();
      const healed = await this.pullAll(this.cursor);
      await this.applyRemoteOps(healed.ops, this.cursor, healed.cursor);
      return healed.ops;
    }

    await this.applyRemoteOps(ops, since, cursor);
    return ops;
  }

  private async resetFromServer(): Promise<SnapshotPage | null> {
    let first: SnapshotPage | null = null;
    if (this.transport.syncSnapshot) {
      try {
        first = await this.transport.syncSnapshot();
      } catch (err) {
        if (!isSnapshotUnsupported(err)) throw err;
      }
    }
    await this.resetLocal();
    return first;
  }

  private async resetLocal(): Promise<void> {
    this.epoch++;
    this.teardownRealtime();
    this.realtimeQueue.length = 0;
    this.moveCursor(0);
    this.saveBootstrapProgress(null);
    this.walkRepairs = [];
    this.walkFinished = false;
    this.needsBootstrap = true;
    this.setStatus("syncing");
    await this.store.resetSynced();
  }

  private async replayFromZero(): Promise<Operation[]> {
    const { ops, cursor } = await this.pullAll(0);
    await this.applyRemoteOps(ops, 0, cursor, true);
    this.needsBootstrap = false;
    return ops;
  }

  /**
   * The one apply path for pull and realtime. Flush to durable storage BEFORE advancing the cursor:
   * a crash between must leave the cursor at or before the ops on disk. Never rewinds; `rebase`
   * replaces the cursor. Returns false on a gap.
   */
  private async applyRemoteOps(
    ops: Operation[],
    from: number | undefined,
    cursor: number,
    rebase = false,
  ): Promise<boolean> {
    const epoch = this.epoch;
    if (ops.length > 0) {
      this.store.applyRemoteBatch(ops);
      await this.store.flush();
      this.opts.onRemoteApplied?.(ops);
    }
    // A reset happened meanwhile: the ops are merged like any others, but the cursor they were
    // checked against is gone.
    if (epoch !== this.epoch) return true;
    if (rebase) {
      this.moveCursor(cursor);
      return true;
    }
    if (from === undefined || this.cursor < from) return false;
    if (cursor > this.cursor) this.moveCursor(cursor);
    return true;
  }

  private moveCursor(cursor: number): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.opts.onCursor?.(cursor);
  }

  private enqueueRealtime(payload: unknown): void {
    this.realtimeQueue.push(payload);
    if (this.realtimeDraining) return;
    this.realtimeDraining = true;
    void (async () => {
      try {
        while (this.realtimeQueue.length > 0) {
          await this.applyRealtimePayload(this.realtimeQueue.shift());
        }
      } finally {
        this.realtimeDraining = false;
      }
    })();
  }

  /** A payload that fails to decode is dropped; the poll is authoritative. */
  private async applyRealtimePayload(payload: unknown): Promise<void> {
    try {
      const decoded = this.transport.decodeWirePayload?.(payload);
      if (!decoded) return;
      const contiguous = await this.applyRemoteOps(
        decoded.operations,
        decoded.from,
        decoded.cursor,
      );
      // Repairs go out with the next cycle's push.
      this.applyRepairs(decoded.repairs ?? []);
      // Ops before `from` never reached us: pull them from our own cursor.
      if (!contiguous) this.requestSync();
    } catch (err) {
      console.warn("[atlas SyncClient] dropped an undecodable realtime payload:", err);
    }
  }

  private ensureRealtime(): void {
    const cfg = this.opts.realtime;
    if (!cfg || this.realtime || this.halted || this.realtimeRevoked || this.disposed) return;
    this.realtime = new RealtimeClient({
      url: async () => {
        try {
          return await cfg.url(this.cursor);
        } catch (err) {
          // The ticket request met the protocol gate: stop, as a cycle refused with 426 does.
          if (err instanceof UpgradeRequiredError) {
            this.halted = true;
            this.dispose();
          }
          throw err;
        }
      },
      onPayload: (payload) => this.enqueueRealtime(payload),
      onClose: (code) => this.onRealtimeClosed(code),
      socketFactory: cfg.socketFactory,
      onState: (state) => {
        this.realtimeLive = state === "live";
        // A cycle in flight ("syncing") or failed ("offline") owns the status until it finishes.
        if (this.status === "idle" || this.status === "live-ws")
          this.setStatus(this.restingStatus());
      },
    });
    this.realtime.start();
  }

  private onRealtimeClosed(code: number): void {
    this.teardownRealtime();
    if (code === WS_CLOSE.SESSION_REVOKED) {
      // Reconnects would be refused; the next HTTP call fails auth and ends the session.
      this.realtimeRevoked = true;
    } else if (code === WS_CLOSE.CURSOR_EXPIRED) {
      // Ops above our cursor were purged: rebuild. The socket returns after the rebuilt cycle. If
      // this rebuild cannot run now, the next pull meets the same purge (410) and rebuilds then.
      this.resetAndBootstrap().catch(() => {});
    }
  }

  private teardownRealtime(): void {
    this.realtime?.dispose();
    this.realtime = null;
    this.realtimeLive = false;
    if (this.status === "live-ws") this.setStatus(this.restingStatus());
  }

  private restingStatus(): SyncStatus {
    return this.realtimeLive ? "live-ws" : "idle";
  }

  private async pullAll(since: number): Promise<{ ops: Operation[]; cursor: number }> {
    const ops: Operation[] = [];
    let cursor = since;
    try {
      for (;;) {
        const { operations, cursor: next, repairs } = await this.transport.syncPull(cursor);
        if (operations.length > 0) ops.push(...operations);
        if (repairs?.length) this.cycleRepairs.push(...repairs);
        const advanced = next !== cursor;
        if (advanced) cursor = next;
        // Stop when caught up. `!advanced` also guards against a stuck cursor looping forever.
        if (operations.length === 0 || !advanced) break;
        // More is coming: keep the badge on "syncing" during a backfill.
        this.setStatus("syncing");
      }
    } catch (err) {
      // Keep the pages that did arrive (a 429 midway through a backfill must not throw them away):
      // they are contiguous from `since`, so the next cycle continues after them.
      if (ops.length > 0) await this.applyRemoteOps(ops, since, cursor);
      throw err;
    }
    return { ops, cursor };
  }

  /**
   * Pages carry the walk's pinned cursor and are flushed with a resume point as they arrive. The
   * cursor moves only after the final page; the overlap pull re-delivers ops committed meanwhile.
   * Returns the adopted cursor, or null to fall back to the legacy replay.
   */
  private async bootstrapFromSnapshot(
    firstPage: SnapshotPage | null = null,
  ): Promise<number | null> {
    if (!this.transport.syncSnapshot) return null; // legacy transport: replay instead
    let progress = this.bootstrapProgress;
    let pinned = progress?.cursor;
    let prefetched = progress ? null : firstPage;
    try {
      for (;;) {
        let page: SnapshotPage;
        const token = progress?.next;
        try {
          page = prefetched ?? (await this.transport.syncSnapshot(token));
          prefetched = null;
        } catch (err) {
          if (!progress || !isBadSnapshotToken(err)) throw err;
          progress = null;
          pinned = undefined;
          this.walkRepairs = [];
          this.saveBootstrapProgress(null);
          continue;
        }
        const pageRepairs: PageRepairs = { page: token ?? "", repairs: page.repairs ?? [] };
        this.walkRepairs.push(...pageRepairs.repairs);
        if (page.operations.length > 0) {
          this.store.applyRemoteBatch(page.operations);
          await this.store.flush();
          this.opts.onRemoteApplied?.(page.operations);
        }
        pinned = pinned === undefined ? page.cursor : Math.min(pinned, page.cursor);
        if (page.next === undefined) {
          // The last page's repairs, stored before the cursor moves (with the same resume point),
          // so they outlive an app closed before this cycle writes them.
          if (pageRepairs.repairs.length > 0)
            this.opts.onBootstrapProgress?.(progress ?? { next: "", cursor: pinned }, pageRepairs);
          break;
        }
        progress = { next: page.next, cursor: pinned };
        // Its repairs are stored with the resume point, so a later launch still writes them.
        this.saveBootstrapProgress(progress, pageRepairs);
        this.setStatus("syncing");
      }
    } catch (err) {
      if (!isSnapshotUnsupported(err)) throw err;
      this.walkRepairs = [];
      this.saveBootstrapProgress(null);
      return null;
    }
    // The cursor moves before the progress is dropped (at the end of this cycle, with the walk's
    // repairs written): a cursor above 0 ignores a stale resume point.
    this.moveCursor(pinned ?? 0);
    this.bootstrapProgress = null;
    this.walkFinished = true;
    this.needsBootstrap = false;
    return this.cursor;
  }

  private saveBootstrapProgress(progress: BootstrapProgress | null, page?: PageRepairs): void {
    this.bootstrapProgress = progress;
    this.opts.onBootstrapProgress?.(progress, page);
  }

  /**
   * A permanent rejection or 413 bisects the batch to isolate the op, which is quarantined. Safe:
   * a rejected push commits nothing and re-pushing is idempotent.
   */
  private async pushOutbox(ops: Operation[]): Promise<void> {
    this.deferredIds = new Set();
    for (let retried = false; ; retried = true) {
      try {
        await this.pushBatches(ops);
        break;
      } catch (err) {
        if (!isClockSkew(err)) throw err;
        const serverTime = (err.data as { server_time?: unknown } | null | undefined)?.server_time;
        // The clock runs fast. Nothing of the refused batch was applied (batches before it were),
        // so the ops the server could never take are re-stamped by its clock and pushed again,
        // once. Whatever is still refused stays queued; the cycle carries on.
        if (typeof serverTime !== "number") return;
        this.clockSkew = this.store.alignClock(serverTime);
        if (retried || this.store.restampAhead(serverTime) === 0) return;
        // The new stamps reach the log before the push can mark the ops synced.
        await this.store.flush();
        ops = this.store.unsyncedOps().filter((o) => !this.deferredIds.has(o.id));
      }
    }
    if (ops.length > 0) this.clockSkew = null;
  }

  private async pushBatches(ops: Operation[]): Promise<void> {
    let batch: Operation[] = [];
    let bytes = 0;
    for (const op of ops) {
      const size = estimateWireBytes(op);
      if (batch.length > 0 && (batch.length >= MAX_PUSH_OPS || bytes + size > MAX_PUSH_BYTES)) {
        await this.pushBatch(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(op);
      bytes += size;
    }
    await this.pushBatch(batch);
  }

  private async pushBatch(ops: Operation[]): Promise<void> {
    if (ops.length === 0) return;
    try {
      const res = await this.transport.syncPush(ops);
      const deferred = new Set(res?.deferred ?? []);
      for (const id of deferred) this.deferredIds.add(id);
      this.store.markSynced(ops.filter((o) => !deferred.has(o.id)).map((o) => o.id));
      // `(from, cursor]` are this batch's own ops: when we hold everything up to `from`, the pull
      // need not fetch them back. They were queued to disk when written; make sure first.
      if (res?.from !== undefined && this.cursor >= res.from && res.cursor > this.cursor) {
        await this.store.flush();
        if (this.cursor >= res.from) this.moveCursor(Math.max(this.cursor, res.cursor));
      }
    } catch (err) {
      // A 413 is the body's size, not a blip: retrying the same batch would fail forever.
      const tooLarge = err instanceof ApiError && err.status === 413;
      if (!tooLarge && !isPermanentPushError(err)) throw err; // transient: retry next cycle
      if (ops.length === 1) {
        // Isolated poison op: take it back so it stops blocking every future push, and so its
        // value, which no other device will ever see, stops masking theirs here.
        const op = ops[0]!;
        this.store.discard([op.id]);
        this.opts.onQuarantine?.(op, tooLarge ? new PushTooLargeError(op, err) : err);
        return;
      }
      const mid = ops.length >> 1;
      await this.pushBatch(ops.slice(0, mid));
      await this.pushBatch(ops.slice(mid));
    }
  }

  private applyRepairs(repairs: Repair[]): number {
    if (repairs.length === 0) return 0;
    const confirmed = this.transport.confirmRepairs
      ? this.transport.confirmRepairs(repairs)
      : repairs;
    return applyRepairs(this.store, confirmed);
  }

  private setStatus(status: SyncStatus): void {
    if (status !== this.status) {
      this.status = status;
      this.opts.onStatus?.(status);
    }
  }
}
