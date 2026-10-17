/**
 * The crash reporter: a module-level singleton that captures an error, redacts it, and sends it to
 * the server, queueing to disk when that is not possible right now.
 *
 * It is a module rather than a context because the root `ErrorBoundary` renders above
 * `AuthProvider` and `StoreProvider`, so their hooks are gone at crash time. Null-render components
 * inside those providers push the diagnostics and the `ApiClient` into this module instead.
 *
 * A reporter that throws turns one bug into a crash loop, so `captureError` cannot throw, cannot
 * recurse, and cannot file an unbounded number of reports.
 */

import {
  buildBugReport,
  createBreadcrumbTrail,
  emptyDiagnostics,
  type BreadcrumbTrail,
} from "@atlastodo/shared";
import type {
  ApiClient,
  BreadcrumbCode,
  BugReportDiagnostics,
  BugReportKind,
  BugReportPayload,
} from "@atlastodo/client-core";
import { ApiError } from "@atlastodo/client-core";
import { enqueueReport, readQueue, removeReport } from "./reportQueue";
import { clearFatalSync, peekFatalSync, saveFatalSync } from "./crashSlot";

export type CaptureResult = "sent" | "queued" | "failed";

/**
 * Bounds that keep a crash loop to a few reports: a re-entrancy flag, a dedupe set for repeats of
 * the same error, and this per-session cap as the backstop.
 */
const MAX_REPORTS_PER_SESSION = 5;

let trail: BreadcrumbTrail = createBreadcrumbTrail(30);
let diagnostics: BugReportDiagnostics = emptyDiagnostics();
let route: string | undefined;
/**
 * The client reports go through. The server files a report under the signed-in caller, so `userId`
 * (null when signed out) decides which queued reports may go out.
 */
interface Reporter {
  api: ApiClient;
  deviceId?: string;
  userId?: string | null;
}
let reporter: Reporter | null = null;
let appInfo = {
  appVersion: "0.0.0",
  platform: "unknown",
  osVersion: undefined as string | undefined,
};

let capturing = false;
let filedThisSession = 0;
const seen = new Set<string>();
/** Serializes queue flushes so two triggers cannot double-send the same entry. */
let flushChain: Promise<void> = Promise.resolve();

/** Mints report ids; injected because Hermes has no global `crypto`. */
let newId: () => string = () => "00000000-0000-4000-8000-000000000000";

/** Called once at startup with the platform's id generator and app metadata. */
export function configureReporter(opts: {
  newId: () => string;
  appVersion: string;
  platform: string;
  osVersion?: string;
}): void {
  newId = opts.newId;
  appInfo = {
    appVersion: opts.appVersion,
    platform: opts.platform,
    osVersion: opts.osVersion,
  };
}

export function setDiagnosticsSnapshot(next: BugReportDiagnostics): void {
  diagnostics = next;
}

/** Publish the current route and drop a navigation breadcrumb. */
export function setRoute(next: string | undefined, at: number): void {
  route = next;
  if (next) trail.add("nav", next, at);
}

/** Record an event. Codes are a closed union, so a breadcrumb can never carry user text. */
export function breadcrumb(code: BreadcrumbCode, ref: string | undefined, at: number): void {
  trail.add(code, ref, at);
}

/**
 * Bind (or unbind) the API client. Bound above the session gate: the client exists whether or not
 * anyone is signed in, and an anonymous report must not be dropped.
 */
export function setReporter(next: Reporter | null): void {
  reporter = next;
}

/** A fresh report id, for a form that rebuilds its preview but keeps one id throughout. */
export function mintReportId(): string {
  return newId();
}

/** Build the payload that would be sent, for the manual form's preview. */
export function buildPreview(
  kind: BugReportKind,
  thrown: unknown,
  now: number,
  description?: string,
  id: string = newId(),
): BugReportPayload {
  return buildBugReport({
    id,
    kind,
    thrown,
    appVersion: appInfo.appVersion,
    platform: appInfo.platform,
    osVersion: appInfo.osVersion,
    route,
    description,
    deviceId: reporter?.deviceId,
    diagnostics,
    breadcrumbs: trail.list(),
    now,
  });
}

/** Dedupe key for a repeating error: its message plus its first frame. */
function dedupeKey(payload: BugReportPayload): string {
  return `${payload.message}|${payload.stack?.split("\n")[0] ?? ""}`;
}

/**
 * A 4xx about the payload means it will never be accepted, so the report is dropped. A 5xx, a
 * network failure and the 4xx that say nothing about the report (rate limit, timeout, session
 * problem) are retried, or one busy minute would wipe the queue.
 */
const TRANSIENT_4XX = new Set([401, 403, 408, 429]);

function isPermanent(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status >= 400 &&
    err.status < 500 &&
    !TRANSIENT_4XX.has(err.status)
  );
}

/**
 * Send one report now, or queue it. A queued report remembers its owner, so it is never filed
 * under someone else's session.
 */
async function deliver(payload: BugReportPayload): Promise<CaptureResult> {
  if (!reporter) {
    await enqueueReport(payload);
    return "queued";
  }
  const owner = reporter.userId ?? null;
  try {
    await reporter.api.submitReport(payload);
    return "sent";
  } catch (err) {
    if (isPermanent(err)) return "failed";
    await enqueueReport({ ...payload, owner });
    return "queued";
  }
}

/**
 * Capture an error: build the redacted payload, try to send it, queue it on failure. Never throws
 * or recurses; any internal failure yields `"failed"`.
 */
export async function captureError(
  thrown: unknown,
  kind: BugReportKind,
  opts: { description?: string; now?: number } = {},
): Promise<CaptureResult> {
  if (capturing) return "failed";
  capturing = true;
  try {
    // The cap and dedupe are for crash loops; the user meant to send each manual report.
    if (kind === "crash" && filedThisSession >= MAX_REPORTS_PER_SESSION) return "failed";
    const now = opts.now ?? Date.now();
    const payload = buildPreview(kind, thrown, now, opts.description);

    if (kind === "crash") {
      const key = dedupeKey(payload);
      if (seen.has(key)) return "queued";
      seen.add(key);
      filedThisSession += 1;
    }
    return await deliver(payload);
  } catch {
    return "failed";
  } finally {
    capturing = false;
  }
}

/** File a report exactly as built: the manual form sends the payload it showed. Never throws. */
export async function sendReport(payload: BugReportPayload): Promise<CaptureResult> {
  try {
    return await deliver(payload);
  } catch {
    return "failed";
  }
}

/**
 * Capture a crash about to end the process: write the report to disk with nothing asynchronous in
 * the way (see `crashSlot`). The next {@link flushQueue} sends it. Never throws.
 */
export function captureFatalSync(thrown: unknown): void {
  if (capturing) return;
  try {
    if (filedThisSession >= MAX_REPORTS_PER_SESSION) return;
    const payload = buildPreview("crash", thrown, Date.now());
    const key = dedupeKey(payload);
    if (seen.has(key)) return;
    seen.add(key);
    filedThisSession += 1;
    saveFatalSync({ ...payload, owner: reporter ? (reporter.userId ?? null) : undefined });
  } catch {
    // Never let the reporter be the reason the app dies.
  }
}

/** Move the reports a crash saved synchronously into the ordinary queue. */
async function adoptFatalReports(): Promise<void> {
  const saved = peekFatalSync();
  if (saved.length === 0) return;
  for (const payload of saved) await enqueueReport(payload);
  // Cleared last: a crash mid-move leaves them in the slot, and re-adding an id replaces it.
  clearFatalSync(saved.map((p) => p.id));
}

/** Deliver the offline queue. Calls are chained, so two triggers cannot send an entry twice. */
export function flushQueue(): Promise<void> {
  flushChain = flushChain.then(async () => {
    try {
      await adoptFatalReports();
    } catch {
      // Left in the slot for the next flush.
    }
    const api = reporter?.api;
    if (!api) return;
    const current = reporter?.userId ?? null;
    try {
      for (const payload of await readQueue()) {
        // Another session's report waits for that session; the server would file it under the
        // current user.
        if (payload.owner !== undefined && payload.owner !== current) continue;
        try {
          const { owner: _owner, ...report } = payload;
          await api.submitReport(report);
          await removeReport(payload.id);
        } catch (err) {
          // A payload the server will never accept is dropped; anything else stays.
          if (isPermanent(err)) await removeReport(payload.id);
          else break;
        }
      }
    } catch {
      // Storage unreadable: nothing to do.
    }
  });
  return flushChain;
}

/** Reset every module-level bound. Tests only. */
export function __resetReporterForTests(): void {
  trail = createBreadcrumbTrail(30);
  diagnostics = emptyDiagnostics();
  route = undefined;
  reporter = null;
  capturing = false;
  filedThisSession = 0;
  seen.clear();
  flushChain = Promise.resolve();
  newId = () => "00000000-0000-4000-8000-000000000000";
}
