import { describe, expect, test } from "bun:test";
import { isEncryptedEnvelope } from "./envelope";
import { Keyring } from "./keyring";
import { fromEncryptedWire, toEncryptedWire } from "../api";
import type { Operation } from "../types";

describe("isEncryptedEnvelope", () => {
  test("recognises the wire form of an encrypted field", () => {
    expect(isEncryptedEnvelope({ __enc: 1, iv: "aXY=", ct: "Y3Q=" })).toBe(true);
  });

  test("recognises a field another key encrypted, as it lands after a failed decrypt", () => {
    const op: Operation = {
      id: "op1",
      entity: "task",
      entityId: "t1",
      ts: { wallMs: 1, counter: 0, node: "n" },
      op: "set",
      field: "title",
      value: "Buy milk",
    };
    const theirs = new Keyring({ dek: new Uint8Array(32).fill(7) });
    const mine = new Keyring({ dek: new Uint8Array(32).fill(9) });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const landed = fromEncryptedWire(toEncryptedWire(op, theirs), mine);
      expect(landed.op === "set" && isEncryptedEnvelope(landed.value)).toBe(true);
    } finally {
      console.warn = warn;
    }
  });

  test("rejects plain values and look-alikes", () => {
    for (const v of [
      null,
      undefined,
      "",
      "title",
      0,
      [],
      ["l1"],
      {},
      { __enc: 2, iv: "a", ct: "b" },
      { __enc: "1", iv: "a", ct: "b" },
      { __enc: 1, iv: "a" },
      { __enc: 1, iv: 1, ct: "b" },
    ]) {
      expect(isEncryptedEnvelope(v)).toBe(false);
    }
  });
});
