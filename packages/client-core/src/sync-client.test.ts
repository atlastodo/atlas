import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiError, E2eeLockedError, UpgradeRequiredError } from "./api";
import { LocalStore, PersistError } from "./store";
import { MemoryPersistence } from "./persistence";
import {
  SyncClient,
  type SyncClientOptions,
  type SyncResult,
  type SyncTransport,
} from "./sync-client";
import { compareHlc } from "./hlc";
import type { Operation } from "./types";

const NODE_A = "00000000-0000-0000-0000-0000000000a1";
const NODE_B = "00000000-0000-0000-0000-0000000000a2";

/** A fake server: an append-only op log with cursor = log length, like the real /sync endpoints. */
function fakeServer() {
  const log: Operation[] = [];
  const transport: SyncTransport = {
    syncPush: vi.fn(async (ops: Operation[]) => {
      for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
      return { cursor: log.length, applied: ops.length };
    }),
    syncPull: vi.fn(async (since: number) => ({
      operations: log.slice(since),
      cursor: log.length,
    })),
  };
  return { log, transport };
}

/** Like `fakeServer`, but its push answers `from` (the log head before the batch), as the real one does. */
function fromServer() {
  const server = fakeServer();
  server.transport.syncPush = vi.fn(async (ops: Operation[]) => {
    const from = server.log.length;
    for (const op of ops) if (!server.log.some((o) => o.id === op.id)) server.log.push(op);
    return { cursor: server.log.length, applied: server.log.length - from, from };
  });
  return server;
}

function store(node: string, start = 1000) {
  let t = start;
  let n = 0;
  return new LocalStore(node, { now: () => t++, newId: () => `op-${node}-${n++}` });
}

describe("SyncClient", () => {
  it("pushes unsynced ops exactly once and clears the outbox", async () => {
    const server = fakeServer();
    const s = store(NODE_A);
    s.set("task", "t1", "title", "hello");
    const client = new SyncClient(s, server.transport);

    const first = await client.sync();
    expect(first.pushed).toBe(1);
    expect(s.unsyncedOps()).toHaveLength(0);

    // A second cycle has nothing new to push.
    const second = await client.sync();
    expect(second.pushed).toBe(0);
    expect(server.transport.syncPush).toHaveBeenCalledTimes(1);
  });

  it("applies pulled remote ops and advances the persisted cursor", async () => {
    const server = fakeServer();
    // Seed the server with an op from another device.
    const other = store(NODE_B, 5000);
    server.log.push(other.set("task", "t9", "title", "from-b"));

    const cursors: number[] = [];
    const s = store(NODE_A);
    const client = new SyncClient(s, server.transport, { onCursor: (c) => cursors.push(c) });

    const res = await client.sync();
    expect(res.pulled).toBe(1);
    expect(s.get("task", "t9")).toEqual({ title: "from-b" });
    expect(cursors.at(-1)).toBe(1);
    expect(client.currentCursor()).toBe(1);
  });

  it("keeps ops unsynced and reports offline when push fails", async () => {
    const s = store(NODE_A);
    s.set("task", "t1", "title", "queued");
    const statuses: string[] = [];
    const transport: SyncTransport = {
      syncPush: vi.fn(async () => {
        throw new Error("network down");
      }),
      syncPull: vi.fn(async () => ({ operations: [], cursor: 0 })),
    };
    const client = new SyncClient(s, transport, { onStatus: (st) => statuses.push(st) });

    await expect(client.sync()).rejects.toThrow(/network down/);
    expect(s.unsyncedOps()).toHaveLength(1); // preserved for retry
    expect(client.currentStatus()).toBe("offline");
    expect(statuses).toContain("offline");
  });

  it("spins during the initial sync even with nothing to push (the backfill case)", async () => {
    const server = fakeServer();
    // Server has history from another device; a fresh session must show it is downloading it.
    const other = store(NODE_B, 5000);
    server.log.push(other.set("task", "t9", "title", "from-b"));

    const s = store(NODE_A);
    const statuses: string[] = [];
    const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

    const res = await client.sync();
    expect(res.pulled).toBe(1);
    // The badge spins while the initial backfill downloads, rather than reading "Synced" the whole
    // time; then settles to idle.
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("stays idle without emitting any status on a routine empty poll after the initial sync", async () => {
    const server = fakeServer();
    const s = store(NODE_A);
    const statuses: string[] = [];
    const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

    // First cycle completes the initial sync (spins, per the test above).
    await client.sync();
    statuses.length = 0;

    // A subsequent poll with nothing to push and nothing to pull must not churn the status (which
    // would re-render the UI every interval even though nothing changed).
    const res = await client.sync();
    expect(res).toMatchObject({ pushed: 0, pulled: 0 });
    expect(statuses).toEqual([]);
    expect(client.currentStatus()).toBe("idle");
  });

  it("shows syncing then idle only when there are local ops to push", async () => {
    const server = fakeServer();
    const s = store(NODE_A);
    s.set("task", "t1", "title", "x");
    const statuses: string[] = [];
    const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

    await client.sync();
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("coalesces concurrent syncs so a batch is pushed only once", async () => {
    const server = fakeServer();
    const s = store(NODE_A);
    s.set("task", "t1", "title", "x");
    const client = new SyncClient(s, server.transport);

    const [a, b] = await Promise.all([client.sync(), client.sync()]);
    expect(a).toBe(b); // same in-flight result
    expect(server.transport.syncPush).toHaveBeenCalledTimes(1);
  });

  it("quarantines a permanently-rejected op and still syncs the rest of the batch", async () => {
    const s = store(NODE_A);
    const good1 = s.set("task", "t1", "title", "keep me");
    const poison = s.set("task", "t2", "title", "reject me");
    const good2 = s.set("task", "t3", "title", "keep me too");

    // A server that rejects the *whole* batch (rollback, like the real one) if it contains the poison
    // op.
    const log: Operation[] = [];
    const transport: SyncTransport = {
      syncPush: vi.fn(async (ops: Operation[]) => {
        if (ops.some((o) => o.id === poison.id)) throw new ApiError(403, "requires commenter role");
        for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
        return { cursor: log.length, applied: ops.length };
      }),
      syncPull: vi.fn(async (since: number) => ({
        operations: log.slice(since),
        cursor: log.length,
      })),
    };
    const quarantined: Operation[] = [];
    const client = new SyncClient(s, transport, { onQuarantine: (op) => quarantined.push(op) });

    await client.sync();

    // The poison op is dropped from the outbox; the two good ops reached the server.
    expect(s.unsyncedOps()).toHaveLength(0);
    expect(log.map((o) => o.id).sort()).toEqual([good1.id, good2.id].sort());
    expect(quarantined.map((o) => o.id)).toEqual([poison.id]);

    // A later cycle no longer retries the poison op; sync is unwedged.
    await client.sync();
    expect(client.currentStatus()).toBe("idle");
  });

  it("does not quarantine on a transient (5xx) push error: it retries the whole batch", async () => {
    const s = store(NODE_A);
    s.set("task", "t1", "title", "x");
    const quarantined: Operation[] = [];
    const transport: SyncTransport = {
      syncPush: vi.fn(async () => {
        throw new ApiError(503, "unavailable");
      }),
      syncPull: vi.fn(async () => ({ operations: [], cursor: 0 })),
    };
    const client = new SyncClient(s, transport, { onQuarantine: (op) => quarantined.push(op) });

    await expect(client.sync()).rejects.toBeInstanceOf(ApiError);
    expect(s.unsyncedOps()).toHaveLength(1); // preserved for retry, never dropped
    expect(quarantined).toHaveLength(0);
  });

  it("treats a locked keyring as transient: nothing is pushed, quarantined or bisected", async () => {
    const s = store(NODE_A);
    s.set("task", "t1", "title", "secret one");
    s.set("task", "t2", "title", "secret two");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ cursor: 2, applied: 2, operations: [] })),
    );
    // A real ApiClient with no keyring: the same shape as a session restored without its keys.
    const api = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });
    const quarantined: Operation[] = [];
    const client = new SyncClient(s, api, { onQuarantine: (op) => quarantined.push(op) });

    await expect(client.sync()).rejects.toBeInstanceOf(E2eeLockedError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(quarantined).toHaveLength(0);
    expect(s.unsyncedOps()).toHaveLength(2); // kept whole for the cycle after unlocking
  });

  it("stops syncing on an upgrade-required answer instead of retrying it", async () => {
    // The server refuses this build's protocol: only an app update helps, so hammering it every
    // poll is pointless; and the outbox must survive intact for the updated build to push.
    const s = store(NODE_A);
    s.set("task", "t1", "title", "kept for the update");
    const transport: SyncTransport = {
      syncPush: vi.fn(async () => {
        throw new UpgradeRequiredError(3);
      }),
      syncPull: vi.fn(async () => ({ operations: [], cursor: 0 })),
    };
    const quarantined: Operation[] = [];
    const client = new SyncClient(s, transport, { onQuarantine: (op) => quarantined.push(op) });

    await expect(client.sync()).rejects.toBeInstanceOf(UpgradeRequiredError);
    await client.sync(); // a later poll does not touch the server at all

    expect(transport.syncPush).toHaveBeenCalledTimes(1);
    expect(transport.syncPull).not.toHaveBeenCalled();
    expect(quarantined).toHaveLength(0);
    expect(s.unsyncedOps()).toHaveLength(1);
  });

  it("offline edit then reconnect converges on a second device", async () => {
    const server = fakeServer();

    // Device A edits while "offline" (ops queue in the store), then syncs on reconnect.
    const a = store(NODE_A, 1000);
    a.set("task", "t1", "title", "Groceries");
    a.set("task", "t1", "notes", "milk, eggs");
    const syncA = new SyncClient(a, server.transport);
    await syncA.sync();

    // Device B syncs and sees A's edits.
    const b = store(NODE_B, 2000);
    const syncB = new SyncClient(b, server.transport);
    await syncB.sync();

    expect(b.get("task", "t1")).toEqual({ title: "Groceries", notes: "milk, eggs" });

    // B makes a concurrent edit; after both sync, they converge.
    b.set("task", "t1", "title", "Weekend groceries");
    await syncB.sync();
    await syncA.sync();
    expect(a.get("task", "t1")).toEqual(b.get("task", "t1"));
  });

  /** A server that pages `/sync/pull` at `pageSize` ops/page, like the real backend's 500-op cap. */
  function pagedServer(pageSize: number) {
    const log: Operation[] = [];
    const transport: SyncTransport = {
      syncPush: vi.fn(async (ops: Operation[]) => {
        for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
        return { cursor: log.length, applied: ops.length };
      }),
      syncPull: vi.fn(async (since: number) => ({
        operations: log.slice(since, since + pageSize),
        cursor: Math.min(since + pageSize, log.length),
      })),
    };
    return { log, transport };
  }

  describe("paged backfill draining", () => {
    it("drains every page in a single cycle instead of one page per poll", async () => {
      const server = pagedServer(2);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 5; i++) server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));

      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport);
      const r = await client.sync();

      // All 5 ops arrive in ONE cycle (not just the first 2-op page).
      expect(r.pulled).toBe(5);
      expect(r.cursor).toBe(5);
      expect(s.get("task", "t4")).toEqual({ title: "v4" });
      // ceil(5/2) = 3 data pulls + 1 confirm-empty page.
      expect(server.transport.syncPull).toHaveBeenCalledTimes(4);
    });

    it("signals 'syncing' while pulling incoming changes (not just on push)", async () => {
      const server = pagedServer(2);
      const statuses: string[] = [];
      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

      // Initial (empty) sync marks the client caught up.
      await client.sync();
      statuses.length = 0;

      // Another device pushes a multi-page batch; the next poll must show "syncing", then settle.
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 3; i++) server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));
      await client.sync();

      expect(statuses).toContain("syncing");
      expect(statuses.at(-1)).toBe("idle");
    });

    it("stays 'idle' on a quiet poll with nothing to pull", async () => {
      const server = pagedServer(2);
      const statuses: string[] = [];
      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

      await client.sync(); // initial
      statuses.length = 0;
      await client.sync(); // quiet: nothing changed

      expect(statuses).not.toContain("syncing");
    });
  });

  describe("orphaned-cursor self-healing", () => {
    it("self-heals an orphaned cursor on the first cycle: resets to 0 and backfills", async () => {
      const server = pagedServer(30);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 30; i++) server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));

      // Resumed with cursor 50, but the server's history is only 30 ops long (it was replaced since
      // that cursor was persisted). Pulling from 50 returns nothing forever, and with an empty local
      // store that cursor is orphaned; the first cycle must reset to 0 and backfill.
      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport, { cursor: 50 });

      const r = await client.sync();
      expect(r.pulled).toBe(30);
      expect(r.cursor).toBe(30);
      expect(s.get("task", "t29")).toEqual({ title: "v29" });
      expect(server.transport.syncPull).toHaveBeenCalledWith(0);
    });

    it("does not reset a well-formed cursor when the store already has data", async () => {
      const server = pagedServer(30);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 30; i++) server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));

      const s = store(NODE_A);
      s.set("task", "local", "title", "kept"); // the store is not empty; nothing is orphaned
      const client = new SyncClient(s, server.transport, { cursor: 30 });

      await client.sync();
      expect(server.transport.syncPull).not.toHaveBeenCalledWith(0);
    });

    it("attempts the self-heal once, never again on later quiet polls", async () => {
      // A server history made only of hard tombstones: a resumed client applying it keeps ZERO
      // visible entities, the exact shape a reset-happy check would re-download on every poll.
      const server = pagedServer(30);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 5; i++) {
        server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));
        server.log.push(seed.remove("task", `t${i}`));
      }

      const s = store(NODE_A); // empty store, resumed at the server's tip
      const client = new SyncClient(s, server.transport, { cursor: server.log.length });
      await client.sync();

      const healsAfterFirst = vi
        .mocked(server.transport.syncPull)
        .mock.calls.filter(([since]) => since === 0).length;
      expect(healsAfterFirst).toBeGreaterThanOrEqual(1); // healed once

      await client.sync();
      const healsAfterSecond = vi
        .mocked(server.transport.syncPull)
        .mock.calls.filter(([since]) => since === 0).length;
      expect(healsAfterSecond).toBe(healsAfterFirst); // never again
    });
  });

  describe("rate limiting (429)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reads Retry-After off a refused request", async () => {
      const api = new ApiClient({
        baseUrl: "http://x",
        token: "t",
        fetch: async () =>
          new Response(JSON.stringify({ error: "too many requests" }), {
            status: 429,
            headers: { "retry-after": "7" },
          }),
      });
      const err = await api.listInvites().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).retryAfterMs).toBe(7000);
    });

    it("backs off for Retry-After without reading as offline, then resumes by itself", async () => {
      const server = fakeServer();
      const pull = server.transport.syncPull;
      let refuse = true;
      server.transport.syncPull = vi.fn(async (since: number) => {
        if (refuse) {
          refuse = false;
          throw new ApiError(429, "too many requests", { error: "too many requests" }, 3000);
        }
        return pull(since);
      });
      const statuses: string[] = [];
      const client = new SyncClient(store(NODE_A), server.transport, {
        onStatus: (st) => statuses.push(st),
      });

      await expect(client.sync()).rejects.toBeInstanceOf(ApiError);
      expect(client.currentStatus()).toBe("throttled");

      // Polls inside the window do not touch the server.
      const skipped = await client.sync();
      expect(skipped.skipped).toBe("throttled");
      await vi.advanceTimersByTimeAsync(2_999);
      expect(server.transport.syncPull).toHaveBeenCalledTimes(1);

      // Once the window has passed, the client syncs again without waiting for a poll.
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(client.currentStatus()).toBe("idle"));
      expect(server.transport.syncPull).toHaveBeenCalledTimes(2);
      expect(statuses).not.toContain("offline");
    });

    it("reports each completed cycle, including one it ran by itself, and never a failed or skipped one", async () => {
      const server = fakeServer();
      const pull = server.transport.syncPull;
      let refuse = true;
      server.transport.syncPull = vi.fn(async (since: number) => {
        if (refuse) {
          refuse = false;
          throw new ApiError(429, "too many requests", undefined, 1000);
        }
        return pull(since);
      });
      const synced: SyncResult[] = [];
      const client = new SyncClient(store(NODE_A), server.transport, {
        onSynced: (r) => synced.push(r),
      });

      await expect(client.sync()).rejects.toBeInstanceOf(ApiError);
      await client.sync(); // skipped inside the wait
      expect(synced).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000); // the client's own resume cycle
      await vi.waitFor(() => expect(synced).toHaveLength(1));
      expect(synced[0]!.skipped).toBeUndefined();
    });

    it("keeps the pages a paged pull received before a 429", async () => {
      const server = pagedServer(2);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 5; i++) server.log.push(seed.set("task", `t${i}`, "title", `v${i}`));
      const pull = server.transport.syncPull;
      server.transport.syncPull = vi.fn(async (since: number) => {
        if (since === 4) throw new ApiError(429, "too many requests", undefined, 1000);
        return pull(since);
      });
      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport);

      await expect(client.sync()).rejects.toBeInstanceOf(ApiError);

      // Two pages arrived before the refusal: applied, and the cursor past them.
      expect(s.get("task", "t3")).toEqual({ title: "v3" });
      expect(client.currentCursor()).toBe(4);
    });
  });

  describe("clock skew", () => {
    const HOUR = 60 * 60_000;
    const TOLERANCE = 5 * 60_000;

    /** A device whose clock runs an hour fast, and a server that refuses its far-ahead stamps. */
    function skewed() {
      const clock = { device: 10_000_000 + HOUR };
      const serverNow = () => clock.device - HOUR;
      let n = 0;
      const s = new LocalStore(NODE_A, { now: () => clock.device, newId: () => `op-${n++}` });
      const server = fakeServer();
      const push = server.transport.syncPush;
      const refused: Operation[][] = [];
      server.transport.syncPush = vi.fn(async (ops: Operation[]) => {
        if (ops.some((o) => o.ts.wallMs > serverNow() + TOLERANCE)) {
          refused.push(ops);
          throw new ApiError(400, "clock skew", { code: "clock_skew", server_time: serverNow() });
        }
        return push(ops);
      });
      return { s, server, clock, serverNow, refused };
    }

    it("re-stamps the queued edits by the server's clock and pushes them in the same cycle", async () => {
      const { s, server, clock, serverNow, refused } = skewed();
      const one = s.set("task", "t1", "title", "one");
      const two = s.set("task", "t1", "title", "two");
      const notes = s.set("task", "t2", "notes", "n");
      const quarantined: Operation[] = [];
      const client = new SyncClient(s, server.transport, {
        onQuarantine: (op) => quarantined.push(op),
      });

      await client.sync();

      expect(quarantined).toEqual([]);
      expect(refused).toHaveLength(1);
      expect(s.unsyncedOps()).toEqual([]);
      // The same ops, in the same order, stamped within the server's tolerance.
      expect(server.log.map((o) => o.id)).toEqual([one.id, two.id, notes.id]);
      for (let i = 1; i < server.log.length; i++) {
        expect(compareHlc(server.log[i]!.ts, server.log[i - 1]!.ts)).toBeGreaterThan(0);
      }
      for (const op of server.log) {
        expect(op.ts.wallMs).toBeLessThanOrEqual(serverNow() + TOLERANCE);
      }
      expect(s.get("task", "t1")).toEqual({ title: "two" });
      expect(s.fieldTs("task", "t1", "title")).toEqual(server.log[1]!.ts);
      // The push went through, so Sync details has nothing to warn about.
      expect(client.clockSkewMs()).toBeNull();

      // Ten minutes on, a new edit is stamped from the corrected clock, and syncs.
      clock.device += 10 * 60_000;
      const later = s.set("task", "t1", "title", "after the correction");
      expect(later.ts.wallMs).toBe(serverNow());
      await client.sync();
      expect(refused).toHaveLength(1);
      expect(s.unsyncedOps()).toEqual([]);
    });

    it("keeps the outbox when the server refuses the re-stamped push too", async () => {
      const { s, server, refused } = skewed();
      const fast = s.set("task", "t1", "title", "written on a fast clock");
      // A server whose answer is an hour behind the time it checks against.
      server.transport.syncPush = vi.fn(async (ops: Operation[]) => {
        refused.push(ops);
        throw new ApiError(400, "clock skew", { code: "clock_skew", server_time: 10_000_000 });
      });
      const client = new SyncClient(s, server.transport);

      await client.sync();

      expect(refused).toHaveLength(2); // one retry, not a loop
      expect(s.unsyncedOps().map((o) => o.id)).toEqual([fast.id]);
      expect(server.transport.syncPull).toHaveBeenCalled(); // the cycle still pulls
      expect(client.clockSkewMs()).toBeCloseTo(-HOUR, -4);
    });
  });

  describe("push size", () => {
    /** A server that refuses (413) any push whose JSON body is over `limit` bytes. */
    function cappedServer(limit: number) {
      const server = fakeServer();
      const push = server.transport.syncPush;
      server.transport.syncPush = vi.fn(async (ops: Operation[]) => {
        if (JSON.stringify({ operations: ops }).length > limit) {
          throw new ApiError(413, "Payload Too Large");
        }
        return push(ops);
      });
      return server;
    }

    it("splits a batch the server refuses as too large until every op is accepted, then pulls", async () => {
      const server = cappedServer(1_000);
      const s = store(NODE_A);
      const ops = Array.from({ length: 8 }, (_, i) =>
        s.set("task", `t${i}`, "notes", "x".repeat(200)),
      );
      const client = new SyncClient(s, server.transport);

      await client.sync();

      expect(s.unsyncedOps()).toHaveLength(0);
      expect(server.log.map((o) => o.id).sort()).toEqual(ops.map((o) => o.id).sort());
      expect(server.transport.syncPull).toHaveBeenCalled();
    });

    it("quarantines a single op too large for any request, and syncs the rest", async () => {
      const server = cappedServer(1_000);
      const s = store(NODE_A);
      const small = s.set("task", "t1", "title", "fits");
      const huge = s.set("task", "t2", "notes", "x".repeat(5_000));
      const quarantined: { op: Operation; err: unknown }[] = [];
      const client = new SyncClient(s, server.transport, {
        onQuarantine: (op, err) => quarantined.push({ op, err }),
      });

      await client.sync();

      expect(server.log.map((o) => o.id)).toEqual([small.id]);
      expect(quarantined.map((q) => q.op.id)).toEqual([huge.id]);
      const err = quarantined[0]!.err as ApiError;
      expect(err.status).toBe(413);
      expect(err.message).toMatch(/too large to sync/);
      expect(s.unsyncedOps()).toHaveLength(0);
    });

    it("splits the outbox by size before sending, so a 2 MiB body is never attempted", async () => {
      const server = cappedServer(2 * 1024 * 1024);
      const s = store(NODE_A);
      for (let i = 0; i < 3; i++) s.set("task", `t${i}`, "notes", "x".repeat(700_000));
      const client = new SyncClient(s, server.transport);

      await client.sync();

      expect(s.unsyncedOps()).toHaveLength(0);
      // No request was refused: each one was already small enough.
      for (const result of vi.mocked(server.transport.syncPush).mock.results) {
        expect(result.type).toBe("return");
      }
    });
  });

  describe("push cursor adoption", () => {
    it("adopts a push cursor that follows on from its own, so the pull skips its own echo", async () => {
      const server = fromServer();
      const other = store(NODE_B, 5000);
      server.log.push(other.set("task", "t1", "title", "a"), other.set("task", "t2", "title", "b"));
      const s = store(NODE_A);
      s.set("task", "mine", "title", "local");
      const cursors: number[] = [];
      const client = new SyncClient(s, server.transport, {
        cursor: 2,
        onCursor: (c) => cursors.push(c),
      });

      await client.sync();

      expect(server.transport.syncPull).toHaveBeenCalledWith(3);
      expect(server.transport.syncPull).not.toHaveBeenCalledWith(2);
      expect(cursors).toEqual([3]);
    });

    it("does not adopt a push cursor past ops it never received (from > own cursor)", async () => {
      const server = fromServer();
      const other = store(NODE_B, 5000);
      server.log.push(
        other.set("task", "seen", "title", "x"),
        other.set("task", "t1", "title", "a"),
        other.set("task", "t2", "title", "b"),
      );
      const s = store(NODE_A);
      s.set("task", "mine", "title", "local");
      const client = new SyncClient(s, server.transport, { cursor: 1 });

      await client.sync();

      // The push answered from=3 while this device held only up to 1: adopting its cursor would
      // skip seqs 2 and 3 for good.
      expect(server.transport.syncPull).toHaveBeenCalledWith(1);
      expect(s.get("task", "t1")).toEqual({ title: "a" });
      expect(s.get("task", "t2")).toEqual({ title: "b" });
      expect(client.currentCursor()).toBe(4);
    });
  });

  describe("persistence durability and cursor ordering", () => {
    it("guarantees ops are written to persistence before advancing cursor", async () => {
      const server = fakeServer();
      const other = store(NODE_B, 5000);
      for (let i = 0; i < 5; i++) {
        server.log.push(other.set("task", `task-${i}`, "title", `Title ${i}`));
      }

      const { MemoryPersistence } = await import("./persistence");
      const persistence = new MemoryPersistence();
      const s = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });

      let cursorInPersistenceAtCallback = -1;
      const client = new SyncClient(s, server.transport, {
        onCursor: async (c) => {
          // When onCursor is invoked, verify that all 5 ops are ALREADY stored in persistence!
          const loaded = await persistence.load();
          cursorInPersistenceAtCallback = loaded.length;
          await persistence.setCursor(c);
        },
      });

      await client.sync();
      expect(cursorInPersistenceAtCallback).toBe(5);
      expect(await persistence.getCursor()).toBe(5);

      // Now create a new store instance (simulating app relaunch) and hydrate:
      const reloadedStore = new LocalStore(NODE_A, { persistence });
      await reloadedStore.hydrate();
      expect(reloadedStore.get("task", "task-0")).toEqual({ title: "Title 0" });
      expect(reloadedStore.get("task", "task-4")).toEqual({ title: "Title 4" });
    });
  });

  describe("realtime sync (WebSocket)", () => {
    /**
     * A fake socket the test drives: the client assigns the `on*` handlers, the test fires events.
     * The same minimal handler surface the platform WebSocket exposes on the web and in React
     * Native — the transport has no Node-specific API, so this is all a fake needs.
     */
    class FakeSocket {
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: ((ev?: unknown) => void) | null = null;
      onclose: ((ev?: unknown) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {}
      close(): void {
        this.closed = true;
      }
      open(): void {
        this.onopen?.();
      }
      message(data: unknown): void {
        this.onmessage?.({ data });
      }
      closeEvent(code?: number): void {
        this.onclose?.(code === undefined ? undefined : { code });
      }
    }

    /**
     * A pull-shaped server (like `fakeServer`) whose transport also decodes WS payloads. The real
     * transport (`ApiClient`) converts wire ops to internal ops — the same conversion `/sync/pull`
     * responses go through, decrypting E2EE values; these tests deliver already-internal ops, so
     * the identity cast stands in for that separately-tested conversion.
     */
    function realtimeServer() {
      const server = fakeServer();
      const transport: SyncTransport = {
        ...server.transport,
        decodeWirePayload: (payload) => payload as { operations: Operation[]; cursor: number },
      };
      return { log: server.log, transport };
    }

    /** A SyncClient wired for realtime with `FakeSocket`, plus the sockets and cursor recorder. */
    function realtimeClient(s: LocalStore, transport: SyncTransport, opts: SyncClientOptions = {}) {
      const sockets: FakeSocket[] = [];
      const cursors: number[] = [];
      const client = new SyncClient(s, transport, {
        ...opts,
        realtime: {
          url: async (since) => `ws://x/sync/ws?ticket=t&since=${since}`,
          socketFactory: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket;
          },
          ...opts.realtime,
        },
        onCursor: (c) => {
          cursors.push(c);
          opts.onCursor?.(c);
        },
      });
      return { client, sockets, cursors };
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("opens the realtime socket only after the first successful cycle", async () => {
      const { transport } = realtimeServer();
      const { client, sockets } = realtimeClient(store(NODE_A), transport);
      expect(sockets).toHaveLength(0); // no socket before the cursor is meaningful

      await client.sync();
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.url).toBe("ws://x/sync/ws?ticket=t&since=0");
    });

    it("closes the socket for good when the server demands an upgrade", async () => {
      const { transport } = realtimeServer();
      let outdated = false;
      const gated: SyncTransport = {
        ...transport,
        syncPull: async (since) => {
          if (outdated) throw new UpgradeRequiredError(3);
          return transport.syncPull(since);
        },
      };
      const { client, sockets } = realtimeClient(store(NODE_A), gated);
      await client.sync();
      sockets[0]!.open();

      outdated = true;
      await expect(client.sync()).rejects.toBeInstanceOf(UpgradeRequiredError);

      expect(sockets[0]!.closed).toBe(true);
      vi.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(1); // no reconnect loop against a server that refuses us
    });

    it("halts, as a refused cycle does, when the socket ticket request meets the protocol gate", async () => {
      const { transport } = realtimeServer();
      const url = vi.fn(async (): Promise<string | null> => {
        throw new UpgradeRequiredError(5);
      });
      const { client, sockets } = realtimeClient(store(NODE_A), transport, {
        realtime: { url },
      });
      await client.sync();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(url).toHaveBeenCalledTimes(1); // no reconnect loop against a server that refuses us
      expect(sockets).toHaveLength(0);
      expect((await client.sync()).skipped).toBe("halted");
    });

    it("delivers other devices' ops live through the same apply path as a pull", async () => {
      const { log, transport } = realtimeServer();
      const s = store(NODE_A);
      const { client, sockets, cursors } = realtimeClient(s, transport);
      await client.sync();
      const socket = sockets[0]!;
      socket.open();

      // Another device commits an op; the hub fans it out pull-shaped.
      const other = store(NODE_B, 5000);
      const op = other.set("task", "t9", "title", "live");
      log.push(op);
      socket.message(JSON.stringify({ operations: [op], from: 0, cursor: 1 }));
      await s.flush(); // settles the shared apply path (apply → durable flush → cursor)

      expect(s.get("task", "t9")).toEqual({ title: "live" });
      expect(client.currentCursor()).toBe(1);
      expect(cursors).toContain(1);
    });

    it("applies a gap payload's ops, keeps its cursor, and pulls from its own cursor", async () => {
      const { log, transport } = realtimeServer();
      const pulls: { since: number; own: number }[] = [];
      const pull = transport.syncPull;
      const gated: SyncTransport = {
        ...transport,
        syncPull: vi.fn(async (since: number) => {
          pulls.push({ since, own: client.currentCursor() });
          return pull(since);
        }),
      };
      const s = store(NODE_A);
      const { client, sockets, cursors } = realtimeClient(s, gated);
      await client.sync();
      sockets[0]!.open();

      const other = store(NODE_B, 5000);
      const missed = other.set("task", "t1", "title", "missed");
      const delivered = other.set("task", "t2", "title", "delivered");
      log.push(missed, delivered);
      const pullsBefore = pulls.length;
      // The hub lost the message carrying seq 1; this one covers only (1, 2].
      sockets[0]!.message(JSON.stringify({ operations: [delivered], from: 1, cursor: 2 }));

      await vi.waitFor(() => expect(s.get("task", "t1")).toEqual({ title: "missed" }));
      expect(s.get("task", "t2")).toEqual({ title: "delivered" });
      // The gap never moved the cursor: the pull it triggered started at 0, and 2 came from it.
      expect(pulls[pullsBefore]).toEqual({ since: 0, own: 0 });
      expect(cursors).toEqual([2]);
    });

    it("stops realtime for good when the server revokes the session (4403)", async () => {
      const { transport } = realtimeServer();
      const { client, sockets } = realtimeClient(store(NODE_A), transport);
      await client.sync();
      sockets[0]!.open();
      sockets[0]!.closeEvent(4403);

      vi.advanceTimersByTime(120_000);
      await client.sync(); // a later cycle does not bring the socket back
      vi.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(1);
      expect(client.currentStatus()).toBe("idle");
    });

    it("rebuilds the synced state when the socket closes on an expired cursor (4410)", async () => {
      const { log, transport } = realtimeServer();
      const other = store(NODE_B, 5000);
      log.push(other.set("task", "t9", "title", "kept"));
      const s = store(NODE_A);
      const { client, sockets } = realtimeClient(s, transport);
      await client.sync();
      sockets[0]!.open();
      // Known here, but its delete was purged from the server before this device pulled it.
      s.applyRemote(other.set("task", "ghost", "title", "purged elsewhere"));

      sockets[0]!.closeEvent(4410);

      await vi.waitFor(() => {
        expect(s.get("task", "ghost")).toBeNull();
        expect(s.get("task", "t9")).toEqual({ title: "kept" });
      });
      expect(client.currentCursor()).toBe(1);
      // The rebuilt cycle brings the socket back from the new cursor.
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(sockets[1]!.url).toContain("since=1");
    });

    it("reports 'live-ws' while connected and 'idle' again once the socket drops", async () => {
      const { transport } = realtimeServer();
      const statuses: string[] = [];
      const { client, sockets } = realtimeClient(store(NODE_A), transport, {
        onStatus: (st) => statuses.push(st),
      });
      await client.sync();
      statuses.length = 0;

      sockets[0]!.open();
      expect(client.currentStatus()).toBe("live-ws");
      expect(statuses).toEqual(["live-ws"]);

      // Dropped (server restart, network blip): back to polling — the fallback of record.
      sockets[0]!.closeEvent();
      expect(client.currentStatus()).toBe("idle");
    });

    it("never rewinds the cursor when the hub echoes already-pulled ops", async () => {
      const { log, transport } = realtimeServer();
      const other = store(NODE_B, 5000);
      const op = other.set("task", "t9", "title", "from-b");
      log.push(op);

      const s = store(NODE_A);
      const { client, sockets, cursors } = realtimeClient(s, transport);
      await client.sync(); // pulls the op, cursor 1
      expect(client.currentCursor()).toBe(1);
      cursors.length = 0;

      // This device's own socket receives the fan-out echo of the op it already pulled, with a
      // payload cursor behind ours (a lagging hub). Re-applying is idempotent; the cursor must not
      // move back — that would make the next pull re-download the log.
      sockets[0]!.open();
      sockets[0]!.message(JSON.stringify({ operations: [op], from: 0, cursor: 0 }));
      await s.flush();

      expect(client.currentCursor()).toBe(1);
      expect(cursors).toEqual([]);
    });

    it("still polls on sync() while the socket is live — polling stays the fallback of record", async () => {
      const { transport } = realtimeServer();
      const { client, sockets } = realtimeClient(store(NODE_A), transport);
      await client.sync();
      sockets[0]!.open();

      await client.sync();
      expect(transport.syncPull).toHaveBeenCalledTimes(2); // the hub can drop messages; the poll reconciles
    });

    it("stays disposed when a cycle in flight at dispose time completes", async () => {
      const { transport } = realtimeServer();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow: SyncTransport = {
        ...transport,
        syncPull: async (since) => {
          await gate;
          return transport.syncPull(since);
        },
      };
      const { client, sockets } = realtimeClient(store(NODE_A), slow);
      const cycle = client.sync();
      client.dispose(); // the session ends while the first cycle is still pulling

      release();
      await cycle;
      vi.advanceTimersByTime(120_000);
      expect(sockets).toHaveLength(0);
    });

    it("does not open the realtime socket when the first cycle fails", async () => {
      const base = realtimeServer();
      let firstPull = true;
      const transport: SyncTransport = {
        ...base.transport,
        syncPull: async (since: number) => {
          if (firstPull) {
            firstPull = false;
            throw new Error("network down");
          }
          return base.transport.syncPull(since);
        },
      };
      const { client, sockets } = realtimeClient(store(NODE_A), transport);

      await expect(client.sync()).rejects.toThrow("network down");
      expect(sockets).toHaveLength(0); // offline: no socket until sync succeeds

      await client.sync();
      expect(sockets).toHaveLength(1);
    });

    it("drops an undecodable payload without failing sync", async () => {
      const server = fakeServer();
      // A transport without `decodeWirePayload` (the interface member is optional): payloads are
      // ignored and polling keeps syncing.
      const pollOnly: SyncTransport = {
        syncPush: server.transport.syncPush,
        syncPull: server.transport.syncPull,
      };
      const s = store(NODE_A);
      const { client, sockets } = realtimeClient(s, pollOnly);
      await client.sync();

      sockets[0]!.open();
      sockets[0]!.message(JSON.stringify({ operations: [{ id: "x" }], cursor: 9 }));
      await s.flush();

      expect(client.currentCursor()).toBe(0);
      expect(client.currentStatus()).toBe("live-ws"); // a dropped payload is not an outage
    });

    it("flushes realtime ops to persistence before advancing the cursor", async () => {
      const { MemoryPersistence } = await import("./persistence");
      const persistence = new MemoryPersistence();
      const s = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });
      const { log, transport } = realtimeServer();

      let opsOnDiskAtCursorAdvance = -1;
      const { client, sockets } = realtimeClient(s, transport, {
        onCursor: async (c) => {
          opsOnDiskAtCursorAdvance = (await persistence.load()).length;
          await persistence.setCursor(c);
        },
      });
      await client.sync();
      sockets[0]!.open();

      const other = store(NODE_B, 5000);
      const op = other.set("task", "t1", "title", "durable");
      log.push(op);
      sockets[0]!.message(JSON.stringify({ operations: [op], from: 0, cursor: 1 }));
      await vi.waitFor(() => expect(opsOnDiskAtCursorAdvance).toBe(1));

      // Same durability guarantee as the pull path: when the cursor moved, the op was already
      // durable — a crash here resumes from a cursor that is never ahead of the ops on disk.
      expect(await persistence.getCursor()).toBe(1);
      const reloaded = new LocalStore(NODE_A, { persistence });
      await reloaded.hydrate();
      expect(reloaded.get("task", "t1")).toEqual({ title: "durable" });
    });
  });
});

/** A durable log whose writes fail while `failing` is set (a full disk, a busy database). */
class FlakyPersistence extends MemoryPersistence {
  failing = false;
  override async append(op: Operation, synced: boolean): Promise<void> {
    if (this.failing) throw new Error("disk full");
    return super.append(op, synced);
  }
  override async appendBatch(ops: Operation[], synced: boolean): Promise<void> {
    if (this.failing) throw new Error("disk full");
    return super.appendBatch(ops, synced);
  }
  override async markSynced(ids: string[]): Promise<void> {
    if (this.failing) throw new Error("disk full");
    return super.markSynced(ids);
  }
}

describe("persistence failures", () => {
  it("keeps the cursor behind ops that never reached the disk, and stores the echo of an own edit once it can", async () => {
    const server = fromServer();
    server.log.push(store(NODE_B, 5000).set("task", "t2", "title", "remote"));
    const disk = new FlakyPersistence();
    const reported: unknown[] = [];
    let n = 0;
    const s = new LocalStore(NODE_A, {
      persistence: disk,
      newId: () => `op-a-${n++}`,
      onPersistError: (err) => reported.push(err),
    });
    disk.failing = true;
    s.set("task", "t1", "title", "mine");
    const cursors: number[] = [];
    const client = new SyncClient(s, server.transport, { onCursor: (c) => cursors.push(c) });

    // Nothing reached the disk, so the cursor must not move past the ops.
    await expect(client.sync()).rejects.toBeInstanceOf(PersistError);
    expect(cursors).toEqual([]);
    expect(reported.length).toBeGreaterThan(0);
    expect(s.unsavedCount()).toBe(2);

    // The disk recovers: the next cycle writes both, the own edit as synced, then moves on.
    disk.failing = false;
    await client.sync();
    expect(client.currentCursor()).toBe(2);
    expect(s.unsavedCount()).toBe(0);

    const reloaded = new LocalStore(NODE_A, { persistence: disk });
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "mine" });
    expect(reloaded.get("task", "t2")).toEqual({ title: "remote" });
    expect(reloaded.unsyncedOps()).toEqual([]);
  });
});

describe("quarantine", () => {
  it("takes a refused edit back, so the server's value and later remote edits show again", async () => {
    const server = fromServer();
    const b = store(NODE_B, 5000);
    server.log.push(b.set("task", "t1", "title", "server's"));
    const disk = new MemoryPersistence();
    let n = 0;
    // This device's clock runs ahead of the other device's.
    let t = 9000;
    const s = new LocalStore(NODE_A, {
      persistence: disk,
      now: () => t++,
      newId: () => `op-a-${n++}`,
    });
    const client = new SyncClient(s, server.transport);
    await client.sync();

    const refused = s.set("task", "t1", "title", "not allowed");
    // A later edit elsewhere, stamped below the refused one by the slower clock.
    server.log.push(b.set("task", "t1", "title", "edited elsewhere"));
    const push = server.transport.syncPush;
    server.transport.syncPush = vi.fn(async (ops: Operation[]) => {
      if (ops.some((o) => o.id === refused.id)) throw new ApiError(403, "forbidden");
      return push(ops);
    });
    const quarantined: string[] = [];
    const client2 = new SyncClient(s, server.transport, {
      cursor: client.currentCursor(),
      onQuarantine: (op) => quarantined.push(op.id),
    });
    await client2.sync();
    await s.flush();

    expect(quarantined).toEqual([refused.id]);
    expect(s.get("task", "t1")).toEqual({ title: "edited elsewhere" });
    expect(s.unsyncedOps()).toEqual([]);
    const reloaded = new LocalStore(NODE_A, { persistence: disk });
    await reloaded.hydrate();
    expect(reloaded.get("task", "t1")).toEqual({ title: "edited elsewhere" });
  });
});
