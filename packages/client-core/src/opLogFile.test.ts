import { describe, it, expect } from "bun:test";
import {
  OP_LOG_FILE_FORMAT,
  OpLogFileError,
  decodeOpLogFile,
  encodeOpLogFile,
  mergeOpLogs,
} from "./opLogFile";
import type { Operation } from "./types";

const NODE = "00000000-0000-0000-0000-0000000000f1";

function op(id: string, wallMs: number, value = id): Operation {
  return {
    id,
    entity: "task",
    entityId: "t1",
    ts: { wallMs, counter: 0, node: NODE },
    op: "set",
    field: "title",
    value,
  };
}

describe("op-log file", () => {
  it("round-trips ops, ordered by HLC", () => {
    const text = encodeOpLogFile([op("b", 2), op("a", 1)]);
    expect(decodeOpLogFile(text).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("skips malformed ops inside a readable file", () => {
    const text = JSON.stringify({
      format: OP_LOG_FILE_FORMAT,
      version: 1,
      ops: [op("a", 1), { id: "bad" }],
    });
    expect(decodeOpLogFile(text).map((o) => o.id)).toEqual(["a"]);
  });

  it.each([
    ["not json", "not_json"],
    [JSON.stringify({ format: "other", ops: [] }), "not_op_log"],
    [JSON.stringify({ format: OP_LOG_FILE_FORMAT, version: 99, ops: [] }), "newer_version"],
  ])("refuses %s", (text, reason) => {
    expect(() => decodeOpLogFile(text)).toThrow(OpLogFileError);
    try {
      decodeOpLogFile(text);
    } catch (err) {
      expect<string>((err as OpLogFileError).reason).toBe(reason);
    }
  });

  it("merges copies into one op per id", () => {
    const merged = mergeOpLogs([op("a", 1), op("c", 3)], [op("b", 2), op("a", 1)]);
    expect(merged.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
});
