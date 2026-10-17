import type { BugReportPayload } from "@atlastodo/client-core";
import {
  __setQueueStorageForTests,
  enqueueReport,
  readQueue,
  removeReport,
  type QueueStorage,
} from "./reportQueue";

/** An in-memory storage double, injected rather than mocked -- the repo's prefer-DI rule. */
function fakeStorage(initial: Record<string, string> = {}): QueueStorage & {
  fail: (on: boolean) => void;
} {
  const data = { ...initial };
  let failing = false;
  return {
    getItem: async (key) => {
      if (failing) throw new Error("storage unavailable");
      return data[key] ?? null;
    },
    setItem: async (key, value) => {
      if (failing) throw new Error("storage unavailable");
      data[key] = value;
    },
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

function report(id: string): BugReportPayload {
  return {
    id,
    kind: "crash",
    message: `boom ${id}`,
    appVersion: "0.18.0",
    platform: "ios",
    diagnostics: {
      syncStatus: null,
      lastSyncAt: null,
      pending: 0,
      quarantined: 0,
      lastErrorKind: null,
      lastErrorStatus: null,
      lastErrorMessage: null,
      online: null,
    },
    breadcrumbs: [],
    occurredAt: 1,
  };
}

describe("reportQueue", () => {
  it("keeps the newest reports when full", async () => {
    // A device that never reconnects must not grow the queue forever, and the eleventh crash is
    // almost certainly the same bug as the tenth.
    __setQueueStorageForTests(fakeStorage());
    for (let i = 0; i < 14; i++) await enqueueReport(report(`r${i}`));
    const ids = (await readQueue()).map((r) => r.id);
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("r4");
    expect(ids[9]).toBe("r13");
  });

  it("replaces rather than duplicates when the same id is queued twice", async () => {
    // A failed send re-queues; without this the retry loop would grow the queue by one each pass.
    __setQueueStorageForTests(fakeStorage());
    await enqueueReport(report("a"));
    await enqueueReport(report("a"));
    expect(await readQueue()).toHaveLength(1);
  });

  it("never throws when storage is broken", async () => {
    // This is the storage layer of a crash reporter: a failure here must not become a second crash.
    const storage = fakeStorage();
    __setQueueStorageForTests(storage);
    storage.fail(true);
    await expect(readQueue()).resolves.toEqual([]);
    await expect(enqueueReport(report("a"))).resolves.toBeUndefined();
    await expect(removeReport("a")).resolves.toBeUndefined();
  });

  it("treats corrupt stored data as an empty queue", async () => {
    __setQueueStorageForTests(fakeStorage({ "atlas.reportQueue": "{not json" }));
    expect(await readQueue()).toEqual([]);
  });
});
