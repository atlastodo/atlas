/** Web {@link Persistence}; the `IDBFactory` is injectable for `fake-indexeddb`. */

import type { Operation } from "./types";
import {
  BOOTSTRAP_REPAIRS_PREFIX,
  DatabaseClosedError,
  DatabaseResetError,
  parseBootstrap,
  parseRepairs,
  type BootstrapProgress,
  type PageRepairs,
  type PersistedOp,
  type Persistence,
  type PersistedAttachmentUpload,
  type AttachmentCiphertext,
  type AttachmentUploadInfo,
} from "./persistence";

const OPS = "ops";
const META = "meta";
const ATTACHMENT_QUEUE = "attachment_queue";
const ATTACHMENT_BLOBS = "attachment_blobs";
const OP_ID_INDEX = "op_id";
const CURSOR_KEY = "cursor";
const BOOTSTRAP_KEY = "bootstrap";
const EPOCH_KEY = "epoch";

/** v1: `ops` + `meta`; v2: upload queue; v3: queue ciphertext in its own store. */
const DB_VERSION = 3;

interface BlobRecord {
  id: string;
  ciphertext: AttachmentCiphertext;
}

interface OpRecord {
  seq?: number;
  op_id: string;
  synced: boolean;
  op: Operation;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export interface IndexedDbEvents {
  /** Upgrade waits for another tab holding an older version. */
  onBlocked?: () => void;
  /** This connection closed for another tab's newer version; writes fail until reload. */
  onVersionChange?: () => void;
}

export class IndexedDbPersistence implements Persistence {
  private ready: Promise<IDBDatabase> | null = null;
  private closed = false;
  private epoch = 0;

  constructor(
    private readonly dbName = "atlas",
    private readonly factory: IDBFactory = globalThis.indexedDB,
    private readonly events: IndexedDbEvents = {},
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new DatabaseClosedError());
    if (!this.ready) {
      this.ready = new Promise<IDBDatabase>((resolve, reject) => {
        const req = this.factory.open(this.dbName, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = req.result;
          const from = event.oldVersion;
          // Each step is guarded by the version it upgrades FROM, so existing stores keep their
          // rows.
          if (from < 1) {
            // Autoincrement primary key preserves append order; a unique op_id index gives
            // idempotency.
            const ops = db.createObjectStore(OPS, { keyPath: "seq", autoIncrement: true });
            ops.createIndex(OP_ID_INDEX, "op_id", { unique: true });
            db.createObjectStore(META, { keyPath: "key" });
          }
          if (from < 2) {
            // Upload queue records are stored whole (structured clone carries the ciphertext),
            // keyed by entry id.
            db.createObjectStore(ATTACHMENT_QUEUE, { keyPath: "id" });
          }
          if (from < 3) {
            db.createObjectStore(ATTACHMENT_BLOBS, { keyPath: "id" });
            if (from >= 2) moveCiphertextOut(req.transaction!);
          }
        };
        req.onblocked = () => this.events.onBlocked?.();
        req.onsuccess = () => {
          const db = req.result;
          // Holding the connection open would block the other tab's upgrade. Closed for good:
          // reopening would recreate a database another tab just deleted.
          db.onversionchange = () => {
            db.close();
            this.closed = true;
            this.ready = null;
            this.events.onVersionChange?.();
          };
          const read = db.transaction(META, "readonly").objectStore(META).get(EPOCH_KEY);
          read.onsuccess = () => {
            this.epoch = epochOf(read.result);
            resolve(db);
          };
          read.onerror = () => reject(read.error);
        };
        req.onerror = () => {
          this.ready = null; // let a later call try again
          reject(req.error);
        };
      });
    }
    return this.ready;
  }

  async close(): Promise<void> {
    this.closed = true;
    const ready = this.ready;
    this.ready = null;
    // A transaction already started finishes first: IndexedDB closes once it is done.
    if (ready) (await ready.catch(() => null))?.close();
  }

  async load(): Promise<PersistedOp[]> {
    const db = await this.open();
    const tx = db.transaction(OPS, "readonly");
    const records = await reqToPromise<OpRecord[]>(tx.objectStore(OPS).getAll());
    return records.map((r) => ({ op: r.op, synced: r.synced }));
  }

  append(op: Operation, synced: boolean): Promise<void> {
    return this.appendBatch([op], synced);
  }

  async appendBatch(ops: Operation[], synced: boolean): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.open();
    const tx = db.transaction(OPS, "readwrite");
    addMissing(tx, ops, synced);
    await txDone(tx);
  }

  async commitSyncBatch(ops: Operation[], cursor: number): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([OPS, META], "readwrite");
    addMissing(tx, ops, true);
    await this.writeMeta(tx, (meta) => meta.put({ key: CURSOR_KEY, value: cursor }));
  }

  /** The epoch is read in the same transaction, so a reset cannot land between. */
  private async writeMeta(
    tx: IDBTransaction,
    write: (meta: IDBObjectStore) => void,
  ): Promise<void> {
    const meta = tx.objectStore(META);
    let stale = false;
    const read = meta.get(EPOCH_KEY);
    read.onsuccess = () => {
      if (epochOf(read.result) !== this.epoch) stale = true;
      else write(meta);
    };
    await txDone(tx);
    if (stale) throw new DatabaseResetError();
  }

  async markSynced(opIds: string[]): Promise<void> {
    if (opIds.length === 0) return;
    const db = await this.open();
    const tx = db.transaction(OPS, "readwrite");
    const store = tx.objectStore(OPS);
    const index = store.index(OP_ID_INDEX);
    // Issue all reads synchronously; no awaits mid-transaction, or it auto-commits before the
    // write.
    for (const id of opIds) {
      const getReq = index.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result as OpRecord | undefined;
        if (rec) {
          rec.synced = true;
          store.put(rec);
        }
      };
    }
    await txDone(tx);
  }

  compact(opIds: string[]): Promise<void> {
    return this.dropOps(opIds, true);
  }

  deleteOps(opIds: string[]): Promise<void> {
    return this.dropOps(opIds, false);
  }

  async restamp(ops: Operation[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.open();
    const tx = db.transaction(OPS, "readwrite");
    const store = tx.objectStore(OPS);
    const index = store.index(OP_ID_INDEX);
    // One transaction, no awaits inside it (see `markSynced`).
    for (const op of ops) {
      const getReq = index.get(op.id);
      getReq.onsuccess = () => {
        const rec = getReq.result as OpRecord | undefined;
        if (rec) store.put({ ...rec, op: { ...rec.op, ts: op.ts } });
      };
    }
    await txDone(tx);
  }

  private async dropOps(opIds: string[], onlySynced: boolean): Promise<void> {
    if (opIds.length === 0) return;
    const db = await this.open();
    const tx = db.transaction(OPS, "readwrite");
    const store = tx.objectStore(OPS);
    const index = store.index(OP_ID_INDEX);
    // One transaction, no awaits inside it (see `markSynced`).
    for (const id of opIds) {
      const getReq = index.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result as OpRecord | undefined;
        if (rec && (rec.synced || !onlySynced) && rec.seq !== undefined) store.delete(rec.seq);
      };
    }
    await txDone(tx);
  }

  async getCursor(): Promise<number> {
    const db = await this.open();
    const tx = db.transaction(META, "readonly");
    const rec = await reqToPromise<{ key: string; value: number } | undefined>(
      tx.objectStore(META).get(CURSOR_KEY),
    );
    const n = rec?.value;
    return typeof n === "number" && Number.isFinite(n) ? n : 0;
  }

  async setCursor(cursor: number): Promise<void> {
    const db = await this.open();
    await this.writeMeta(db.transaction(META, "readwrite"), (meta) =>
      meta.put({ key: CURSOR_KEY, value: cursor }),
    );
  }

  async getBootstrap(): Promise<BootstrapProgress | null> {
    const db = await this.open();
    const meta = db.transaction(META, "readonly").objectStore(META);
    // The meta store holds a handful of records: read them all rather than a key range, whose
    // constructor is a browser global the injected factory does not bring.
    const records = await reqToPromise<{ key: string; value: unknown }[]>(meta.getAll());
    const progress = parseBootstrap(records.find((r) => r.key === BOOTSTRAP_KEY)?.value);
    if (!progress) return null;
    const repairs = records
      .filter((r) => r.key.startsWith(BOOTSTRAP_REPAIRS_PREFIX))
      .flatMap((r) => parseRepairs(r.value));
    return repairs.length > 0 ? { ...progress, repairs } : progress;
  }

  async setBootstrap(progress: BootstrapProgress | null, page?: PageRepairs): Promise<void> {
    const db = await this.open();
    await this.writeMeta(db.transaction(META, "readwrite"), (meta) => {
      if (!progress) {
        meta.delete(BOOTSTRAP_KEY);
        deleteRepairs(meta);
        return;
      }
      meta.put({ key: BOOTSTRAP_KEY, value: { next: progress.next, cursor: progress.cursor } });
      if (page?.repairs.length)
        meta.put({ key: BOOTSTRAP_REPAIRS_PREFIX + page.page, value: page.repairs });
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([OPS, META], "readwrite");
    tx.objectStore(OPS).clear();
    const epoch = this.bumpEpoch(tx);
    tx.objectStore(META).clear();
    await txDone(tx);
    this.epoch = epoch.value;
  }

  /** Read and written in `tx`, so two tabs resetting at once get distinct epochs. */
  private bumpEpoch(tx: IDBTransaction): { value: number } {
    const meta = tx.objectStore(META);
    const out = { value: this.epoch + 1 };
    const read = meta.get(EPOCH_KEY);
    read.onsuccess = () => {
      out.value = epochOf(read.result) + 1;
      meta.put({ key: EPOCH_KEY, value: out.value });
    };
    return out;
  }

  async clearSynced(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([OPS, META], "readwrite");
    // Walk the log inside the one transaction (no awaits, so it cannot auto-commit midway).
    const walk = tx.objectStore(OPS).openCursor();
    walk.onsuccess = () => {
      const cursor = walk.result;
      if (!cursor) return;
      if ((cursor.value as OpRecord).synced) cursor.delete();
      cursor.continue();
    };
    tx.objectStore(META).delete(CURSOR_KEY);
    tx.objectStore(META).delete(BOOTSTRAP_KEY);
    deleteRepairs(tx.objectStore(META));
    // Other tabs still hold the old cursor in memory: from now on they may not write it.
    const epoch = this.bumpEpoch(tx);
    await txDone(tx);
    this.epoch = epoch.value;
  }

  async loadAttachmentQueue(): Promise<PersistedAttachmentUpload[]> {
    const db = await this.open();
    const tx = db.transaction([ATTACHMENT_QUEUE, ATTACHMENT_BLOBS], "readonly");
    const [records, blobs] = await Promise.all([
      reqToPromise<AttachmentUploadInfo[]>(tx.objectStore(ATTACHMENT_QUEUE).getAll()),
      reqToPromise<BlobRecord[]>(tx.objectStore(ATTACHMENT_BLOBS).getAll()),
    ]);
    const ciphertexts = new Map(blobs.map((b) => [b.id, b.ciphertext]));
    // getAll orders by `id`, not enqueue time; enforce the canonical order every backend yields.
    return records
      .map((r) => ({ ...r, ciphertext: ciphertexts.get(r.id) ?? new Uint8Array() }))
      .sort(byEnqueueOrder);
  }

  async putAttachmentUpload(upload: PersistedAttachmentUpload): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ATTACHMENT_QUEUE, ATTACHMENT_BLOBS], "readwrite");
    const { ciphertext, ...info } = upload;
    tx.objectStore(ATTACHMENT_QUEUE).put(info);
    tx.objectStore(ATTACHMENT_BLOBS).put({ id: upload.id, ciphertext } satisfies BlobRecord);
    await txDone(tx);
  }

  async deleteAttachmentUpload(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([ATTACHMENT_QUEUE, ATTACHMENT_BLOBS], "readwrite");
    tx.objectStore(ATTACHMENT_QUEUE).delete(id);
    tx.objectStore(ATTACHMENT_BLOBS).delete(id);
    await txDone(tx);
  }

  async listAttachmentQueue(): Promise<AttachmentUploadInfo[]> {
    const db = await this.open();
    const tx = db.transaction(ATTACHMENT_QUEUE, "readonly");
    const records = await reqToPromise<AttachmentUploadInfo[]>(
      tx.objectStore(ATTACHMENT_QUEUE).getAll(),
    );
    return records.sort(byEnqueueOrder);
  }

  async loadAttachmentCiphertext(id: string): Promise<AttachmentCiphertext | null> {
    const db = await this.open();
    const tx = db.transaction(ATTACHMENT_BLOBS, "readonly");
    const record = await reqToPromise<BlobRecord | undefined>(
      tx.objectStore(ATTACHMENT_BLOBS).get(id),
    );
    return record?.ciphertext ?? null;
  }

  async updateAttachmentUpload(info: AttachmentUploadInfo): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(ATTACHMENT_QUEUE, "readwrite");
    const store = tx.objectStore(ATTACHMENT_QUEUE);
    // Read and write in one transaction, so a concurrent delete cannot slip in between.
    store.getKey(info.id).onsuccess = (event) => {
      if ((event.target as IDBRequest<IDBValidKey | undefined>).result !== undefined) {
        store.put(info);
      }
    };
    await txDone(tx);
  }
}

/** Lookups share the readwrite transaction: in a separate one another tab could add the op and abort the batch. */
function addMissing(tx: IDBTransaction, ops: Operation[], synced: boolean): void {
  const store = tx.objectStore(OPS);
  const index = store.index(OP_ID_INDEX);
  const seen = new Set<string>();
  for (const op of ops) {
    if (seen.has(op.id)) continue;
    seen.add(op.id);
    // No awaits between the requests, or the transaction would commit before the `add`.
    index.getKey(op.id).onsuccess = (event) => {
      if ((event.target as IDBRequest<IDBValidKey | undefined>).result !== undefined) return;
      store.add({ op_id: op.id, synced, op } satisfies OpRecord);
    };
  }
}

/** Runs inside the upgrade transaction so a failure leaves v2 untouched. */
function moveCiphertextOut(tx: IDBTransaction): void {
  const queue = tx.objectStore(ATTACHMENT_QUEUE);
  const blobs = tx.objectStore(ATTACHMENT_BLOBS);
  queue.openCursor().onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
    if (!cursor) return;
    const { ciphertext, ...info } = cursor.value as PersistedAttachmentUpload;
    if (ciphertext) blobs.put({ id: info.id, ciphertext } satisfies BlobRecord);
    cursor.update(info);
    cursor.continue();
  };
}

function deleteRepairs(meta: IDBObjectStore): void {
  const keys = meta.getAllKeys();
  keys.onsuccess = () => {
    for (const key of keys.result) {
      if (typeof key === "string" && key.startsWith(BOOTSTRAP_REPAIRS_PREFIX)) meta.delete(key);
    }
  };
}

function epochOf(record: unknown): number {
  const v = (record as { value?: unknown } | undefined)?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function byEnqueueOrder(a: AttachmentUploadInfo, b: AttachmentUploadInfo): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
