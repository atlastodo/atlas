import type { SqlDatabase, SqlExecuteResult } from "./persistence";
import type { ExpoSqliteDatabase } from "./expo-sqlite";

/**
 * An in-memory stand-in for {@link SqlDatabase}, implementing the statements
 * {@link SqlitePersistence} issues. It lets us exercise the real serialization +
 * bookkeeping logic in tests without a native SQLite runtime.
 */
export class FakeSqlDatabase implements SqlDatabase {
  private readonly ops: Record<string, unknown>[] = [];
  private readonly opIndex = new Set<string>();
  private readonly meta = new Map<string, string>();
  /** Device-local attachment upload queue rows, keyed by id (mirrors the table's PRIMARY KEY). */
  private readonly attachments = new Map<string, Record<string, unknown>>();

  async execute(query: string, params: unknown[] = []): Promise<SqlExecuteResult> {
    const q = query.trim().toUpperCase();
    if (q.startsWith("CREATE TABLE")) return { rowsAffected: 0 };
    if (q.startsWith("BEGIN") || q.startsWith("COMMIT") || q.startsWith("ROLLBACK")) {
      return { rowsAffected: 0 };
    }
    if (
      q.startsWith("DELETE FROM OPS WHERE SYNCED = 1 AND OP_ID IN") ||
      q.startsWith("DELETE FROM OPS WHERE OP_ID IN")
    ) {
      const ids = new Set(params as string[]);
      const onlySynced = q.includes("SYNCED = 1");
      const kept = this.ops.filter(
        (r) => (onlySynced && r.synced !== 1) || !ids.has(r.op_id as string),
      );
      const n = this.ops.length - kept.length;
      this.ops.length = 0;
      this.opIndex.clear();
      for (const r of kept) {
        this.ops.push(r);
        this.opIndex.add(r.op_id as string);
      }
      return { rowsAffected: n };
    }
    if (q.startsWith("DELETE FROM OPS WHERE SYNCED = 1")) {
      const kept = this.ops.filter((r) => r.synced !== 1);
      const n = this.ops.length - kept.length;
      this.ops.length = 0;
      this.opIndex.clear();
      for (const r of kept) {
        this.ops.push(r);
        this.opIndex.add(r.op_id as string);
      }
      return { rowsAffected: n };
    }
    if (q.startsWith("DELETE FROM OPS")) {
      const n = this.ops.length;
      this.ops.length = 0;
      this.opIndex.clear();
      return { rowsAffected: n };
    }
    if (q.startsWith("DELETE FROM META WHERE KEY LIKE")) {
      const prefix = likePrefixOf(query);
      let n = 0;
      for (const k of [...this.meta.keys()]) if (k.startsWith(prefix) && this.meta.delete(k)) n++;
      return { rowsAffected: n };
    }
    if (q.startsWith("DELETE FROM META")) {
      const key = metaKeyOf(query);
      if (key !== undefined) return { rowsAffected: this.meta.delete(key) ? 1 : 0 };
      const n = this.meta.size;
      this.meta.clear();
      return { rowsAffected: n };
    }
    if (q.startsWith("DELETE FROM ATTACHMENT_QUEUE WHERE ID")) {
      const deleted = this.attachments.delete(params[0] as string);
      return { rowsAffected: deleted ? 1 : 0 };
    }
    if (q.startsWith("INSERT OR IGNORE INTO OPS")) {
      const [op_id, entity, entity_id, kind, field, value_json, ts_json, synced] = params;
      if (this.opIndex.has(op_id as string)) return { rowsAffected: 0 };
      this.opIndex.add(op_id as string);
      this.ops.push({ op_id, entity, entity_id, kind, field, value_json, ts_json, synced });
      return { rowsAffected: 1 };
    }
    if (q.startsWith("INSERT INTO ATTACHMENT_QUEUE")) {
      // One upsert statement serves insert and update: ON CONFLICT(id) DO UPDATE replaces the row.
      const [
        id,
        task_id,
        project_id,
        blob_sha,
        blob_size,
        ciphertext,
        wrapped_key_json,
        meta_json,
        thumb_sha,
        sort_order,
        created_at,
        state,
        attempts,
        next_attempt_at,
        last_error,
        meta_released,
      ] = params;
      this.attachments.set(id as string, {
        id,
        task_id,
        project_id,
        blob_sha,
        blob_size,
        ciphertext,
        wrapped_key_json,
        meta_json,
        thumb_sha,
        sort_order,
        created_at,
        state,
        attempts,
        next_attempt_at,
        last_error,
        meta_released,
      });
      return { rowsAffected: 1 };
    }
    if (q.startsWith("UPDATE ATTACHMENT_QUEUE SET")) {
      // Every column but the ciphertext, then the id; a missing row is left missing.
      const [
        task_id,
        project_id,
        blob_sha,
        blob_size,
        wrapped_key_json,
        meta_json,
        thumb_sha,
        sort_order,
        created_at,
        state,
        attempts,
        next_attempt_at,
        last_error,
        meta_released,
        id,
      ] = params;
      const current = this.attachments.get(id as string);
      if (!current) return { rowsAffected: 0 };
      this.attachments.set(id as string, {
        ...current,
        task_id,
        project_id,
        blob_sha,
        blob_size,
        wrapped_key_json,
        meta_json,
        thumb_sha,
        sort_order,
        created_at,
        state,
        attempts,
        next_attempt_at,
        last_error,
        meta_released,
      });
      return { rowsAffected: 1 };
    }
    if (q.startsWith("UPDATE OPS SET TS_JSON")) {
      const [tsJson, opId] = params as [string, string];
      const row = this.ops.find((r) => r.op_id === opId);
      if (row) row.ts_json = tsJson;
      return { rowsAffected: row ? 1 : 0 };
    }
    if (q.startsWith("UPDATE OPS SET SYNCED")) {
      const ids = new Set(params as string[]);
      let n = 0;
      for (const row of this.ops) {
        if (ids.has(row.op_id as string)) {
          row.synced = 1;
          n++;
        }
      }
      return { rowsAffected: n };
    }
    if (q.startsWith("INSERT INTO META")) {
      // A bound key (`VALUES (?, ?)`) or a literal one (`VALUES ('cursor', ?)`).
      if (/VALUES\s*\(\s*\?/i.test(query)) this.meta.set(String(params[0]), String(params[1]));
      else this.meta.set(metaKeyOf(query) ?? "cursor", String(params[0]));
      return { rowsAffected: 1 };
    }
    throw new Error(`FakeSqlDatabase: unhandled execute: ${query}`);
  }

  async select<T>(query: string, params: unknown[] = []): Promise<T> {
    const q = query.trim().toUpperCase();
    if (q.startsWith("SELECT CIPHERTEXT FROM ATTACHMENT_QUEUE WHERE ID")) {
      const row = this.attachments.get(params[0] as string);
      return (row ? [{ ciphertext: row.ciphertext }] : []) as unknown as T;
    }
    if (q.startsWith("SELECT") && q.includes("FROM ATTACHMENT_QUEUE")) {
      // Mirror the statement's ORDER BY created_at ASC, id ASC, and leave out the ciphertext
      // column when the statement does not select it.
      const created = (r: Record<string, unknown>) => r.created_at as number;
      const id = (r: Record<string, unknown>) => r.id as string;
      const withCiphertext = q.includes("CIPHERTEXT");
      const rows = [...this.attachments.values()]
        .sort((a, b) => created(a) - created(b) || (id(a) < id(b) ? -1 : 1))
        .map((r) => {
          if (withCiphertext) return r;
          const { ciphertext: _c, ...rest } = r;
          return rest;
        });
      return rows as unknown as T;
    }
    if (q.startsWith("SELECT") && q.includes("FROM OPS")) {
      // Insertion order is preserved by the array; mirror `ORDER BY seq ASC`.
      return this.ops.map((r) => ({ ...r })) as unknown as T;
    }
    if (q.startsWith("SELECT VALUE FROM META WHERE KEY LIKE")) {
      const prefix = likePrefixOf(query);
      const rows = [...this.meta.entries()].filter(([k]) => k.startsWith(prefix));
      return rows.map(([, value]) => ({ value })) as unknown as T;
    }
    if (q.startsWith("SELECT VALUE FROM META")) {
      const v = this.meta.get(metaKeyOf(query) ?? "cursor");
      return (v === undefined ? [] : [{ value: v }]) as unknown as T;
    }
    void params;
    throw new Error(`FakeSqlDatabase: unhandled select: ${query}`);
  }
}

/** The prefix of a `key LIKE 'prefix%'` pattern. */
function likePrefixOf(query: string): string {
  return /LIKE\s*'([^%']*)%'/i.exec(query)?.[1] ?? "";
}

/** The literal meta key a statement names (`VALUES ('cursor', ?)` or `key = 'bootstrap'`). */
function metaKeyOf(query: string): string | undefined {
  return /(?:VALUES\s*\(|key\s*=\s*)'(\w+)'/i.exec(query)?.[1];
}

/**
 * An in-memory stand-in for expo-sqlite's `SQLiteDatabase`, so `ExpoSqlDatabase` can be
 * driven through the conformance battery without a device: neither `bun:sqlite` nor `node:sqlite`
 * is resolvable under vitest, so a real engine is not an option here.
 *
 * It deliberately delegates to {@link FakeSqlDatabase} rather than re-stubbing the statements: the
 * storage behaviour is asserted once, and what this adds is the *inverse* of the adapter's
 * translation (`rowsAffected`/`lastInsertId` back to SQLite's `changes`/`lastInsertRowId`). Running
 * the battery through the pair therefore fails loudly if the adapter maps a field or binds a
 * parameter wrongly, which is exactly the logic `ExpoSqlDatabase` owns.
 */
export class FakeExpoDatabase implements ExpoSqliteDatabase {
  private readonly inner = new FakeSqlDatabase();

  async runAsync(
    source: string,
    params: unknown[],
  ): Promise<{ lastInsertRowId: number; changes: number }> {
    const result = await this.inner.execute(source, params);
    return { lastInsertRowId: result.lastInsertId ?? 0, changes: result.rowsAffected };
  }

  async getAllAsync<T>(source: string, params: unknown[]): Promise<T[]> {
    return await this.inner.select<T[]>(source, params);
  }
}
