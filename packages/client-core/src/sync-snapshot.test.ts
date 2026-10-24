import { describe, it, expect, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  NetworkError,
  UpgradeRequiredError,
  toEncryptedWire,
  type FetchLike,
} from "./api";
import { Keyring, generateDek, generatePek } from "./crypto";
import { reviveLockedValues } from "./scope";
import { LocalStore } from "./store";
import { SyncClient, type SyncTransport } from "./sync-client";
import { MemoryPersistence } from "./persistence";
import type { Operation } from "./types";

const NODE_A = "00000000-0000-0000-0000-0000000000a1";
const NODE_B = "00000000-0000-0000-0000-0000000000a2";

function store(node: string, start = 1000) {
  let t = start;
  let n = 0;
  return new LocalStore(node, { now: () => t++, newId: () => `op-${node}-${n++}` });
}

/**
 * A fake server exposing BOTH sync surfaces like the real backend: an append-only op log for
 * `/sync/pull` (`log`), and a paged materialized-state snapshot for `/sync/snapshot`; each
 * `put`-materialized entity contributes its current field ops to a snapshot page of
 * `keysPerPage` entity keys, walked in insertion order behind an opaque `entity/id` next token.
 *
 * The snapshot cursor is read once at the first page call (the server reads MAX(server_seq)
 * before materializing), so ops pushed into `log` while pages are streaming are NOT in the
 * snapshot but ARE re-delivered by the client's same-cycle overlap pull.
 *
 * `behave` is a test hook fired at the start of each snapshot page call with the requested
 * resume token (undefined for the first page) and the log; throwing from it surfaces as a server
 * error from `syncSnapshot` itself.
 */
function snapshotServer(
  keysPerPage: number,
  behave?: (next: string | undefined, log: Operation[]) => void,
  opts: { unpinned?: boolean } = {},
) {
  const log: Operation[] = [];
  const order: string[] = [];
  const fields = new Map<string, Operation[]>();
  let snapshotCursor: number | null = null;

  const transport: SyncTransport = {
    syncPush: vi.fn(async (ops: Operation[]) => {
      for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
      return { cursor: log.length, applied: ops.length };
    }),
    syncPull: vi.fn(async (since: number) => ({
      operations: log.slice(since),
      cursor: log.length,
    })),
    syncSnapshot: vi.fn(async (next?: string) => {
      if (snapshotCursor === null) snapshotCursor = log.length;
      const start = next === undefined ? 0 : order.indexOf(next) + 1;
      behave?.(next, log);
      const pageKeys = order.slice(start, start + keysPerPage);
      const operations = pageKeys.flatMap((k) => fields.get(k) ?? []);
      const more = start + keysPerPage < order.length;
      return {
        operations,
        // `unpinned` models a server that reports its live head on every page instead of the
        // first page's cursor.
        cursor: opts.unpinned ? log.length : snapshotCursor,
        next: more ? pageKeys[pageKeys.length - 1] : undefined,
      };
    }),
  };

  /** Materialize one entity: its current field ops join the snapshot AND the replay log. */
  function putEntity(entity: string, id: string, ops: Operation[]): void {
    const k = `${entity}/${id}`;
    if (!order.includes(k)) order.push(k);
    fields.set(k, ops);
    for (const op of ops) if (!log.some((o) => o.id === op.id)) log.push(op);
  }
  return { log, transport, putEntity };
}

describe("snapshot bootstrap", () => {
  it("bootstraps a fresh device from paged snapshot pages, applying each page immediately and moving the cursor only after the final page", async () => {
    // Distinct node id AND clock start: op ids are minted as `op-<node>-n`, so reusing NODE_B
    // would collide with `seed`'s ids and the merge would drop the concurrent op as a duplicate.
    const other = store("00000000-0000-0000-0000-0000000000a3", 9000);
    const concurrent = other.set("task", "t-concurrent", "title", "committed mid-snapshot");

    const appliedAtPageStart: boolean[] = [];
    const server = snapshotServer(2, (next, log) => {
      // Observed from the server side: when a page is requested, the previous page's ops must
      // already be applied to the store (apply-immediately, not batch-until-drain).
      appliedAtPageStart.push(s.get("task", "t0") !== null);
      // An op committed while pages are streaming: lands in the log after the snapshot cursor was
      // read, so only the overlap pull can deliver it.
      if (next === "task/t1") log.push(concurrent);
    });
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 5; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }

    // Durable persistence so the cursor-on-disk ordering is observable.
    const persistence = new MemoryPersistence();
    const s = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });
    const cursors: number[] = [];
    const client = new SyncClient(s, server.transport, {
      onCursor: async (c) => {
        cursors.push(c);
        await persistence.setCursor(c);
      },
    });

    const r = await client.sync();

    // Three pages (5 keys / 2 per page), each requested with the previous page's last emitted key.
    expect(server.transport.syncSnapshot).toHaveBeenCalledTimes(3);
    expect(server.transport.syncSnapshot).toHaveBeenCalledWith(undefined);
    expect(server.transport.syncSnapshot).toHaveBeenCalledWith("task/t1");
    expect(server.transport.syncSnapshot).toHaveBeenCalledWith("task/t3");
    // Page 0's ops were applied before page 1 was requested, and page 1's before page 2.
    expect(appliedAtPageStart).toEqual([false, true, true]);
    // The materialized state is fully folded, plus the mid-snapshot op via the overlap pull.
    expect(s.get("task", "t4")).toEqual({ title: "v4" });
    expect(s.get("task", "t-concurrent")).toEqual({ title: "committed mid-snapshot" });
    // The overlap pull starts at the snapshot cursor in the SAME cycle...
    expect(server.transport.syncPull).toHaveBeenCalledWith(5);
    // The cursor moves only once the final page is on disk (to the pinned 5), then the pull's 6.
    expect(cursors).toEqual([5, 6]);
    expect(client.currentCursor()).toBe(6);
    expect(r.cursor).toBe(6);
    expect(r.pulled).toBe(1); // only the mid-snapshot op came from the pull
    // Durability: the cursor on disk is never ahead of the ops on disk.
    expect(await persistence.getCursor()).toBe(6);
    const reloaded = new LocalStore(NODE_A, { persistence });
    await reloaded.hydrate();
    expect(reloaded.get("task", "t0")).toEqual({ title: "v0" });
    expect(reloaded.get("task", "t-concurrent")).toEqual({ title: "committed mid-snapshot" });
  });

  it("falls back to the legacy from-zero op-log replay when the server predates the endpoint (404)", async () => {
    const server = snapshotServer(2, () => {
      throw new ApiError(404, "Not Found");
    });
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 3; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }
    const s = store(NODE_A);
    const client = new SyncClient(s, server.transport);
    const r = await client.sync();

    // The snapshot was tried exactly once (no retry storm), then the cycle replayed the log.
    expect(server.transport.syncSnapshot).toHaveBeenCalledTimes(1);
    expect(server.transport.syncPull).toHaveBeenCalledWith(0);
    expect(r.pulled).toBe(3);
    expect(r.cursor).toBe(3);
    expect(s.get("task", "t2")).toEqual({ title: "v2" });
    expect(client.currentCursor()).toBe(3);
  });

  it("falls back to the replay when the transport has no syncSnapshot at all", async () => {
    // An older client build whose transport predates the method: the interface member is
    // optional, so the bootstrap must treat it as "unsupported", never crash.
    const log: Operation[] = [];
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 2; i++) log.push(seed.set("task", `t${i}`, "title", `v${i}`));
    const transport: SyncTransport = {
      syncPush: vi.fn(async () => ({ cursor: log.length, applied: 0 })),
      syncPull: vi.fn(async (since: number) => ({
        operations: log.slice(since),
        cursor: log.length,
      })),
    };

    const s = store(NODE_A);
    const client = new SyncClient(s, transport);
    const r = await client.sync();
    expect(r.pulled).toBe(2);
    expect(s.get("task", "t1")).toEqual({ title: "v1" });
  });

  it("a mid-bootstrap transient failure persists no cursor; the retry resumes at the failed page", async () => {
    let secondPageRequests = 0;
    let failNextSecondPage = true;
    const server = snapshotServer(2, (next) => {
      // Count every page-1 request server-side (one per bootstrap attempt) and fail the FIRST
      // one with a transient (5xx) error; the retry's page-1 request must succeed.
      if (next === "task/t1") {
        secondPageRequests++;
        if (failNextSecondPage) {
          failNextSecondPage = false;
          throw new ApiError(503, "unavailable");
        }
      }
    });
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 5; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }

    const persistence = new MemoryPersistence();
    const s = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });
    const cursors: number[] = [];
    const client = new SyncClient(s, server.transport, {
      onCursor: async (c) => {
        cursors.push(c);
        await persistence.setCursor(c);
      },
    });

    // The cycle fails (retry semantics), but page 0's already-applied ops stay in the store and
    // the cursor was never touched; on disk or in memory.
    await expect(client.sync()).rejects.toBeInstanceOf(ApiError);
    expect(client.currentStatus()).toBe("offline");
    expect(client.currentCursor()).toBe(0);
    expect(await persistence.getCursor()).toBe(0);
    expect(cursors).toEqual([]);
    expect(s.get("task", "t0")).toEqual({ title: "v0" });
    expect(s.get("task", "t1")).toEqual({ title: "v1" });

    // The retry picks up at page 1 (page 0 is not fetched again) and converges with one cursor write.
    const r = await client.sync();
    expect(server.transport.syncSnapshot).toHaveBeenCalledTimes(4); // p0, p1 (fail), p1, p2
    expect(vi.mocked(server.transport.syncSnapshot!).mock.calls.map(([n]) => n)).toEqual([
      undefined,
      "task/t1",
      "task/t1",
      "task/t3",
    ]);
    expect(secondPageRequests).toBe(2);
    expect(r.cursor).toBe(5);
    expect(cursors).toEqual([5]);
    expect(await persistence.getCursor()).toBe(5);
    for (let i = 0; i < 5; i++) expect(s.get("task", `t${i}`)).toEqual({ title: `v${i}` });
  });

  it("signals 'syncing' while snapshot pages stream and rests idle after the cycle", async () => {
    const server = snapshotServer(1);
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 3; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }

    const s = store(NODE_A);
    const statuses: string[] = [];
    const client = new SyncClient(s, server.transport, { onStatus: (st) => statuses.push(st) });

    await client.sync();
    // No new statuses: the backfill spins "syncing", then settles to the resting state.
    expect(statuses).toEqual(["syncing", "idle"]);
  });

  it("does not re-bootstrap on later quiet polls (an empty account legitimately keeps cursor 0)", async () => {
    // Zero entities: the snapshot drains in one empty page and the cursor stays 0; without the
    // first-cycle gate every 5s poll would re-download the snapshot forever.
    const server = snapshotServer(2);
    const s = store(NODE_A);
    const client = new SyncClient(s, server.transport);

    await client.sync();
    await client.sync();

    expect(client.currentCursor()).toBe(0);
    expect(client.currentStatus()).toBe("idle");
    expect(server.transport.syncSnapshot).toHaveBeenCalledTimes(1);
  });

  it("keeps the outbox: a resync-style cursor==0 bootstrap pushes local ops BEFORE folding the snapshot", async () => {
    const server = snapshotServer(2);
    const seed = store(NODE_B, 5000);
    server.putEntity("task", "remote-1", [seed.set("task", "remote-1", "title", "from-server")]);

    const s = store(NODE_A);
    s.set("task", "local-1", "title", "queued offline");
    expect(s.unsyncedOps()).toHaveLength(1);

    // Resync (StoreProvider.resync) persists cursor 0 and builds a fresh client over the
    // still-populated store: local entity count must not gate the bootstrap.
    const client = new SyncClient(s, server.transport, { cursor: 0 });
    const r = await client.sync();

    // The unsynced op was pushed to the server (never lost to the re-download)...
    expect(r.pushed).toBe(1);
    expect(s.unsyncedOps()).toHaveLength(0);
    expect(server.log.some((o) => o.entityId === "local-1")).toBe(true);
    // ...the snapshot fired despite the store already holding data, and both sources converged.
    expect(server.transport.syncSnapshot).toHaveBeenCalled();
    expect(s.get("task", "remote-1")).toEqual({ title: "from-server" });
    expect(s.get("task", "local-1")).toEqual({ title: "queued offline" });
    expect(client.currentCursor()).toBe(2);
  });

  it("pulls from the first page's cursor, so an edit to an already-walked key during the walk is not lost", async () => {
    const other = store("00000000-0000-0000-0000-0000000000a3", 9000);
    const edit = other.set("task", "t0", "title", "edited mid-walk");
    // The edit lands after page 0 (which carried t0) was served: only the overlap pull can bring it.
    const server = snapshotServer(
      2,
      (next, log) => {
        if (next === "task/t1") log.push(edit);
      },
      { unpinned: true },
    );
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 5; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }

    const s = store(NODE_A);
    const client = new SyncClient(s, server.transport);
    await client.sync();

    // Page 0 said 5, the later pages 6: the pull must start at 5, not at the last page's 6.
    expect(server.transport.syncPull).toHaveBeenCalledWith(5);
    expect(s.get("task", "t0")).toEqual({ title: "edited mid-walk" });
    expect(client.currentCursor()).toBe(6);
  });

  it("resumes an interrupted bootstrap from its persisted page after a restart", async () => {
    let throttleOnce = true;
    const server = snapshotServer(1, (next) => {
      if (next === "task/t1" && throttleOnce) {
        throttleOnce = false;
        throw new ApiError(429, "too many requests");
      }
    });
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 5; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }

    const persistence = new MemoryPersistence();
    const wire = (
      s: LocalStore,
      bootstrap: Awaited<ReturnType<MemoryPersistence["getBootstrap"]>>,
    ) =>
      new SyncClient(s, server.transport, {
        bootstrap,
        onBootstrapProgress: (p) => void persistence.setBootstrap(p),
        onCursor: (c) => void persistence.setCursor(c),
      });

    // Pages 0 and 1 land, page 2 answers 429: the app is closed before it retries.
    const first = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });
    await expect(wire(first, null).sync()).rejects.toBeInstanceOf(ApiError);
    await first.flush();
    expect(await persistence.getBootstrap()).toEqual({ next: "task/t1", cursor: 5 });
    expect(await persistence.getCursor()).toBe(0);

    // Relaunch: hydrate the pages already on disk and continue at page 2.
    const second = new LocalStore(NODE_A, { persistence, newId: () => `op-b-${Math.random()}` });
    await second.hydrate();
    vi.mocked(server.transport.syncSnapshot!).mockClear();
    await wire(second, await persistence.getBootstrap()).sync();

    expect(vi.mocked(server.transport.syncSnapshot!).mock.calls.map(([n]) => n)).toEqual([
      "task/t1",
      "task/t2",
      "task/t3",
    ]);
    for (let i = 0; i < 5; i++) expect(second.get("task", `t${i}`)).toEqual({ title: `v${i}` });
    expect(await persistence.getCursor()).toBe(5);
    expect(await persistence.getBootstrap()).toBeNull();
  });

  describe("orphaned-cursor self-heal", () => {
    it("self-heals an orphaned cursor via the snapshot instead of a from-zero replay", async () => {
      const server = snapshotServer(2);
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 4; i++) {
        server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
      }

      // Resumed with cursor 50 but an empty local store; pulling from 50 returns nothing (the
      // history was replaced). The first cycle must detect the orphan and fold the snapshot.
      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport, { cursor: 50 });

      const r = await client.sync();

      // The regular pull ran first from the orphaned cursor (and found nothing)...
      expect(server.transport.syncPull).toHaveBeenNthCalledWith(1, 50);
      // ...then the heal bootstrapped from the snapshot instead of replaying from 0.
      expect(server.transport.syncSnapshot).toHaveBeenCalled();
      expect(server.transport.syncPull).not.toHaveBeenCalledWith(0);
      expect(s.get("task", "t3")).toEqual({ title: "v3" });
      expect(r.cursor).toBe(4);
      expect(client.currentCursor()).toBe(4);
    });

    it("leaves an account that holds only other kinds (habits, say) alone", async () => {
      const server = snapshotServer(2);
      const s = store(NODE_A);
      s.applyRemote(store(NODE_B, 5000).set("habit", "h1", "name", "Walk"));
      const client = new SyncClient(s, server.transport, { cursor: 50 });

      await client.sync();

      expect(server.transport.syncSnapshot).not.toHaveBeenCalled();
      expect(client.currentCursor()).toBe(50);
    });

    it("self-heal falls back to the from-zero replay when the snapshot is unsupported (404)", async () => {
      const server = snapshotServer(2, () => {
        throw new ApiError(404, "Not Found");
      });
      const seed = store(NODE_B, 5000);
      for (let i = 0; i < 4; i++) {
        server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
      }

      const s = store(NODE_A);
      const client = new SyncClient(s, server.transport, { cursor: 50 });
      const r = await client.sync();

      expect(server.transport.syncPull).toHaveBeenCalledWith(0);
      expect(r.pulled).toBe(4);
      expect(s.get("task", "t3")).toEqual({ title: "v3" });
      expect(client.currentCursor()).toBe(4);
    });
  });
});

describe("cursor expired (410): rebuild from the snapshot", () => {
  /**
   * A snapshot server whose retention purged the log below `purged`: a pull from a cursor under it
   * answers 410 cursor_expired, like the real one. Seeded with t0..t2 on the server; this device
   * also knows "gone", whose delete the server received and purged along with its fields.
   */
  function purgedWorld() {
    const server = snapshotServer(2);
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 3; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }
    // Everything up to the head was purged once; the snapshot's cursor (the head) is still valid.
    const purged = server.log.length;
    const pull = server.transport.syncPull;
    server.transport.syncPull = vi.fn(async (since: number) => {
      if (since > 0 && since < purged) {
        throw new ApiError(410, "cursor predates purged operations", { code: "cursor_expired" });
      }
      return pull(since);
    });

    const persistence = new MemoryPersistence();
    const s = new LocalStore(NODE_A, { persistence, newId: () => `op-a-${Math.random()}` });
    // What this device synced long ago: t0..t2 as they were, and "gone", since deleted and purged.
    s.applyRemoteBatch(server.log.map((op) => ({ ...op })));
    s.applyRemote(seed.set("task", "gone", "title", "deleted elsewhere, then purged"));
    return { server, persistence, s };
  }

  it("re-bootstraps from the snapshot and keeps the outbox", async () => {
    const { server, persistence, s } = purgedWorld();
    const queued = s.set("task", "offline", "title", "written offline");
    // Held back like an op waiting for a project key, so it is still queued when the pull runs.
    server.transport.syncPush = vi.fn(async (ops: Operation[]) => ({
      cursor: 0,
      applied: 0,
      deferred: ops.map((o) => o.id),
    }));
    const cursors: number[] = [];
    const client = new SyncClient(s, server.transport, {
      cursor: 2,
      onCursor: (c) => {
        cursors.push(c);
        void persistence.setCursor(c);
      },
    });

    await client.sync();

    // The walk started at the first page.
    expect(vi.mocked(server.transport.syncSnapshot!).mock.calls[0]?.[0]).toBeUndefined();
    expect(s.get("task", "t2")).toEqual({ title: "v2" });
    expect(s.unsyncedOps().map((o) => o.id)).toEqual([queued.id]);
    expect(s.get("task", "offline")).toEqual({ title: "written offline" });
    expect(cursors).toEqual([0, 3]);
    expect(client.currentCursor()).toBe(3);
    // The rebuilt op log holds the server's state and the outbox, nothing of the old synced rows.
    const reloaded = new LocalStore(NODE_A, { persistence });
    await reloaded.hydrate();
    expect(reloaded.get("task", "gone")).toBeNull();
    expect(reloaded.get("task", "offline")).toEqual({ title: "written offline" });
    expect(reloaded.unsyncedOps().map((o) => o.id)).toEqual([queued.id]);
  });

  it("drops a purged entity instead of keeping a ghost, and a local delete never reappears", async () => {
    const { server, s } = purgedWorld();
    const del = s.remove("task", "t1");
    server.transport.syncPush = vi.fn(async (ops: Operation[]) => ({
      cursor: 0,
      applied: 0,
      deferred: ops.map((o) => o.id),
    }));
    let sawDeleted = false;
    s.onChange(() => {
      if (s.get("task", "t1") !== null) sawDeleted = true;
    });
    const client = new SyncClient(s, server.transport, { cursor: 2 });

    await client.sync();

    // "gone" exists nowhere on the server any more: keeping it would resurrect it on the next edit.
    expect(s.get("task", "gone")).toBeNull();
    // The snapshot still has t1's fields, but the queued delete is newer and hides them throughout.
    expect(s.get("task", "t1")).toBeNull();
    expect(sawDeleted).toBe(false);
    expect(s.unsyncedOps().map((o) => o.id)).toEqual([del.id]);
    expect(s.get("task", "t0")).toEqual({ title: "v0" });
  });
});

describe("resetAndBootstrap on request", () => {
  /**
   * A device that bootstrapped t0..t2 from the server and then got "ghost", which the server does
   * not have (a delete it purged): a resync must drop the ghost and keep the device's own queue.
   */
  async function syncedWorld() {
    const server = snapshotServer(2);
    const seed = store(NODE_B, 5000);
    for (let i = 0; i < 3; i++) {
      server.putEntity("task", `t${i}`, [seed.set("task", `t${i}`, "title", `v${i}`)]);
    }
    const s = store(NODE_A);
    const client = new SyncClient(s, server.transport);
    await client.sync();
    s.applyRemote(seed.set("task", "ghost", "title", "gone from the server"));
    const snapshotCalls = () => vi.mocked(server.transport.syncSnapshot!).mock.calls.length;
    return { server, s, client, snapshotCalls };
  }

  it("rebuilds from the snapshot, keeps the outbox and resolves with the cycle's result", async () => {
    const { server, s, client } = await syncedWorld();
    const queued = s.set("task", "mine", "title", "not pushed yet");
    // Held back like an op waiting for a project key, so it is still queued after the cycle.
    server.transport.syncPush = vi.fn(async (ops: Operation[]) => ({
      cursor: 0,
      applied: 0,
      deferred: ops.map((o) => o.id),
    }));

    const result = await client.resetAndBootstrap();

    expect(result.skipped).toBeUndefined();
    expect(result.cursor).toBe(3);
    expect(s.get("task", "ghost")).toBeNull();
    expect(s.get("task", "t2")).toEqual({ title: "v2" });
    expect(s.get("task", "mine")).toEqual({ title: "not pushed yet" });
    expect(s.unsyncedOps().map((o) => o.id)).toEqual([queued.id]);
  });

  it("waits for a cycle in flight, then rebuilds in a cycle of its own that sync() calls join", async () => {
    const { server, s, client } = await syncedWorld();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pull = server.transport.syncPull;
    server.transport.syncPull = vi.fn(async (since: number) => {
      events.push("pull");
      await gate;
      return pull(since);
    });
    const snapshot = server.transport.syncSnapshot!;
    let joined: Promise<unknown> | null = null;
    server.transport.syncSnapshot = vi.fn(async (next?: string) => {
      events.push("snapshot");
      await Promise.resolve(); // a request is never answered synchronously
      // A poll while the rebuild runs joins it rather than starting a cycle of its own.
      joined ??= client.sync();
      return snapshot(next);
    });

    const running = client.sync();
    const rebuilt = client.resetAndBootstrap();
    await Promise.resolve();
    expect(events).toEqual(["pull"]); // the rebuild waits for the cycle already pulling

    release();
    const [first, result] = await Promise.all([running, rebuilt]);
    expect(first).not.toBe(result);
    expect(events.slice(0, 2)).toEqual(["pull", "snapshot"]);
    expect(await joined).toBe(result);
    expect(s.get("task", "ghost")).toBeNull();
  });

  it("offline, rejects and keeps the local state, and leaves no rebuild pending", async () => {
    const { server, s, client, snapshotCalls } = await syncedWorld();
    const cursor = client.currentCursor();
    const snapshot = server.transport.syncSnapshot!;
    const pull = server.transport.syncPull;
    let offline = true;
    const unreachable = () => new NetworkError("Network request failed");
    server.transport.syncSnapshot = vi.fn(async (next?: string) => {
      if (offline) throw unreachable();
      return snapshot(next);
    });
    server.transport.syncPull = vi.fn(async (since: number) => {
      if (offline) throw unreachable();
      return pull(since);
    });

    await expect(client.resetAndBootstrap()).rejects.toBeInstanceOf(NetworkError);
    expect(client.currentStatus()).toBe("offline");
    // Nothing was dropped: the server never answered.
    expect(s.get("task", "ghost")).toEqual({ title: "gone from the server" });
    expect(s.get("task", "t0")).toEqual({ title: "v0" });
    expect(client.currentCursor()).toBe(cursor);

    // Back online, an ordinary cycle does not run the failed rebuild behind the user's back.
    offline = false;
    const calls = snapshotCalls();
    await client.sync();
    expect(snapshotCalls()).toBe(calls);
    expect(s.get("task", "ghost")).toEqual({ title: "gone from the server" });
  });

  it("shares one rebuild between concurrent calls", async () => {
    const { client, s, snapshotCalls } = await syncedWorld();
    const before = snapshotCalls();

    const [a, b] = await Promise.all([client.resetAndBootstrap(), client.resetAndBootstrap()]);

    expect(a).toBe(b);
    expect(snapshotCalls() - before).toBe(2); // one walk of the two-page snapshot
    expect(s.get("task", "ghost")).toBeNull();
  });

  it("waits out a rate-limit wait and rebuilds with the cycle that ends it; halted, never", async () => {
    vi.useFakeTimers();
    try {
      const { server, s, client } = await syncedWorld();
      const pull = server.transport.syncPull;
      server.transport.syncPull = vi.fn(async () => {
        throw new ApiError(429, "too many requests", undefined, 10_000);
      });
      await expect(client.sync()).rejects.toBeInstanceOf(ApiError);
      server.transport.syncPull = pull;

      const postponed = await client.resetAndBootstrap();
      expect(postponed.skipped).toBe("throttled");
      expect(s.get("task", "ghost")).toEqual({ title: "gone from the server" });
      // The cycle that ends the wait performs the rebuild.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(s.get("task", "ghost")).toBeNull());
      client.dispose();
    } finally {
      vi.useRealTimers();
    }

    const { server, s } = await syncedWorld();
    const outdated = new SyncClient(s, {
      ...server.transport,
      syncPull: async () => {
        throw new UpgradeRequiredError(5);
      },
    });
    await expect(outdated.sync()).rejects.toBeInstanceOf(UpgradeRequiredError);
    expect((await outdated.resetAndBootstrap()).skipped).toBe("halted");
    expect(s.get("task", "ghost")).toEqual({ title: "gone from the server" });
  });
});

describe("snapshot bootstrap E2EE", () => {
  const PROJECT_ID = "proj-e2ee-snapshot";

  /** Wire ops as a snapshot server would serve them: DEK-scoped page 1, PEK-scoped page 2. */
  function snapshotPages(srcKeyring: Keyring) {
    const personal = toEncryptedWire(
      {
        id: "w-op-1",
        entity: "task",
        entityId: "t-personal",
        ts: { wallMs: 1000, counter: 0, node: NODE_B },
        op: "set",
        field: "title",
        value: "Personal secret",
      },
      srcKeyring,
      null,
    );
    const sharedLink = toEncryptedWire(
      {
        id: "w-op-2",
        entity: "task",
        entityId: "t-shared",
        ts: { wallMs: 1000, counter: 1, node: NODE_B },
        op: "set",
        field: "project_id",
        value: PROJECT_ID,
      },
      srcKeyring,
      PROJECT_ID,
    );
    const sharedTitle = toEncryptedWire(
      {
        id: "w-op-3",
        entity: "task",
        entityId: "t-shared",
        ts: { wallMs: 1000, counter: 2, node: NODE_B },
        op: "set",
        field: "title",
        value: "Shared secret",
      },
      srcKeyring,
      PROJECT_ID,
    );
    return new Map<string, unknown>([
      ["", { operations: [personal], cursor: 42, next: `task/t-shared/42` }],
      [`task/t-shared/42`, { operations: [sharedLink, sharedTitle], cursor: 42 }],
    ]);
  }

  /** A FetchLike serving the snapshot pages by resume token, plus empty pull / stub push. */
  function snapshotFetch(
    pages: Map<string, unknown>,
    requestedTokens: string[],
    limits: (string | null)[] = [],
  ): FetchLike {
    return async (url) => {
      const u = new URL(url);
      if (u.pathname === "/sync/snapshot") {
        // The split `after_entity`/`after_id` form is the legacy shape; the token goes back whole.
        if (u.searchParams.has("after_entity"))
          return new Response("legacy token", { status: 400 });
        const token = u.searchParams.get("next") ?? "";
        requestedTokens.push(token);
        limits.push(u.searchParams.get("limit"));
        const body = pages.get(token);
        if (body === undefined) return new Response("bad token", { status: 400 });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.pathname === "/sync/pull") {
        return new Response(JSON.stringify({ operations: [], cursor: 42 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.pathname === "/sync/push") {
        return new Response(JSON.stringify({ cursor: 42, applied: 0 }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };
  }

  it("decrypts DEK-scoped and PEK-scoped snapshot pages with the right keys", async () => {
    const dek = generateDek();
    const pek = generatePek();
    const srcKeyring = new Keyring({ dek });
    srcKeyring.setProjectKey(PROJECT_ID, pek);

    const requestedTokens: string[] = [];
    const limits: (string | null)[] = [];
    const api = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: snapshotFetch(snapshotPages(srcKeyring), requestedTokens, limits),
    });
    api.setKeyring(srcKeyring);

    const s = store(NODE_A);
    const client = new SyncClient(s, api);
    await client.sync();

    // The opaque token went back verbatim as `next` (its pinned cursor included), with a page size.
    expect(requestedTokens).toEqual(["", "task/t-shared/42"]);
    expect(limits).toEqual(["500", "500"]);
    // The personal task decrypted under the DEK, the shared one under the project's PEK.
    expect(s.get("task", "t-personal")).toEqual({ title: "Personal secret" });
    expect(s.get("task", "t-shared")).toEqual({
      project_id: PROJECT_ID,
      title: "Shared secret",
    });
  });

  it("keeps ciphertext for a scope the keyring cannot open (missing PEK), like the pull path", async () => {
    const dek = generateDek();
    const pek = generatePek();
    const srcKeyring = new Keyring({ dek });
    srcKeyring.setProjectKey(PROJECT_ID, pek);

    const requestedTokens: string[] = [];
    const api = new ApiClient({
      baseUrl: "https://api.example.com",
      fetch: snapshotFetch(snapshotPages(srcKeyring), requestedTokens),
    });
    // This device has the DEK but never received the project's PEK: the personal task still
    // decrypts; the shared task's fields, its link included, survive sealed under their wire kind
    // (not crash, not drop) until the key arrives.
    const keyring = new Keyring({ dek });
    api.setKeyring(keyring);

    const s = store(NODE_A);
    const client = new SyncClient(s, api);
    await client.sync();

    expect(s.get("task", "t-personal")).toEqual({ title: "Personal secret" });
    expect(s.get("task", "t-shared")).toBeNull();
    expect(s.lockedCount()).toBe(2);

    keyring.setProjectKey(PROJECT_ID, pek);
    expect(reviveLockedValues(s, keyring).revived).toBe(2);
    expect(s.get("task", "t-shared")).toEqual({ project_id: PROJECT_ID, title: "Shared secret" });
  });
});

describe("repairs of a snapshot walk that spans launches", () => {
  it("writes the repairs of the pages walked before the app was closed", async () => {
    const seed = store(NODE_B, 5000);
    const ops = [1, 2, 3].map((i) => seed.set("task", `t${i}`, "title", `v${i}`));
    // Each page carries one task whose value arrived under a key it must be re-written with.
    const pages: Record<string, { i: number; next?: string }> = {
      "": { i: 0, next: "p2" },
      p2: { i: 1, next: "p3" },
      p3: { i: 2 },
    };
    let throttle = true;
    const pushed: Operation[] = [];
    const transport: SyncTransport = {
      syncPush: vi.fn(async (batch: Operation[]) => {
        pushed.push(...batch);
        return { cursor: 3, applied: batch.length };
      }),
      syncPull: vi.fn(async () => ({ operations: [], cursor: 3 })),
      syncSnapshot: vi.fn(async (next?: string) => {
        if (next === "p3" && throttle) {
          throttle = false;
          throw new ApiError(429, "too many requests");
        }
        const page = pages[next ?? ""]!;
        const op = ops[page.i]! as Extract<Operation, { op: "set" }>;
        return {
          operations: [op],
          cursor: 3,
          next: page.next,
          repairs: [
            {
              entity: "task" as const,
              entityId: op.entityId,
              field: "title",
              ts: op.ts,
              value: op.value,
              reason: "key" as const,
            },
          ],
        };
      }),
    };
    const persistence = new MemoryPersistence();
    const wire = (
      s: LocalStore,
      bootstrap: Awaited<ReturnType<MemoryPersistence["getBootstrap"]>>,
    ) =>
      new SyncClient(s, transport, {
        cursor: 0,
        bootstrap,
        onBootstrapProgress: (p, page) => void persistence.setBootstrap(p, page),
        onCursor: (c) => void persistence.setCursor(c),
      });

    // Pages 1 and 2 land, page 3 answers 429, and the app is closed.
    let n = 0;
    const first = new LocalStore(NODE_A, { persistence, newId: () => `a-${n++}` });
    await expect(wire(first, null).sync()).rejects.toBeInstanceOf(ApiError);
    await first.flush();

    // The next launch finishes the walk; every page's value is re-written, not only page 3's.
    const second = new LocalStore(NODE_A, { persistence, newId: () => `b-${n++}` });
    await second.hydrate();
    await wire(second, await persistence.getBootstrap()).sync();

    expect(pushed.map((o) => o.entityId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(await persistence.getBootstrap()).toBeNull();
  });
});
