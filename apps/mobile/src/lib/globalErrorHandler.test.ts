import type { ApiClient, BugReportPayload } from "@atlastodo/client-core";
import {
  __resetReporterForTests,
  configureReporter,
  flushQueue,
  setReporter,
} from "./crashReporter";
import { __setCrashSlotStorageForTests, peekFatalSync, type SlotStorage } from "./crashSlot";
import { __setQueueStorageForTests, type QueueStorage } from "./reportQueue";
import { installGlobalErrorHandler } from "./globalErrorHandler";

/**
 * React Native's own fatal handler ends a release build's process the moment it runs, so whatever
 * the reporter left for later never happened. The report has to be on disk before that handler is
 * called -- which this asserts by looking at the disk from inside it.
 */

function memorySlot(): SlotStorage {
  let value: string | null = null;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
  };
}

function memoryQueue(): QueueStorage {
  const data: Record<string, string> = {};
  return {
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
  };
}

type Handler = (error: unknown, isFatal?: boolean) => void;
let handler: Handler = () => {};
let onDisk: string[] | null = null;
// Stands in for RN's default: in a release build this is where the process dies.
const previous = jest.fn(() => {
  onDisk = peekFatalSync().map((p) => p.message);
});

beforeAll(() => {
  (globalThis as { ErrorUtils?: unknown }).ErrorUtils = {
    getGlobalHandler: () => previous,
    setGlobalHandler: (next: Handler) => {
      handler = next;
    },
  };
  installGlobalErrorHandler();
});

afterAll(() => {
  delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
});

beforeEach(() => {
  __resetReporterForTests();
  __setCrashSlotStorageForTests(memorySlot());
  __setQueueStorageForTests(memoryQueue());
  configureReporter({
    newId: () => "11111111-1111-4111-8111-111111111111",
    appVersion: "1.0.0",
    platform: "ios",
  });
  previous.mockClear();
  onDisk = null;
});

describe("the native global error handler", () => {
  it("has a fatal crash on disk before the previous handler can end the process", () => {
    handler(new Error("fatal boom"), true);

    expect(previous).toHaveBeenCalledTimes(1);
    expect(onDisk).toEqual(["fatal boom"]);
  });

  it("sends the saved crash on the next launch's flush", async () => {
    handler(new Error("fatal boom"), true);
    // Signed out, nothing bound: the in-process flush can only move it along.
    await flushQueue();
    // The next launch: a fresh reporter finds the report on disk.
    __resetReporterForTests();
    const submitted: BugReportPayload[] = [];
    setReporter({
      api: {
        submitReport: async (r: BugReportPayload) => void submitted.push(r),
      } as unknown as ApiClient,
    });

    await flushQueue();

    expect(submitted.map((r) => r.message)).toEqual(["fatal boom"]);
    expect(peekFatalSync()).toEqual([]);
  });
});
