/**
 * The offline queue for bug reports: a crash is likely when the app cannot reach the server, so an
 * unsent report is stored and retried on the next launch and every foreground. Every function
 * swallows its own errors, since a failure to persist must never become a second crash.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { BugReportPayload } from "@atlastodo/client-core";

const KEY = "atlas.reportQueue";

/** Keeps the queue small: with ten waiting another is likely the same bug, and it would otherwise leak storage. */
const MAX_QUEUED = 10;

/**
 * A queued report, tagged with the user who was signed in when it was captured (null: nobody).
 * Untagged entries predate the tag, or were captured before any client existed.
 */
export type QueuedReport = BugReportPayload & { owner?: string | null };

/** The storage surface, injected in tests. */
export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

let storage: QueueStorage = AsyncStorage;

/** Swap the backing store. Tests only. */
export function __setQueueStorageForTests(next: QueueStorage): void {
  storage = next;
}

/** Everything currently waiting, oldest first. Returns `[]` if storage is unreadable or corrupt. */
export async function readQueue(): Promise<QueuedReport[]> {
  try {
    const raw = await storage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedReport[]) : [];
  } catch {
    return [];
  }
}

async function write(items: QueuedReport[]): Promise<void> {
  try {
    await storage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage full or unavailable: losing the report beats throwing out of a crash handler.
  }
}

/**
 * Add a report, evicting the oldest once the queue is full. Re-adding an id already queued replaces
 * it rather than duplicating, so a retry loop cannot grow the queue.
 */
export async function enqueueReport(payload: QueuedReport): Promise<void> {
  const items = (await readQueue()).filter((r) => r.id !== payload.id);
  items.push(payload);
  await write(items.slice(-MAX_QUEUED));
}

/** Drop a report by id, after it is delivered (or permanently rejected). */
export async function removeReport(id: string): Promise<void> {
  const items = await readQueue();
  const next = items.filter((r) => r.id !== id);
  if (next.length !== items.length) await write(next);
}
