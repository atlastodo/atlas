import { addDays, endOfDay, makeInstant, resolveTimeZone } from "@atlas/shared";
import { AtlasError } from "./client";

/**
 * Read a due date the way an integration is likely to send one, into the app's convention.
 * - `null`, `""` or `"none"`: no date.
 * - A number, or a string of digits: unix milliseconds.
 * - `YYYY-MM-DD`, `today`, `tomorrow`: that day, at the app's default due time in `timeZone`
 *   (what picking a day in the app gives).
 * - `YYYY-MM-DDTHH:MM[:SS]`: that wall time in `timeZone`; with `Z` or an offset, that instant.
 */
export function parseDue(
  value: string | number | null | undefined,
  timeZone?: string,
  now: number = Date.now(),
): number | null {
  if (value == null) return null;
  if (typeof value === "number") return checkMs(value);
  const text = value.trim();
  const lower = text.toLowerCase();
  if (lower === "" || lower === "none") return null;
  if (/^\d+$/.test(text)) return checkMs(Number(text));
  const tz = resolveTimeZone(timeZone);
  if (lower === "today") return endOfDay(now, tz);
  if (lower === "tomorrow") return endOfDay(addDays(now, 1, tz), tz);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) {
    const [, y, m, d] = date.map(Number) as [number, number, number, number];
    checkParts(value, y, m, d);
    return endOfDay(makeInstant(y, m - 1, d, 12, 0, 0, tz), tz);
  }
  const wall = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (wall) {
    const [, y, m, d, h, min, s] = wall.map((v) => Number(v ?? 0)) as number[];
    checkParts(value, y!, m!, d!, h!, min!, s!);
    return makeInstant(y!, m! - 1, d!, h!, min!, s!, tz);
  }
  const instant = Date.parse(text);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(instant)) return instant;
  throw unreadable(value);
}

function unreadable(value: string): AtlasError {
  return new AtlasError(
    "bad_input",
    `cannot read the date "${value}" (use YYYY-MM-DD, YYYY-MM-DDTHH:MM, ISO 8601 or unix ms)`,
  );
}

/** `makeInstant` rolls over (month 13 is next January): refuse out-of-range parts instead. */
function checkParts(value: string, y: number, m: number, d: number, h = 0, min = 0, s = 0): void {
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth || h > 23 || min > 59 || s > 59) {
    throw unreadable(value);
  }
}

function checkMs(ms: number): number {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    throw new AtlasError("bad_input", `not a timestamp: ${ms}`);
  }
  return ms;
}
