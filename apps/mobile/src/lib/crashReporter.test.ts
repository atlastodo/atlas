import {
  ApiError,
  NetworkError,
  type ApiClient,
  type BugReportPayload,
} from "@atlastodo/client-core";
import {
  __resetReporterForTests,
  captureError,
  configureReporter,
  flushQueue,
  setReporter,
} from "./crashReporter";
import { __setQueueStorageForTests, readQueue, type QueueStorage } from "./reportQueue";

function fakeStorage(): QueueStorage {
  const data: Record<string, string> = {};
  return {
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
  };
}

/** The only method the reporter ever reaches for, typed so the assertions below stay checked. */
type SubmitMock = jest.Mock<Promise<void>, [BugReportPayload]>;

function submitter(impl?: (r: BugReportPayload) => Promise<void>): SubmitMock {
  return jest.fn(impl ?? (async () => {})) as SubmitMock;
}

/** A minimal ApiClient stand-in: only `submitReport` is ever reached from here. */
function fakeApi(submitReport: SubmitMock): ApiClient {
  return { submitReport } as unknown as ApiClient;
}

let nextId = 0;

beforeEach(() => {
  __resetReporterForTests();
  __setQueueStorageForTests(fakeStorage());
  nextId = 0;
  configureReporter({
    newId: () => `id-${++nextId}`,
    appVersion: "0.18.0",
    platform: "ios",
    osVersion: "18.0",
  });
});

describe("captureError", () => {
  it("queues a report when no client is bound yet", async () => {
    // A crash during startup happens before AuthProvider has built the client. Losing it would lose
    // exactly the reports that matter most.
    await expect(captureError(new Error("early boom"), "crash")).resolves.toBe("queued");
    expect((await readQueue()).map((r) => r.message)).toEqual(["early boom"]);
  });

  it("queues a report when the send fails transiently", async () => {
    const submit = submitter(async () => {
      throw new NetworkError("unreachable");
    });
    setReporter({ api: fakeApi(submit) });

    await expect(captureError(new Error("boom"), "crash")).resolves.toBe("queued");
    expect(await readQueue()).toHaveLength(1);
  });

  it("drops a report the server permanently rejected", async () => {
    // A 4xx means this payload will never be accepted; retrying it forever would block the queue.
    const submit = submitter(async () => {
      throw new ApiError(400, "unknown report kind");
    });
    setReporter({ api: fakeApi(submit) });

    await expect(captureError(new Error("boom"), "crash")).resolves.toBe("failed");
    expect(await readQueue()).toHaveLength(0);
  });

  it("files a repeating crash only once", async () => {
    // A render loop throws many times a second. That is one bug, not sixty reports.
    const submit = submitter();
    setReporter({ api: fakeApi(submit) });

    const err = new Error("same failure");
    for (let i = 0; i < 5; i++) await captureError(err, "crash");

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe manual reports", async () => {
    // The user meant to send each one, even if they typed the same thing twice.
    const submit = submitter();
    setReporter({ api: fakeApi(submit) });

    await captureError(new Error("manual report"), "manual", { description: "it froze" });
    await captureError(new Error("manual report"), "manual", { description: "it froze" });

    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("stops after the per-session cap", async () => {
    const submit = submitter();
    setReporter({ api: fakeApi(submit) });

    for (let i = 0; i < 12; i++) await captureError(new Error(`distinct ${i}`), "crash");

    expect(submit).toHaveBeenCalledTimes(5);
  });

  it("never throws, even when the client throws synchronously", async () => {
    // The reporter must not be the reason the app dies.
    const submit = submitter(() => {
      throw new Error("client exploded");
    });
    setReporter({ api: fakeApi(submit) });

    await expect(captureError(new Error("boom"), "crash")).resolves.toBe("queued");
  });
});

describe("delivery that must survive a bad minute", () => {
  it("keeps a report the server rate-limited instead of dropping it", async () => {
    const submit = submitter(async () => {
      throw new ApiError(429, "too many requests");
    });
    setReporter({ api: fakeApi(submit) });

    await expect(captureError(new Error("boom"), "crash")).resolves.toBe("queued");
    await flushQueue();

    expect(await readQueue()).toHaveLength(1);
  });

  it("does not count manual reports against the crash cap", async () => {
    const submit = submitter();
    setReporter({ api: fakeApi(submit) });
    for (let i = 0; i < 12; i++) await captureError(new Error(`distinct ${i}`), "crash");

    await expect(
      captureError(new Error("manual report"), "manual", { description: "help" }),
    ).resolves.toBe("sent");
  });

  it("delivers a queued report only under the session that captured it", async () => {
    const offline = submitter(async () => {
      throw new NetworkError("offline");
    });
    setReporter({ api: fakeApi(offline), userId: "alice" });
    await captureError(new Error("alice's crash"), "crash");

    // Bob signs in on the same device: the server would file Alice's report under Bob.
    const asBob = submitter();
    setReporter({ api: fakeApi(asBob), userId: "bob" });
    await flushQueue();
    expect(asBob).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(1);

    const asAlice = submitter();
    setReporter({ api: fakeApi(asAlice), userId: "alice" });
    await flushQueue();
    expect(asAlice.mock.calls.map(([r]) => r.message)).toEqual(["alice's crash"]);
    expect(await readQueue()).toHaveLength(0);
  });
});

describe("flushQueue", () => {
  it("delivers queued reports once a client appears", async () => {
    await captureError(new Error("early"), "crash");
    expect(await readQueue()).toHaveLength(1);

    const submit = submitter();
    setReporter({ api: fakeApi(submit) });
    await flushQueue();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(await readQueue()).toHaveLength(0);
  });

  it("keeps a report that could not be delivered", async () => {
    await captureError(new Error("early"), "crash");
    const submit = submitter(async () => {
      throw new NetworkError("still offline");
    });
    setReporter({ api: fakeApi(submit) });

    await flushQueue();

    expect(await readQueue()).toHaveLength(1);
  });

  it("does nothing when no client is bound", async () => {
    await captureError(new Error("early"), "crash");
    await expect(flushQueue()).resolves.toBeUndefined();
    expect(await readQueue()).toHaveLength(1);
  });
});
