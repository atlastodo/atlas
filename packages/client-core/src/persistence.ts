/** Append-only op log backends for {@link LocalStore}: memory, and SQLite over a minimal {@link SqlDatabase} port. */

import type { Hlc } from "./hlc";
import type { AttachmentMetaPayload, EntityKind, Operation } from "./types";
import type { AttachmentKeyPayload } from "./crypto";
import type { Repair } from "./scope";

/** Where an interrupted snapshot bootstrap resumes: the next page token and the walk's pinned cursor. */
export interface BootstrapProgress {
  next: string;
  cursor: number;
  /** Applied when the walk ends; stored page by page ({@link PageRepairs}). */
  repairs?: Repair[];
}

export interface PageRepairs {
  page: string;
  repairs: Repair[];
}

export const BOOTSTRAP_REPAIRS_PREFIX = "bootstrap_repairs:";

export interface PersistedOp {
  op: Operation;
  synced: boolean;
}

/** `uploading` is event-only, never persisted, so a crash re-enters `queued` on the next drain. */
export type AttachmentUploadState = "queued" | "uploading" | "stored" | "failed" | "cancelled";

/** Bytes, or in a browser a `Blob` kept outside the JS heap. SQLite reads a `Blob` in. */
export type AttachmentCiphertext = Uint8Array | Blob;

/** Holds the encrypted payload plus what the metadata op needs, so a relaunch needs no original bytes. */
export interface PersistedAttachmentUpload {
  id: string;
  taskId: string;
  projectId: string | null;
  blobSha: string;
  blobSize: number;
  ciphertext: AttachmentCiphertext;
  wrappedKey: AttachmentKeyPayload;
  meta: AttachmentMetaPayload;
  thumbSha: string | null;
  sortOrder: number;
  createdAt: number;
  state: AttachmentUploadState;
  attempts: number;
  /** Unix ms before which not to retry; for `stored`, when the blob stops counting as fresh. */
  nextAttemptAt: number;
  lastError: string | null;
  metaReleased: boolean;
}

/** A queue entry without ciphertext, which is loaded only for the one being uploaded. */
export type AttachmentUploadInfo = Omit<PersistedAttachmentUpload, "ciphertext">;

/** The store serializes writes so the log stays ordered. `append` must be idempotent on `op.id`. */
export interface Persistence {
  load(): Promise<PersistedOp[]>;
  append(op: Operation, synced: boolean): Promise<void>;
  appendBatch?(ops: Operation[], synced: boolean): Promise<void>;
  markSynced(opIds: string[]): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
  getBootstrap?(): Promise<BootstrapProgress | null>;
  /** One repairs record per page (`progress.repairs` is ignored). Null drops the resume point and repairs. */
  setBootstrap?(progress: BootstrapProgress | null, page?: PageRepairs): Promise<void>;
  commitSyncBatch?(ops: Operation[], cursor: number): Promise<void>;
  clear?(): Promise<void>;
  /** Atomic (see `LocalStore.resetSynced`). */
  clearSynced?(): Promise<void>;
  /** Unsynced ones are kept; unknown ids ignored. */
  compact?(opIds: string[]): Promise<void>;
  deleteOps?(opIds: string[]): Promise<void>;
  /** Atomic: gives each stored op of these ids the given op's `ts`, synced or not; unknown ids ignored. */
  restamp?(ops: Operation[]): Promise<void>;
  /** Later calls reject, so a running store cannot write into a database being replaced or deleted. */
  close?(): Promise<void>;
  /** Device-local, and `clear()` leaves it alone: losing an in-flight upload would strand its ciphertext. */
  loadAttachmentQueue?(): Promise<PersistedAttachmentUpload[]>;
  putAttachmentUpload?(upload: PersistedAttachmentUpload): Promise<void>;
  deleteAttachmentUpload?(id: string): Promise<void>;
  listAttachmentQueue?(): Promise<AttachmentUploadInfo[]>;
  loadAttachmentCiphertext?(id: string): Promise<AttachmentCiphertext | null>;
  /** A no-op when the entry is gone, so a late update cannot revive it. */
  updateAttachmentUpload?(info: AttachmentUploadInfo): Promise<void>;
}

export class MemoryPersistence implements Persistence {
  private readonly ops: PersistedOp[] = [];
  private readonly index = new Map<string, PersistedOp>();
  private cursor = 0;
  private bootstrap: BootstrapProgress | null = null;
  private readonly repairs = new Map<string, Repair[]>();
  private readonly attachments = new Map<string, PersistedAttachmentUpload>();
  private closed = false;

  async load(): Promise<PersistedOp[]> {
    return this.ops.map((p) => ({ op: p.op, synced: p.synced }));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async append(op: Operation, synced: boolean): Promise<void> {
    if (this.closed) throw new DatabaseClosedError();
    if (this.index.has(op.id)) return;
    const entry: PersistedOp = { op, synced };
    this.ops.push(entry);
    this.index.set(op.id, entry);
  }

  async appendBatch(ops: Operation[], synced: boolean): Promise<void> {
    for (const op of ops) {
      await this.append(op, synced);
    }
  }

  async markSynced(opIds: string[]): Promise<void> {
    for (const id of opIds) {
      const entry = this.index.get(id);
      if (entry) entry.synced = true;
    }
  }

  async compact(opIds: string[]): Promise<void> {
    await this.drop(opIds.filter((id) => this.index.get(id)?.synced));
  }

  async deleteOps(opIds: string[]): Promise<void> {
    await this.drop(opIds);
  }

  async restamp(ops: Operation[]): Promise<void> {
    if (this.closed) throw new DatabaseClosedError();
    for (const op of ops) {
      const entry = this.index.get(op.id);
      if (entry) entry.op = { ...entry.op, ts: op.ts };
    }
  }

  private async drop(opIds: string[]): Promise<void> {
    const drop = new Set(opIds.filter((id) => this.index.has(id)));
    if (drop.size === 0) return;
    const kept = this.ops.filter((p) => !drop.has(p.op.id));
    this.ops.length = 0;
    this.ops.push(...kept);
    for (const id of drop) this.index.delete(id);
  }

  async getCursor(): Promise<number> {
    return this.cursor;
  }

  async setCursor(cursor: number): Promise<void> {
    this.cursor = cursor;
  }

  async getBootstrap(): Promise<BootstrapProgress | null> {
    if (!this.bootstrap) return null;
    const { next, cursor } = this.bootstrap;
    const repairs = [...this.repairs.values()].flat();
    return repairs.length > 0 ? { next, cursor, repairs } : { next, cursor };
  }

  async setBootstrap(progress: BootstrapProgress | null, page?: PageRepairs): Promise<void> {
    this.bootstrap = progress ? { next: progress.next, cursor: progress.cursor } : null;
    if (!progress) this.repairs.clear();
    else if (page?.repairs.length) this.repairs.set(page.page, page.repairs);
  }

  async commitSyncBatch(ops: Operation[], cursor: number): Promise<void> {
    await this.appendBatch(ops, true);
    this.cursor = cursor;
  }

  async clear(): Promise<void> {
    this.ops.length = 0;
    this.index.clear();
    this.cursor = 0;
    this.bootstrap = null;
    this.repairs.clear();
  }

  async clearSynced(): Promise<void> {
    const kept = this.ops.filter((p) => !p.synced);
    this.ops.length = 0;
    this.index.clear();
    for (const p of kept) {
      this.ops.push(p);
      this.index.set(p.op.id, p);
    }
    this.cursor = 0;
    this.bootstrap = null;
    this.repairs.clear();
  }

  async loadAttachmentQueue(): Promise<PersistedAttachmentUpload[]> {
    return [...this.attachments.values()].sort(byEnqueueOrder);
  }

  async putAttachmentUpload(upload: PersistedAttachmentUpload): Promise<void> {
    this.attachments.set(upload.id, upload);
  }

  async deleteAttachmentUpload(id: string): Promise<void> {
    this.attachments.delete(id);
  }

  async listAttachmentQueue(): Promise<AttachmentUploadInfo[]> {
    return [...this.attachments.values()].map(withoutCiphertext).sort(byEnqueueOrder);
  }

  async loadAttachmentCiphertext(id: string): Promise<AttachmentCiphertext | null> {
    return this.attachments.get(id)?.ciphertext ?? null;
  }

  async updateAttachmentUpload(info: AttachmentUploadInfo): Promise<void> {
    const current = this.attachments.get(info.id);
    if (current) this.attachments.set(info.id, { ...info, ciphertext: current.ciphertext });
  }
}

/** The synced state was reset (e.g. another tab's rebuild) since this connection loaded. */
export class DatabaseResetError extends Error {
  constructor() {
    super("the local database was reset by another tab since this one loaded it");
    this.name = "DatabaseResetError";
  }
}

export class DatabaseClosedError extends Error {
  constructor() {
    super("the local database is closed");
    this.name = "DatabaseClosedError";
  }
}

export function withoutCiphertext(upload: PersistedAttachmentUpload): AttachmentUploadInfo {
  const { ciphertext: _ciphertext, ...info } = upload;
  return info;
}

function byEnqueueOrder(a: AttachmentUploadInfo, b: AttachmentUploadInfo): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface SqlExecuteResult {
  rowsAffected: number;
  lastInsertId?: number;
}

/** `expo-sqlite` or a test fake; `?` placeholders. */
export interface SqlDatabase {
  execute(query: string, bindValues?: unknown[]): Promise<SqlExecuteResult>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close?(): Promise<void>;
}

interface OpRow {
  op_id: string;
  entity: string;
  entity_id: string;
  kind: string;
  field: string | null;
  value_json: string | null;
  ts_json: string;
  synced: number;
}

const CREATE_OPS = `CREATE TABLE IF NOT EXISTS ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  field TEXT,
  value_json TEXT,
  ts_json TEXT NOT NULL,
  synced INTEGER NOT NULL
)`;

const CREATE_META = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;

/** Device-local upload queue (see `attachments.ts`); never synced. */
const CREATE_ATTACHMENT_QUEUE = `CREATE TABLE IF NOT EXISTS attachment_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT,
  blob_sha TEXT NOT NULL,
  blob_size INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  wrapped_key_json TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  thumb_sha TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  meta_released INTEGER NOT NULL
)`;

/** One row per op (ordered by autoincrement `seq`) plus a `meta` row for the cursor. */
export class SqlitePersistence implements Persistence {
  private ready: Promise<void> | null = null;
  /** Calls run alone, in order: a plain `BEGIN` spans awaits, so an unrelated write would join the transaction. */
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | null = null;
  private epoch = 0;

  constructor(private readonly db: SqlDatabase) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = () => (this.closed ? Promise.reject(new DatabaseClosedError()) : fn());
    const run = this.queue.then(guarded, guarded);
    this.queue = run.catch(() => {});
    return run;
  }

  close(): Promise<void> {
    // Once: a second caller (the store's teardown and a sign-out's deletion) waits for the first.
    this.closing ??= this.exclusive(async () => {
      this.closed = true;
      await this.db.close?.();
    });
    return this.closing;
  }

  private init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.db.execute(CREATE_OPS);
        await this.db.execute(CREATE_META);
        await this.db.execute(CREATE_ATTACHMENT_QUEUE);
        this.epoch = await this.readEpoch();
      })();
    }
    return this.ready;
  }

  private async readEpoch(): Promise<number> {
    const rows = await this.db.select<{ value: string }[]>(
      `SELECT value FROM meta WHERE key = 'epoch'`,
    );
    const n = Number(rows[0]?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private setMeta(key: string, value: string): Promise<SqlExecuteResult> {
    return this.db.execute(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  private async bumpEpoch(): Promise<number> {
    const next = (await this.readEpoch()) + 1;
    await this.setMeta("epoch", String(next));
    return next;
  }

  /** Rejects with {@link DatabaseResetError} if the synced state was reset since this connection read it. */
  private writeSyncPosition(write: () => Promise<void>): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        if ((await this.readEpoch()) !== this.epoch) throw new DatabaseResetError();
        await write();
        await this.db.execute("COMMIT");
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  load(): Promise<PersistedOp[]> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<OpRow[]>(
        `SELECT op_id, entity, entity_id, kind, field, value_json, ts_json, synced
         FROM ops ORDER BY seq ASC`,
      );
      const out: PersistedOp[] = [];
      for (const r of rows) {
        // One unreadable row must not keep the whole log from loading.
        try {
          out.push({ op: rowToOp(r), synced: r.synced === 1 });
        } catch (err) {
          console.warn(`[atlas] skipped an unreadable op log row (${r.op_id}):`, err);
        }
      }
      return out;
    });
  }

  append(op: Operation, synced: boolean): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      const field = op.op === "set" ? op.field : null;
      const valueJson = op.op === "set" ? valueToJson(op.value) : null;
      await this.db.execute(
        `INSERT OR IGNORE INTO ops (op_id, entity, entity_id, kind, field, value_json, ts_json, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          op.id,
          op.entity,
          op.entityId,
          op.op,
          field,
          valueJson,
          JSON.stringify(op.ts),
          synced ? 1 : 0,
        ],
      );
    });
  }

  appendBatch(ops: Operation[], synced: boolean): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        for (const op of ops) {
          const field = op.op === "set" ? op.field : null;
          const valueJson = op.op === "set" ? valueToJson(op.value) : null;
          await this.db.execute(
            `INSERT OR IGNORE INTO ops (op_id, entity, entity_id, kind, field, value_json, ts_json, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              op.id,
              op.entity,
              op.entityId,
              op.op,
              field,
              valueJson,
              JSON.stringify(op.ts),
              synced ? 1 : 0,
            ],
          );
        }
        await this.db.execute("COMMIT");
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  commitSyncBatch(ops: Operation[], cursor: number): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      let stale = false;
      await this.db.execute("BEGIN TRANSACTION");
      try {
        for (const op of ops) {
          const field = op.op === "set" ? op.field : null;
          const valueJson = op.op === "set" ? valueToJson(op.value) : null;
          await this.db.execute(
            `INSERT OR IGNORE INTO ops (op_id, entity, entity_id, kind, field, value_json, ts_json, synced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [op.id, op.entity, op.entityId, op.op, field, valueJson, JSON.stringify(op.ts), 1],
          );
        }
        // The ops are kept either way; only the cursor is refused after a reset elsewhere.
        stale = (await this.readEpoch()) !== this.epoch;
        if (!stale) await this.setMeta("cursor", String(cursor));
        await this.db.execute("COMMIT");
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
      if (stale) throw new DatabaseResetError();
    });
  }

  markSynced(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      await this.init();
      const placeholders = opIds.map(() => "?").join(", ");
      await this.db.execute(`UPDATE ops SET synced = 1 WHERE op_id IN (${placeholders})`, opIds);
    });
  }

  compact(opIds: string[]): Promise<void> {
    return this.dropOps(opIds, "synced = 1 AND ");
  }

  deleteOps(opIds: string[]): Promise<void> {
    return this.dropOps(opIds, "");
  }

  restamp(ops: Operation[]): Promise<void> {
    if (ops.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        for (const op of ops) {
          await this.db.execute(`UPDATE ops SET ts_json = ? WHERE op_id = ?`, [
            JSON.stringify(op.ts),
            op.id,
          ]);
        }
        await this.db.execute("COMMIT");
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  private dropOps(opIds: string[], onlySynced: string): Promise<void> {
    if (opIds.length === 0) return Promise.resolve();
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        // Chunked to stay under SQLite's bound-parameter limit.
        for (let i = 0; i < opIds.length; i += 500) {
          const ids = opIds.slice(i, i + 500);
          await this.db.execute(
            `DELETE FROM ops WHERE ${onlySynced}op_id IN (${ids.map(() => "?").join(", ")})`,
            ids,
          );
        }
        await this.db.execute("COMMIT");
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  getCursor(): Promise<number> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<{ value: string }[]>(
        `SELECT value FROM meta WHERE key = 'cursor'`,
      );
      const raw = rows[0]?.value;
      const n = raw === undefined ? 0 : Number(raw);
      return Number.isFinite(n) ? n : 0;
    });
  }

  setCursor(cursor: number): Promise<void> {
    return this.writeSyncPosition(async () => {
      await this.setMeta("cursor", String(cursor));
    });
  }

  getBootstrap(): Promise<BootstrapProgress | null> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<{ value: string }[]>(
        `SELECT value FROM meta WHERE key = 'bootstrap'`,
      );
      const progress = parseBootstrap(rows[0]?.value);
      if (!progress) return null;
      const pages = await this.db.select<{ value: string }[]>(
        `SELECT value FROM meta WHERE key LIKE '${BOOTSTRAP_REPAIRS_PREFIX}%'`,
      );
      const repairs = pages.flatMap((r) => parseRepairs(r.value));
      return repairs.length > 0 ? { ...progress, repairs } : progress;
    });
  }

  setBootstrap(progress: BootstrapProgress | null, page?: PageRepairs): Promise<void> {
    return this.writeSyncPosition(async () => {
      if (!progress) {
        await this.db.execute(`DELETE FROM meta WHERE key = 'bootstrap'`);
        await this.db.execute(`DELETE FROM meta WHERE key LIKE '${BOOTSTRAP_REPAIRS_PREFIX}%'`);
        return;
      }
      await this.setMeta(
        "bootstrap",
        JSON.stringify({ next: progress.next, cursor: progress.cursor }),
      );
      if (page?.repairs.length)
        await this.setMeta(BOOTSTRAP_REPAIRS_PREFIX + page.page, JSON.stringify(page.repairs));
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        await this.db.execute("DELETE FROM ops");
        const epoch = (await this.readEpoch()) + 1;
        await this.db.execute("DELETE FROM meta");
        await this.db.execute(`INSERT INTO meta (key, value) VALUES ('epoch', ?)`, [String(epoch)]);
        await this.db.execute("COMMIT");
        this.epoch = epoch;
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  clearSynced(): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute("BEGIN TRANSACTION");
      try {
        await this.db.execute("DELETE FROM ops WHERE synced = 1");
        await this.db.execute(`DELETE FROM meta WHERE key = 'cursor'`);
        await this.db.execute(`DELETE FROM meta WHERE key = 'bootstrap'`);
        await this.db.execute(`DELETE FROM meta WHERE key LIKE '${BOOTSTRAP_REPAIRS_PREFIX}%'`);
        // Other tabs still hold the old cursor in memory: from now on they may not write it.
        const epoch = await this.bumpEpoch();
        await this.db.execute("COMMIT");
        this.epoch = epoch;
      } catch (err) {
        await this.db.execute("ROLLBACK").catch(() => {});
        throw err;
      }
    });
  }

  loadAttachmentQueue(): Promise<PersistedAttachmentUpload[]> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<AttachmentQueueRow[]>(
        `SELECT id, task_id, project_id, blob_sha, blob_size, ciphertext, wrapped_key_json, meta_json,
                thumb_sha, sort_order, created_at, state, attempts, next_attempt_at, last_error,
                meta_released
         FROM attachment_queue ORDER BY created_at ASC, id ASC`,
      );
      return rows.map(rowToAttachment).sort(byEnqueueOrder);
    });
  }

  async putAttachmentUpload(upload: PersistedAttachmentUpload): Promise<void> {
    const ciphertext =
      upload.ciphertext instanceof Uint8Array
        ? upload.ciphertext
        : new Uint8Array(await upload.ciphertext.arrayBuffer());
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute(
        `INSERT INTO attachment_queue (
           id, task_id, project_id, blob_sha, blob_size, ciphertext, wrapped_key_json, meta_json,
           thumb_sha, sort_order, created_at, state, attempts, next_attempt_at, last_error,
           meta_released
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           project_id = excluded.project_id,
           blob_sha = excluded.blob_sha,
           blob_size = excluded.blob_size,
           ciphertext = excluded.ciphertext,
           wrapped_key_json = excluded.wrapped_key_json,
           meta_json = excluded.meta_json,
           thumb_sha = excluded.thumb_sha,
           sort_order = excluded.sort_order,
           created_at = excluded.created_at,
           state = excluded.state,
           attempts = excluded.attempts,
           next_attempt_at = excluded.next_attempt_at,
           last_error = excluded.last_error,
           meta_released = excluded.meta_released`,
        [
          upload.id,
          upload.taskId,
          upload.projectId,
          upload.blobSha,
          upload.blobSize,
          ciphertext,
          JSON.stringify(upload.wrappedKey),
          JSON.stringify(upload.meta),
          upload.thumbSha,
          upload.sortOrder,
          upload.createdAt,
          upload.state,
          upload.attempts,
          upload.nextAttemptAt,
          upload.lastError,
          upload.metaReleased ? 1 : 0,
        ],
      );
    });
  }

  deleteAttachmentUpload(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute(`DELETE FROM attachment_queue WHERE id = ?`, [id]);
    });
  }

  listAttachmentQueue(): Promise<AttachmentUploadInfo[]> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<Omit<AttachmentQueueRow, "ciphertext">[]>(
        `SELECT id, task_id, project_id, blob_sha, blob_size, wrapped_key_json, meta_json,
                thumb_sha, sort_order, created_at, state, attempts, next_attempt_at, last_error,
                meta_released
         FROM attachment_queue ORDER BY created_at ASC, id ASC`,
      );
      return rows.map(rowToAttachmentInfo).sort(byEnqueueOrder);
    });
  }

  loadAttachmentCiphertext(id: string): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      await this.init();
      const rows = await this.db.select<{ ciphertext: Uint8Array }[]>(
        `SELECT ciphertext FROM attachment_queue WHERE id = ?`,
        [id],
      );
      return rows[0]?.ciphertext ?? null;
    });
  }

  updateAttachmentUpload(info: AttachmentUploadInfo): Promise<void> {
    return this.exclusive(async () => {
      await this.init();
      await this.db.execute(
        `UPDATE attachment_queue SET
           task_id = ?, project_id = ?, blob_sha = ?, blob_size = ?, wrapped_key_json = ?,
           meta_json = ?, thumb_sha = ?, sort_order = ?, created_at = ?, state = ?, attempts = ?,
           next_attempt_at = ?, last_error = ?, meta_released = ?
         WHERE id = ?`,
        [
          info.taskId,
          info.projectId,
          info.blobSha,
          info.blobSize,
          JSON.stringify(info.wrappedKey),
          JSON.stringify(info.meta),
          info.thumbSha,
          info.sortOrder,
          info.createdAt,
          info.state,
          info.attempts,
          info.nextAttemptAt,
          info.lastError,
          info.metaReleased ? 1 : 0,
          info.id,
        ],
      );
    });
  }
}

interface AttachmentQueueRow {
  id: string;
  task_id: string;
  project_id: string | null;
  blob_sha: string;
  blob_size: number;
  ciphertext: Uint8Array;
  wrapped_key_json: string;
  meta_json: string;
  thumb_sha: string | null;
  sort_order: number;
  created_at: number;
  state: AttachmentUploadState;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  meta_released: number | boolean;
}

function rowToAttachment(r: AttachmentQueueRow): PersistedAttachmentUpload {
  return { ...rowToAttachmentInfo(r), ciphertext: r.ciphertext };
}

function rowToAttachmentInfo(r: Omit<AttachmentQueueRow, "ciphertext">): AttachmentUploadInfo {
  return {
    id: r.id,
    taskId: r.task_id,
    projectId: r.project_id,
    blobSha: r.blob_sha,
    blobSize: Number(r.blob_size),
    wrappedKey: JSON.parse(r.wrapped_key_json) as AttachmentKeyPayload,
    meta: JSON.parse(r.meta_json) as AttachmentMetaPayload,
    thumbSha: r.thumb_sha,
    sortOrder: Number(r.sort_order),
    createdAt: Number(r.created_at),
    state: r.state,
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    lastError: r.last_error,
    metaReleased: r.meta_released === 1 || r.meta_released === true,
  };
}

export function parseRepairs(raw: unknown): Repair[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as Repair[]) : [];
  } catch {
    return [];
  }
}

export function parseBootstrap(raw: unknown): BootstrapProgress | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const p = v as { next?: unknown; cursor?: unknown } | null | undefined;
  if (typeof p?.next !== "string" || typeof p.cursor !== "number" || !Number.isFinite(p.cursor))
    return null;
  return { next: p.next, cursor: p.cursor };
}

function valueToJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function rowToOp(r: OpRow): Operation {
  const ts = JSON.parse(r.ts_json) as Hlc;
  const base = { id: r.op_id, entity: r.entity as EntityKind, entityId: r.entity_id, ts };
  if (r.kind === "delete") return { ...base, op: "delete" };
  return {
    ...base,
    op: "set",
    field: r.field ?? "",
    value: r.value_json === null ? undefined : JSON.parse(r.value_json),
  };
}
