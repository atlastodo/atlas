import en from "./locales/en.json";
import { makeInstant, resolveTimeZone, zonedParts } from "./zonedTime";

/**
 * Task recurrence (asserted against `test-vectors/recurrence_vectors.json`).
 *
 * A compact RRULE subset, e.g. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`, plus non-standard
 * `MODE=COMPLETION` (next occurrence based on the completion time).
 *
 * A monthly rule keeps its day in `BYMONTHDAY` ({@link anchorMonthDay}): stepping from the previous
 * occurrence would turn "the 31st" into "the 28th" for good after one February. A yearly rule due
 * on a leap day keeps it the same way (`BYMONTHDAY=29`, the only day a yearly rule takes), so it
 * returns to Feb 29 in leap years.
 *
 * The engine ({@link nextOccurrenceCivil}) steps wall-clock dates and keeps the time of day, so
 * "every day at 23:59" does not drift across DST. Month and leap-day overflows clamp.
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";
export type RecurMode = "on_schedule" | "after_completion";

export interface Rule {
  freq: Freq;
  interval: number;
  byday: number[];
  // Day of month (1-31), clamped for shorter months. Ignored after completion, which re-anchors.
  bymonthday: number | null;
  mode: RecurMode;
  // Time of day (`BYHOUR`/`BYMINUTE`), kept only while an occurrence sits in a DST gap and so
  // shows a later time than the series' own ({@link advanceSeries}).
  at?: { hour: number; minute: number } | null;
}

const WEEKDAY_TOKENS: Record<string, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};
const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const MAX_INTERVAL = 1000;

// ASCII-only case folding and trimming, so a rule reads the same in every locale: `toUpperCase`
// folds "ı" to "I" and `trim` strips a BOM.
// A scan, not a `/^\s+|\s+$/` replace: the trailing alternative backtracks quadratically through a
// long whitespace run in the middle of a rule another member synced.
const isAsciiWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
function trimAscii(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isAsciiWs(s.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}
const upperAscii = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

export function parseRule(input: string): Rule | null {
  let freq: Freq | null = null;
  let interval = 1;
  const byday: number[] = [];
  let bymonthday: number | null = null;
  let byhour: number | null = null;
  let byminute: number | null = null;
  let mode: RecurMode = "on_schedule";

  for (const rawPart of input.split(";")) {
    const part = trimAscii(rawPart);
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) return null;
    const key = upperAscii(trimAscii(part.slice(0, eq)));
    const value = upperAscii(trimAscii(part.slice(eq + 1)));
    switch (key) {
      case "FREQ": {
        if (value === "DAILY") freq = "daily";
        else if (value === "WEEKLY") freq = "weekly";
        else if (value === "MONTHLY") freq = "monthly";
        else if (value === "YEARLY") freq = "yearly";
        else return null;
        break;
      }
      case "INTERVAL": {
        if (!/^[0-9]+$/.test(value)) return null;
        const n = Number(value);
        if (n < 1 || n > MAX_INTERVAL) return null;
        interval = n;
        break;
      }
      case "BYDAY": {
        for (const tokRaw of value.split(",")) {
          const tok = trimAscii(tokRaw);
          if (!tok) continue;
          if (!Object.prototype.hasOwnProperty.call(WEEKDAY_TOKENS, tok)) return null;
          byday.push(WEEKDAY_TOKENS[tok]!);
        }
        break;
      }
      case "BYMONTHDAY": {
        // One positive day: RFC 5545's lists and negative days are not supported.
        if (!/^[0-9]+$/.test(value)) return null;
        const n = Number(value);
        if (n < 1 || n > 31) return null;
        bymonthday = n;
        break;
      }
      case "BYHOUR":
      case "BYMINUTE": {
        // One value each, as written by advanceSeries.
        if (!/^[0-9]{1,2}$/.test(value)) return null;
        const n = Number(value);
        if (n > (key === "BYHOUR" ? 23 : 59)) return null;
        if (key === "BYHOUR") byhour = n;
        else byminute = n;
        break;
      }
      case "MODE": {
        if (value === "SCHEDULE") mode = "on_schedule";
        else if (value === "COMPLETION") mode = "after_completion";
        else return null;
        break;
      }
      default:
        return null;
    }
  }

  if (freq === null) return null;
  // Every other frequency gives BYMONTHDAY a meaning this engine does not implement; refusing beats
  // silently repeating on other days.
  if (bymonthday !== null && freq !== "monthly" && !(freq === "yearly" && bymonthday === 29)) {
    return null;
  }
  if ((byhour === null) !== (byminute === null)) return null;
  const uniqueSorted = [...new Set(byday)].sort((a, b) => a - b);
  const rule: Rule = { freq, interval, byday: uniqueSorted, bymonthday, mode };
  if (byhour !== null && byminute !== null) rule.at = { hour: byhour, minute: byminute };
  return rule;
}

export function ruleToString(rule: Rule): string {
  const parts = [`FREQ=${rule.freq.toUpperCase()}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === "weekly" && rule.byday.length > 0) {
    const days = rule.byday.map((d) => Object.keys(WEEKDAY_TOKENS)[d]).join(",");
    parts.push(`BYDAY=${days}`);
  }
  if (monthDayApplies(rule)) parts.push(`BYMONTHDAY=${rule.bymonthday}`);
  if (rule.at) parts.push(`BYHOUR=${rule.at.hour}`, `BYMINUTE=${rule.at.minute}`);
  if (rule.mode === "after_completion") parts.push("MODE=COMPLETION");
  return parts.join(";");
}

function monthDayApplies(rule: Rule): rule is Rule & { bymonthday: number } {
  return (
    (rule.freq === "monthly" || rule.freq === "yearly") &&
    rule.mode === "on_schedule" &&
    rule.bymonthday !== null
  );
}

// A monthly rule on schedule gets the due date's day as `BYMONTHDAY`; an existing day is kept when it clamps to that date (31 on Feb 28).
// A time of day the due date does not show (a manual reschedule) is dropped too.
export function anchorMonthDay(rule: string, dueMs: number, timeZone?: string): string {
  return withMonthDay(withTimeFitting(rule, dueMs, timeZone), dueMs, timeZone, false);
}

// `rule` without its time of day unless that time resolves to `dueMs` on the due date.
function withTimeFitting(rule: string, dueMs: number, timeZone: string | undefined): string {
  const parsed = parseRule(rule);
  if (!parsed?.at) return rule;
  if (Math.abs(dueMs) <= MAX_DATE_MS) {
    const tz = resolveTimeZone(timeZone);
    const p = zonedParts(dueMs, tz);
    const { hour, minute } = parsed.at;
    const at = makeInstant(p.year, p.month, p.day, hour, minute, p.second, tz);
    if (at + modEuclid(dueMs, 1000) === dueMs) return rule;
  }
  return ruleToString({ ...parsed, at: null });
}

// For rules stored before `BYMONTHDAY` existed. A series already shortened by a February stays shortened.
export function pinMonthDay(rule: string, dueMs: number, timeZone?: string): string {
  return withMonthDay(rule, dueMs, timeZone, true);
}

function withMonthDay(
  rule: string,
  dueMs: number,
  timeZone: string | undefined,
  onlyIfMissing: boolean,
): string {
  const parsed = parseRule(rule);
  if (!parsed || parsed.mode !== "on_schedule") return rule;
  if (parsed.freq !== "monthly" && parsed.freq !== "yearly") return rule;
  if (!(Math.abs(dueMs) <= MAX_DATE_MS)) return rule;
  if (onlyIfMissing && parsed.bymonthday !== null) return rule;
  const p = zonedParts(dueMs, resolveTimeZone(timeZone));
  const lastDay = daysInMonth(p.year, p.month + 1);
  if (parsed.bymonthday !== null && Math.min(parsed.bymonthday, lastDay) === p.day) return rule;
  if (parsed.freq === "yearly") {
    // Only a leap day needs keeping; any other date repeats as is.
    const bymonthday = p.month === 1 && p.day === 29 ? 29 : null;
    return bymonthday === parsed.bymonthday ? rule : ruleToString({ ...parsed, bymonthday });
  }
  return ruleToString({ ...parsed, bymonthday: p.day });
}

export type Translate = (key: string, params: Record<string, string | number>) => string;

// Without a translator the summary reads the English catalog, so the copy has one source.
const english: Translate = (key, params) => {
  const table: Record<string, string> = en.recurrence.summary;
  const name = key.slice("recurrence.summary.".length);
  const plural = `${name}_${params.count === 1 ? "one" : "other"}`;
  const template = table[name] ?? table[plural] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, p: string) => String(params[p] ?? ""));
};

// A summary like "Every 2 weeks on Mon, Wed", in the language of `t`.
export function formatRule(input: string, t: Translate = english): string | null {
  const rule = parseRule(input);
  if (!rule) return null;
  const key = (name: string) => `recurrence.summary.${name}`;
  let summary = t(key(rule.freq), { count: rule.interval });
  if (rule.freq === "weekly" && rule.byday.length > 0) {
    const days = rule.byday.map((d) => t(key(WEEKDAY_KEYS[d]!), {})).join(", ");
    summary = t(key("onWeekdays"), { rule: summary, days });
  }
  if (monthDayApplies(rule) && rule.freq === "monthly")
    summary = t(key("onMonthDay"), { rule: summary, day: rule.bymonthday });
  if (rule.mode === "after_completion") summary = t(key("afterCompletion"), { rule: summary });
  return summary;
}

export interface CivilDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function idiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = idiv(yy >= 0 ? yy : yy - 399, 400);
  const yoe = yy - era * 400;
  const doy = idiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): [number, number, number] {
  const zz = z + 719468;
  const era = idiv(zz >= 0 ? zz : zz - 146096, 146097);
  const doe = zz - era * 146097;
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100));
  const mp = idiv(5 * doy + 2, 153);
  const d = doy - idiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function daysInMonth(y: number, m: number): number {
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return daysFromCivil(ny, nm, 1) - daysFromCivil(y, m, 1);
}

function weekdayMon0(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

function modEuclid(a: number, b: number): number {
  return ((a % b) + b) % b;
}

// Lands on `monthDay` (default: the same day), clamped to the target month's last day.
function addMonths(day: number, months: number, monthDay: number | null = null): number {
  const [y, m, d] = civilFromDays(day);
  const total = m - 1 + months;
  const ny = y + idiv(total, 12);
  const nm = modEuclid(total, 12) + 1;
  const nd = Math.min(monthDay ?? d, daysInMonth(ny, nm));
  return daysFromCivil(ny, nm, nd);
}

const isInt = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

// Civil years are bounded to 32 bits, so out-of-range dates are refused rather than misread.
const MIN_YEAR = -(2 ** 31);
const MAX_YEAR = 2 ** 31 - 1;

const MAX_DATE_MS = 8.64e15;

function dateToDays(date: CivilDate): number | null {
  const { year, month, day } = date;
  if (!isInt(year, MIN_YEAR, MAX_YEAR) || !isInt(month, 1, 12)) return null;
  if (!isInt(day, 1, daysInMonth(year, month))) return null;
  return daysFromCivil(year, month, day);
}

// `anchor` is the current due date; `from` is the `MODE=COMPLETION` reference day. `null` for an invalid rule or date.
export function nextOccurrenceCivil(
  rule: string,
  anchor: CivilDateTime,
  from: CivilDate,
): CivilDateTime | null {
  const parsed = parseRule(rule);
  if (!parsed) return null;
  const { second, millisecond } = anchor;
  const { hour, minute } = parsed.at ?? anchor;
  if (!isInt(hour, 0, 23) || !isInt(minute, 0, 59) || !isInt(second, 0, 59)) return null;
  if (!isInt(millisecond, 0, 999)) return null;
  const anchorDay = dateToDays(anchor);
  if (anchorDay === null) return null;
  // Day to advance from: the due date on schedule, the completion day after completion.
  const base = parsed.mode === "on_schedule" ? anchorDay : dateToDays(from);
  if (base === null) return null;
  const interval = parsed.interval;

  let next: number;
  switch (parsed.freq) {
    case "daily":
      next = base + interval;
      break;
    case "weekly":
      next =
        parsed.byday.length === 0
          ? base + interval * 7
          : nextByday(parsed.byday, interval, anchorDay, base);
      break;
    case "monthly":
      // On schedule `base` is the due date, so BYMONTHDAY moves the series back onto its day even
      // after a short month or one-off reschedule.
      next = addMonths(base, interval, monthDayApplies(parsed) ? parsed.bymonthday : null);
      break;
    case "yearly": {
      // BYMONTHDAY=29 is the leap day, so it applies only from a February due date.
      const inFebruary = civilFromDays(base)[1] === 2;
      next = addMonths(
        base,
        interval * 12,
        monthDayApplies(parsed) && inFebruary ? parsed.bymonthday : null,
      );
      break;
    }
  }
  const [year, month, day] = civilFromDays(next);
  if (!isInt(year, MIN_YEAR, MAX_YEAR)) return null;
  return { year, month, day, hour, minute, second, millisecond };
}

/**
 * The occurrence after `dueMs` and the rule to store with it (also given the leap-day and month-day
 * anchors of {@link pinMonthDay}). When the next occurrence falls in a DST gap it shows a later
 * time than the series' own, so the rule keeps the series' time (`BYHOUR`/`BYMINUTE`) to step from;
 * the first occurrence that shows it again drops it. `null` when there is no next occurrence.
 */
export function advanceSeries(
  rule: string,
  dueMs: number,
  fromMs: number,
  timeZone?: string,
): { next: number; rule: string } | null {
  const tz = resolveTimeZone(timeZone);
  const pinned = pinMonthDay(rule, dueMs, tz);
  const next = nextOccurrence(pinned, dueMs, fromMs, tz);
  const parsed = parseRule(pinned);
  if (next == null || !parsed) return null;
  const due = zonedParts(dueMs, tz);
  const want = parsed.at ?? { hour: due.hour, minute: due.minute };
  const shown = zonedParts(next, tz);
  const at = shown.hour === want.hour && shown.minute === want.minute ? null : want;
  const sameAt = parsed.at?.hour === at?.hour && parsed.at?.minute === at?.minute;
  return { next, rule: sameAt ? pinned : ruleToString({ ...parsed, at }) };
}

// {@link nextOccurrenceCivil} for Unix-ms instants, read as wall-clock time in `timeZone`.
export function nextOccurrence(
  rule: string,
  anchorMs: number,
  fromMs: number,
  timeZone?: string,
): number | null {
  if (!(Math.abs(anchorMs) <= MAX_DATE_MS) || !(Math.abs(fromMs) <= MAX_DATE_MS)) return null;
  const tz = resolveTimeZone(timeZone);
  const a = zonedParts(anchorMs, tz);
  const f = zonedParts(fromMs, tz);
  const next = nextOccurrenceCivil(
    rule,
    {
      year: a.year,
      month: a.month + 1,
      day: a.day,
      hour: a.hour,
      minute: a.minute,
      second: a.second,
      // zonedParts stops at seconds; no zone offset has a sub-second part, so it carries over.
      millisecond: modEuclid(anchorMs, 1000),
    },
    { year: f.year, month: f.month + 1, day: f.day },
  );
  if (!next) return null;
  const { year, month, day, hour, minute, second, millisecond } = next;
  const ms = makeInstant(year, month - 1, day, hour, minute, second, tz) + millisecond;
  return Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

// First rule weekday after `base` in a week that is a multiple of `interval` from the anchor's (Monday-start) week.
function nextByday(byday: number[], interval: number, anchorDay: number, base: number): number {
  const refWeek = anchorDay - weekdayMon0(anchorDay);
  const start = base + 1;
  const startWd = weekdayMon0(start);
  const week = idiv(start - startWd - refWeek, 7); // weeks from the anchor's week to start's
  if (week >= 0 && week % interval === 0) {
    const wd = byday.find((d) => d >= startWd);
    if (wd !== undefined) return start - startWd + wd;
  }
  // Otherwise the first rule weekday of the next series week (the anchor's own week at the
  // earliest).
  const nextWeek = week < 0 ? 0 : (idiv(week, interval) + 1) * interval;
  return refWeek + nextWeek * 7 + byday[0]!;
}
