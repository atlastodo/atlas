import { describe, it, expect } from "vitest";
import { HlcClock, MAX_COUNTER, compareHlc, type Hlc } from "./hlc";

const NODE_A = "00000000-0000-0000-0000-00000000000a";
const NODE_B = "00000000-0000-0000-0000-00000000000b";

describe("HlcClock", () => {
  it("is strictly monotonic even without physical progress", () => {
    const c = new HlcClock(NODE_A);
    const a = c.now(1000);
    const b = c.now(1000);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(b.counter).toBe(1);
  });

  it("ignores a backwards physical clock", () => {
    const c = new HlcClock(NODE_A);
    c.now(5000);
    const t = c.now(1000);
    expect(t.wallMs).toBe(5000);
    expect(t.counter).toBe(1);
  });

  it("dominates a received remote timestamp", () => {
    const c = new HlcClock(NODE_A);
    const remote: Hlc = { wallMs: 9000, counter: 3, node: NODE_B };
    const local = c.update(remote, 1000);
    expect(compareHlc(local, remote)).toBeGreaterThan(0);
    expect(local.node).toBe(NODE_A);
  });
});

describe("compareHlc", () => {
  it("breaks ties by node id deterministically", () => {
    const lo: Hlc = { wallMs: 1, counter: 0, node: NODE_A };
    const hi: Hlc = { wallMs: 1, counter: 0, node: NODE_B };
    expect(compareHlc(lo, hi)).toBeLessThan(0);
  });
});

describe("HlcClock counter bound", () => {
  it("carries a counter past MAX_COUNTER into the next millisecond, as hlc.rs does", () => {
    const remote: Hlc = { wallMs: 1000, counter: 2 ** 32 - 1, node: NODE_B };
    const a = new HlcClock(NODE_A).update(remote, 1000);
    expect(compareHlc(a, remote)).toBeGreaterThan(0);
    expect([a.wallMs, a.counter]).toEqual([1001, 0]);

    const c = new HlcClock(NODE_A);
    let last = c.now(5000);
    for (let i = 0; i < MAX_COUNTER; i++) last = c.now(5000);
    expect([last.wallMs, last.counter]).toEqual([5000, MAX_COUNTER]);
    const next = c.now(5000);
    expect([next.wallMs, next.counter]).toEqual([5001, 0]);
  });
});
