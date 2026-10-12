/**
 * Timezone-aware day-boundary math on `Intl.DateTimeFormat`, the single source of the instant to
 * calendar-day mapping for smart lists, calendar and quick-add. `timeZone` defaults to the runtime's.
 */

const DAY_MS = 86_400_000;

const MAX_DATE_MS = 8.64e15;
// How far before a gap to read the offset in force; DST gaps are far shorter, and transitions far apart.
const GAP_PROBE_MS = DAY_MS;

const zoneValidity = new Map<string, boolean>();

export function isValidTimeZone(timeZone: string): boolean {
  let ok = zoneValidity.get(timeZone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      ok = true;
    } catch {
      ok = false;
    }
    zoneValidity.set(timeZone, ok);
  }
  return ok;
}

// Falls back to the runtime default when blank or unknown here (a name synced from another device's ICU must not crash every list).
export function resolveTimeZone(timeZone?: string): string {
  if (timeZone && timeZone.length > 0 && isValidTimeZone(timeZone)) return timeZone;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export interface ZonedParts {
  year: number;
  month: number; // 0-indexed (JS convention)
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

// One formatter per zone, cached.
const partsFmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFmtCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFmtCache.set(timeZone, fmt);
  }
  return fmt;
}

const INVALID_PARTS: ZonedParts = {
  year: NaN,
  month: NaN,
  day: NaN,
  hour: NaN,
  minute: NaN,
  second: NaN,
  weekday: NaN,
};

// A non-date instant (NaN, out of range) yields all-NaN parts instead of throwing, so one corrupt timestamp cannot take down a list.
export function zonedParts(ms: number, timeZone?: string): ZonedParts {
  if (!(Math.abs(ms) <= MAX_DATE_MS)) return { ...INVALID_PARTS };
  const tz = resolveTimeZone(timeZone);
  const parts = partsFormatter(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // en-US counts years before 1 AD as "1 BC"; convert to the astronomical year.
  const bc = parts.find((p) => p.type === "era")?.value === "BC";
  const year = bc ? 1 - get("year") : get("year");
  const month = get("month") - 1;
  const day = get("day");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit "24" for midnight under h23
  const minute = get("minute");
  const second = get("second");
  // Weekday is zone-independent for a calendar date; derive it from the parts.
  const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
  return { year, month, day, hour, minute, second, weekday };
}

function offsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - ms;
}

/**
 * The inverse of {@link zonedParts}; an offset probe with one correction keeps it stable across
 * DST. A wall time skipped by a DST gap resolves forward by the gap's length, as RFC 5545 does
 * (02:30 on a spring-forward night is 03:30).
 */
export function makeInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone?: string,
): number {
  const tz = resolveTimeZone(timeZone);
  const utcGuess = Date.UTC(year, month, day, hour, minute, second);
  const offset = offsetMs(utcGuess, tz);
  let instant = utcGuess - offset;
  const offset2 = offsetMs(instant, tz);
  if (offset2 !== offset) instant = utcGuess - offset2;
  if (offsetMs(instant, tz) === utcGuess - instant) return instant;
  // In a gap: neither offset reads back as the requested wall time. Apply the offset in force
  // before the gap, which lands past it.
  const before = offsetMs(instant - GAP_PROBE_MS, tz);
  const forward = utcGuess - before;
  return forward > instant ? forward : instant;
}

export function startOfDay(ms: number, timeZone?: string): number {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(ms, tz);
  return makeInstant(p.year, p.month, p.day, 0, 0, 0, tz);
}

export const DEFAULT_DUE_HOUR = 23;
export const DEFAULT_DUE_MINUTE = 59;

export function endOfDay(ms: number, timeZone?: string): number {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(ms, tz);
  return makeInstant(p.year, p.month, p.day, DEFAULT_DUE_HOUR, DEFAULT_DUE_MINUTE, 0, tz);
}

export function dayKey(ms: number, timeZone?: string): string {
  const p = zonedParts(ms, timeZone);
  const mm = String(p.month + 1).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

export function dayOffset(due: number, now: number, timeZone?: string): number {
  const tz = resolveTimeZone(timeZone);
  return Math.round((startOfDay(due, tz) - startOfDay(now, tz)) / DAY_MS);
}

export function addDays(ms: number, n: number, timeZone?: string): number {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(ms, tz);
  return makeInstant(p.year, p.month, p.day + n, 0, 0, 0, tz);
}

// Keeps wall-clock time across a timezone change: a 9am task stays 9am.
export function shiftWallClockToZone(ms: number, fromZone: string, toZone: string): number {
  const p = zonedParts(ms, fromZone);
  return makeInstant(p.year, p.month, p.day, p.hour, p.minute, p.second, toZone);
}
