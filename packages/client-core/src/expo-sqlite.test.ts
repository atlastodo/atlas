import { describe, it, expect } from "bun:test";
import { ExpoSqlDatabase, type ExpoSqliteDatabase } from "./expo-sqlite";

/**
 * Focused tests for the expo-sqlite -> {@link SqlDatabase} translation.
 *
 * These exist *because* the conformance battery cannot cover this: {@link SqlitePersistence} never
 * reads `rowsAffected`/`lastInsertId` back, and the fake DB ignores select parameters; so the
 * battery still passes if the adapter swaps those fields or drops its binds (verified by mutating
 * the adapter). The battery proves the store contract holds end-to-end through the adapter; the
 * translation itself is pinned here.
 */

/** Records every call so the exact query + binds handed to expo can be asserted. */
class RecordingExpoDatabase implements ExpoSqliteDatabase {
  readonly runCalls: { source: string; params: unknown[] }[] = [];
  readonly getAllCalls: { source: string; params: unknown[] }[] = [];

  constructor(
    private readonly runResult = { lastInsertRowId: 0, changes: 0 },
    private readonly rows: unknown[] = [],
  ) {}

  async runAsync(source: string, params: unknown[]) {
    this.runCalls.push({ source, params });
    return this.runResult;
  }

  async getAllAsync<T>(source: string, params: unknown[]): Promise<T[]> {
    this.getAllCalls.push({ source, params });
    return this.rows as T[];
  }
}

describe("ExpoSqlDatabase.execute", () => {
  it("maps SQLite's counters onto the port's result shape", async () => {
    // Distinct values: a swap of the two fields must fail this.
    const db = new RecordingExpoDatabase({ lastInsertRowId: 42, changes: 7 });

    const result = await new ExpoSqlDatabase(db).execute("INSERT INTO ops VALUES (?)", ["a"]);

    expect(result).toEqual({ rowsAffected: 7, lastInsertId: 42 });
  });

  it("passes the statement and its bind values through untouched", async () => {
    const db = new RecordingExpoDatabase();

    await new ExpoSqlDatabase(db).execute("UPDATE ops SET synced = 1 WHERE op_id IN (?,?)", [
      "op-1",
      "op-2",
    ]);

    expect(db.runCalls).toEqual([
      { source: "UPDATE ops SET synced = 1 WHERE op_id IN (?,?)", params: ["op-1", "op-2"] },
    ]);
  });

  it("binds an empty array when no values are given", async () => {
    const db = new RecordingExpoDatabase();

    await new ExpoSqlDatabase(db).execute("CREATE TABLE IF NOT EXISTS ops (op_id TEXT)");

    expect(db.runCalls[0]?.params).toEqual([]);
  });
});

describe("ExpoSqlDatabase.select", () => {
  it("returns the rows expo yields", async () => {
    const rows = [{ value: "12" }];
    const db = new RecordingExpoDatabase(undefined, rows);

    const got = await new ExpoSqlDatabase(db).select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key = 'cursor'",
    );

    expect(got).toEqual(rows);
  });

  it("passes the query and its bind values through untouched", async () => {
    const db = new RecordingExpoDatabase();

    await new ExpoSqlDatabase(db).select("SELECT * FROM ops WHERE op_id = ?", ["op-1"]);

    expect(db.getAllCalls).toEqual([
      { source: "SELECT * FROM ops WHERE op_id = ?", params: ["op-1"] },
    ]);
  });
});
