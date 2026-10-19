/**
 * Building a bug report that carries no task content, in layers:
 * 1. Allowlist construction: {@link buildBugReport} never spreads; every payload field is named.
 * 2. A non-`Error` throw keeps only its type name: `throw "task \"Buy flowers\" is broken"` is a
 *    real pattern and no string matching would be trustworthy.
 * 3. {@link stackFrames} keeps only lines that look like stack frames.
 * 4. {@link redactText} on every string the app did not author: quoted runs and content-shaped key
 *    values are replaced, then truncated.
 * 5. Breadcrumb refs and routes are allowlisted ({@link sanitizeRef}): a path or UUID, else dropped.
 *
 * Residual gap: an `Error` message interpolating a task title unquoted survives layers 1-3 and is
 * only truncated. House rule: never interpolate a task title or notes into a thrown `Error`.
 */

import type {
  BreadcrumbCode,
  BugReportBreadcrumb,
  BugReportDiagnostics,
  BugReportKind,
  BugReportPayload,
} from "@atlastodo/client-core";

// Mirrors the server's caps.
export const REPORT_LIMITS = {
  message: 2_000,
  stack: 16_000,
  description: 4_000,
  shortField: 200,
  breadcrumbs: 50,
  frame: 200,
} as const;

const V8_FRAME = /^\s*at\s+\S/;
// The name before `@` holds no `@`, so a line of repeated `@`s cannot backtrack quadratically.
const HERMES_FRAME = /^\s*[^\s@]+@\S+:\d+:\d+\s*$/;

/** A route path or a bare id; narrow, since a task title has spaces. */
const SAFE_REF = /^[A-Za-z0-9/_.-]{1,64}$/;

const QUOTED = /"[^"]{2,}"|'[^']{2,}'|`[^`]{2,}`/g;
const CONTENT_KEY =
  /("?\b(title|notes|name|description|content|text|body|comment|label|email)"?\s*[:=]\s*)([^,}\n]+)/gi;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

const REDACTED = "<redacted>";

// Never splits a surrogate pair, which would break JSON encoding downstream.
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  // A high surrogate at the cut would be orphaned; step back one.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// Order matters: quoted runs first, then content-shaped keys (`title: Buy flowers`), then emails.
export function redactText(text: string, max: number = REPORT_LIMITS.message): string {
  const scrubbed = text
    .replace(QUOTED, REDACTED)
    .replace(CONTENT_KEY, `$1${REDACTED}`)
    .replace(EMAIL, REDACTED);
  return truncate(scrubbed, max);
}

// No email rule here: it matches a Hermes frame (`onPress@app.bundle:99:7`) and would blank every native stack line.
function redactFrame(line: string): string {
  return truncate(
    line.replace(QUOTED, REDACTED).replace(CONTENT_KEY, `$1${REDACTED}`),
    REPORT_LIMITS.frame,
  );
}

// Dropped rather than redacted when not unambiguously a route or id.
export function sanitizeRef(ref: string | undefined | null): string | undefined {
  if (!ref) return undefined;
  const trimmed = ref.trim();
  return SAFE_REF.test(trimmed) ? trimmed : undefined;
}

// The first line repeats the message and is dropped; every other line must look like a frame.
export function stackFrames(stack: string | undefined | null): string | undefined {
  if (!stack) return undefined;
  const frames = stack
    .split("\n")
    .slice(1)
    .filter((line) => V8_FRAME.test(line) || HERMES_FRAME.test(line))
    .map((line) => redactFrame(line.trim()));
  if (frames.length === 0) return undefined;
  return truncate(frames.join("\n"), REPORT_LIMITS.stack);
}

interface ThrownParts {
  message: string;
  stack?: string;
}

// Anything but a real `Error` yields only its type: a thrown string could be a task title verbatim.
function readThrown(thrown: unknown): ThrownParts {
  if (thrown instanceof Error) {
    return {
      message: redactText(thrown.message || thrown.name, REPORT_LIMITS.message),
      stack: stackFrames(thrown.stack),
    };
  }
  if (thrown && typeof thrown === "object") {
    // A non-Error object: its constructor name is a hint and cannot contain user text.
    return { message: `<non-error thrown: ${thrown.constructor?.name ?? "object"}>` };
  }
  return { message: `<non-error thrown: ${typeof thrown}>` };
}

export interface BreadcrumbTrail {
  add(code: BreadcrumbCode, ref: string | undefined, at: number): void;
  list(): BugReportBreadcrumb[];
  clear(): void;
}

export function createBreadcrumbTrail(capacity = 30): BreadcrumbTrail {
  const items: BugReportBreadcrumb[] = [];
  return {
    add(code, ref, at) {
      items.push({ at, code, ref: sanitizeRef(ref) });
      if (items.length > capacity) items.splice(0, items.length - capacity);
    },
    list: () => items.map((c) => ({ ...c })),
    clear: () => {
      items.length = 0;
    },
  };
}

export interface BuildReportInput {
  // Mint with `store.newEntityId()`, never `crypto.randomUUID()` (Hermes has none).
  id: string;
  kind: BugReportKind;
  thrown: unknown;
  appVersion: string;
  platform: string;
  osVersion?: string;
  route?: string;
  description?: string;
  deviceId?: string;
  diagnostics: BugReportDiagnostics;
  breadcrumbs: BugReportBreadcrumb[];
  now: number;
}

// Every field is assigned by name, with no spread, so a new field cannot ship unreviewed.
export function buildBugReport(input: BuildReportInput): BugReportPayload {
  const { message, stack } = readThrown(input.thrown);
  const d = input.diagnostics;
  return {
    id: input.id,
    kind: input.kind,
    message,
    stack,
    // Typed by the user: capped, not scrubbed, or the form would be pointless.
    description:
      input.description === undefined
        ? undefined
        : truncate(input.description, REPORT_LIMITS.description),
    appVersion: truncate(input.appVersion, REPORT_LIMITS.shortField),
    platform: truncate(input.platform, REPORT_LIMITS.shortField),
    osVersion:
      input.osVersion === undefined
        ? undefined
        : truncate(input.osVersion, REPORT_LIMITS.shortField),
    route: sanitizeRef(input.route),
    deviceId: sanitizeRef(input.deviceId),
    diagnostics: {
      syncStatus: d.syncStatus,
      lastSyncAt: d.lastSyncAt,
      pending: d.pending,
      quarantined: d.quarantined,
      lastErrorKind: d.lastErrorKind,
      lastErrorStatus: d.lastErrorStatus,
      // A sync error message can quote a server response, so it goes through the same scrubbing.
      lastErrorMessage:
        d.lastErrorMessage === null
          ? null
          : redactText(d.lastErrorMessage, REPORT_LIMITS.shortField),
      online: d.online,
    },
    breadcrumbs: input.breadcrumbs.slice(-REPORT_LIMITS.breadcrumbs).map((c) => ({
      at: c.at,
      code: c.code,
      ref: sanitizeRef(c.ref),
    })),
    occurredAt: input.now,
  };
}

export function emptyDiagnostics(): BugReportDiagnostics {
  return {
    syncStatus: null,
    lastSyncAt: null,
    pending: 0,
    quarantined: 0,
    lastErrorKind: null,
    lastErrorStatus: null,
    lastErrorMessage: null,
    online: null,
  };
}
