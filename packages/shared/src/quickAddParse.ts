import type { CreateTaskInput, Priority } from "@atlas/client-core";
import {
  DEFAULT_DUE_HOUR,
  DEFAULT_DUE_MINUTE,
  addDays,
  endOfDay,
  makeInstant,
  resolveTimeZone,
  startOfDay,
  zonedParts,
} from "./zonedTime";
import { fold, quickAddLexicons, type QuickAddLexicon } from "./quickAddLexicons";
import {
  anchorMonthDay,
  formatRule,
  parseRule,
  ruleToString,
  type Freq,
  type Rule,
} from "./recurrence";

/**
 * Natural-language quick-add parsing ("Buy milk tomorrow 5pm #groceries p1") into a
 * {@link CreateTaskInput} plus preview chips. `every!` or a trailing `from completion` schedules
 * from the completion date. Never throws: unrecognized input stays in the title.
 */

export { DEFAULT_DUE_HOUR, DEFAULT_DUE_MINUTE };

export type ChipKind = "due" | "project" | "label" | "priority" | "recurrence";

export interface ParsedChip {
  kind: ChipKind;
  label: string;
}

export interface TokenSpan {
  start: number;
  end: number;
  text: string;
  value: string;
}

export interface QuickAddContext {
  projectIdByName?: (name: string) => string | null;
  isKnownLabel?: (name: string) => boolean;
  timeZone?: string;
  language?: string;
  // Phrases (lowercase) the user unlinked: kept as title text, so "call fri" can mean the person.
  ignoreDates?: string[];
  ignoreProjects?: string[];
  ignoreLabels?: string[];
  // "Disable smart dates": date/time phrases stay in the title.
  disableDates?: boolean;
}

export interface DateMatchSpan {
  start: number;
  end: number;
  text: string;
}

export interface QuickAddResult {
  input: CreateTaskInput;
  title: string;
  chips: ParsedChip[];
  dateMatch?: DateMatchSpan;
  projectMatch?: TokenSpan;
  labelMatches?: TokenSpan[];
  labels: string[];
}

function daysUntilWeekday(weekday: number, now: number, timeZone?: string): number {
  const today = zonedParts(now, timeZone).weekday;
  return (weekday - today + 7) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// This year, or next once passed; `null` for a nonexistent date ("feb 30").
function monthDayDay(month: number, day: number, now: number, timeZone?: string): number | null {
  const today = startOfDay(now, timeZone);
  if (day < 1) return null;
  const year = zonedParts(now, timeZone).year;
  for (const y of [year, year + 1]) {
    if (day > daysInMonth(y, month)) continue;
    const dt = makeInstant(y, month, day, 0, 0, 0, timeZone);
    if (dt >= today) return dt;
  }
  return null;
}

function atMinutes(dayMs: number, minutes: number, timeZone?: string): number {
  const p = zonedParts(dayMs, timeZone);
  return makeInstant(p.year, p.month, p.day, Math.floor(minutes / 60), minutes % 60, 0, timeZone);
}

// A rule with no typed date starts on the next of its BYDAY weekdays (today counts); others start today.
function firstRuleDay(rule: string, now: number, timeZone?: string): number {
  const today = startOfDay(now, timeZone);
  const parsed = parseRule(rule);
  if (!parsed || parsed.freq !== "weekly" || parsed.byday.length === 0) return today;
  const todayMon0 = (zonedParts(now, timeZone).weekday + 6) % 7;
  const delta = Math.min(...parsed.byday.map((d) => (d - todayMon0 + 7) % 7));
  return addDays(today, delta, timeZone);
}

function addMonthsZoned(dayStart: number, n: number, timeZone?: string): number {
  const p = zonedParts(dayStart, timeZone);
  const targetMonth = p.month + n;
  const lastDay = new Date(Date.UTC(p.year, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(p.day, lastDay);
  return makeInstant(p.year, targetMonth, day, 0, 0, 0, timeZone);
}

interface Match {
  consumed: number;
}
interface RecurrenceMatch extends Match {
  rule: string;
}
interface DateMatch extends Match {
  day: number;
}
interface TimeMatch extends Match {
  time: number;
}

/** Strip the trailing punctuation a weekday, month or count may carry: "fre.", "okt.", "2.". */
const bare = (word: string) => word.replace(/[.,]+$/, "");

/**
 * How many words of `phrase` (folded, space-separated) start at `words[i]`, or 0. The last word
 * may carry trailing punctuation ("demain," / "kl.").
 */
function phraseAt(words: string[], i: number, phrase: string): number {
  const parts = phrase.split(" ");
  for (let k = 0; k < parts.length; k++) {
    const w = words[i + k];
    if (w === undefined) return 0;
    if (w !== parts[k] && bare(w) !== parts[k]) return 0;
  }
  return parts.length;
}

/** The longest of `phrases` starting at `words[i]`: its word count, or 0. */
function anyAt(words: string[], i: number, phrases: string[]): number {
  let best = 0;
  for (const p of phrases) best = Math.max(best, phraseAt(words, i, p));
  return best;
}

/** The longest key of `map` starting at `words[i]`, with its value. */
function keyAt<T>(
  words: string[],
  i: number,
  map: Record<string, T>,
): { value: T; consumed: number } | null {
  let found: { value: T; consumed: number } | null = null;
  for (const [phrase, value] of Object.entries(map)) {
    const n = phraseAt(words, i, phrase);
    if (n > (found?.consumed ?? 0)) found = { value, consumed: n };
  }
  return found;
}

/** A count: "3" or "3." (Danish "hver 2. uge"), or the lexicon's word for one. */
function countAt(words: string[], i: number, lex: QuickAddLexicon): number | null {
  const w = words[i];
  if (w === undefined) return null;
  const m = /^(\d+)\.?$/.exec(w);
  if (m) return Number(m[1]);
  return lex.one.includes(w) ? 1 : null;
}

/** A day of the month: "3", "3.", "3rd", "1er", "1º". */
function dayNumberAt(words: string[], i: number): number | null {
  const m = /^(\d{1,2})(?:st|nd|rd|th|er|º|ª|°|\.)*,?$/.exec(words[i] ?? "");
  return m ? Number(m[1]) : null;
}

function matchRecurrence(words: string[], i: number, lex: QuickAddLexicon): RecurrenceMatch | null {
  // `every!` (or the language's own word with a "!") schedules from completion.
  const head = words[i]!;
  const afterCompletion = head.endsWith("!") && head.length > 1;
  const view = afterCompletion
    ? [...words.slice(0, i), head.slice(0, -1), ...words.slice(i + 1)]
    : words;

  let rule: Rule | null = null;
  let consumed = 0;
  const mode = afterCompletion ? "after_completion" : "on_schedule";

  const single = afterCompletion ? null : keyAt(view, i, lex.single);
  if (single) {
    rule = { freq: single.value, interval: 1, byday: [], bymonthday: null, mode };
    consumed = single.consumed;
  } else {
    const every = anyAt(view, i, lex.every);
    if (!every) return null;
    const j = i + every;
    const wd = keyAt(view, j, lex.weekdays);
    const unit = keyAt(view, j, lex.units);
    if (wd) {
      // "every monday" / "hver mandag" / "tous les lundis"
      rule = { freq: "weekly", interval: 1, byday: [(wd.value + 6) % 7], bymonthday: null, mode };
      consumed = every + wd.consumed;
    } else if (unit) {
      // "every week" / "jede Woche"
      rule = { freq: unit.value, interval: 1, byday: [], bymonthday: null, mode };
      consumed = every + unit.consumed;
    } else {
      // "every 2 weeks" / "hver 2. uge" / "alle 2 Wochen"
      const n = countAt(view, j, lex);
      const unit2 = n !== null ? keyAt(view, j + 1, lex.units) : null;
      if (n === null || !unit2) return null;
      rule = { freq: unit2.value, interval: Math.max(1, n), byday: [], bymonthday: null, mode };
      consumed = every + 1 + unit2.consumed;
    }
  }

  // A trailing "from completion" / "fra fuldførelse" is the plain-words `every!`.
  const from = anyAt(view, i + consumed, lex.fromCompletion);
  if (from) {
    rule = { ...rule, mode: "after_completion" };
    consumed += from;
  }
  return { rule: ruleToString(rule), consumed };
}

/** A date at `words[i]` with no lead-in word. */
function matchDateCore(
  words: string[],
  i: number,
  now: number,
  timeZone: string | undefined,
  lex: QuickAddLexicon,
): DateMatch | null {
  const today = startOfDay(now, timeZone);
  const weekdayDay = (wd: number, next: boolean) => {
    let delta = daysUntilWeekday(wd, now, timeZone);
    if (next && delta === 0) delta = 7; // "next <today's weekday>" = a week out
    return addDays(today, delta, timeZone);
  };
  const unitDay = (freq: Freq, n: number): number | null => {
    if (freq === "daily") return addDays(today, n, timeZone);
    if (freq === "weekly") return addDays(today, n * 7, timeZone);
    if (freq === "monthly") return addMonthsZoned(today, n, timeZone);
    return addMonthsZoned(today, n * 12, timeZone);
  };

  // "tomorrow" / "i morgen" / "pasado mañana"
  const rel = keyAt(words, i, lex.relativeDays);
  if (rel) return { day: addDays(today, rel.value, timeZone), consumed: rel.consumed };

  // "in 3 days" / "om 3 dage" / "dans 3 jours" / "in einer Woche" / "za tydzień"
  const inP = anyAt(words, i, lex.inPrefixes);
  if (inP) {
    const n = countAt(words, i + inP, lex);
    const unit = n !== null ? keyAt(words, i + inP + 1, lex.units) : null;
    if (n !== null && unit) {
      return { day: unitDay(unit.value, n)!, consumed: inP + 1 + unit.consumed };
    }
    const bareUnit = lex.inBareUnit ? keyAt(words, i + inP, lex.units) : null;
    if (bareUnit) return { day: unitDay(bareUnit.value, 1)!, consumed: inP + bareUnit.consumed };
  }

  // "next monday" / "næste tirsdag" / "this friday" / "next week"
  const nextP = anyAt(words, i, lex.nextPrefixes);
  const thisP = nextP ? 0 : anyAt(words, i, lex.thisPrefixes);
  if (nextP || thisP) {
    const j = i + (nextP || thisP);
    const wd = keyAt(words, j, lex.weekdays);
    if (wd) return { day: weekdayDay(wd.value, nextP > 0), consumed: j - i + wd.consumed };
    const unit = keyAt(words, j, lex.units);
    if (unit && unit.value !== "daily") {
      return { day: unitDay(unit.value, 1)!, consumed: j - i + unit.consumed };
    }
  }

  // Weekday, or "lundi prochain"; unit then "prochaine": "la semaine prochaine".
  const wd = keyAt(words, i, lex.weekdays);
  if (wd) {
    const next = anyAt(words, i + wd.consumed, lex.nextSuffixes);
    return { day: weekdayDay(wd.value, next > 0), consumed: wd.consumed + next };
  }
  const unit = keyAt(words, i, lex.units);
  if (unit && unit.value !== "daily") {
    const next = anyAt(words, i + unit.consumed, lex.nextSuffixes);
    if (next) return { day: unitDay(unit.value, 1)!, consumed: unit.consumed + next };
  }

  // Month then day: "jun 3" / "june 3rd" / "marts 15."
  if (lex.monthFirst) {
    const mon = keyAt(words, i, lex.months);
    const d = mon ? dayNumberAt(words, i + mon.consumed) : null;
    if (mon && d !== null) {
      const dt = monthDayDay(mon.value, d, now, timeZone);
      if (dt !== null) return { day: dt, consumed: mon.consumed + 1 };
    }
  }

  // Day then month: "3. juni" / "15 marts" / "3rd of june" / "3 de marzo" / "1er mars"
  const d = dayNumberAt(words, i);
  if (d !== null) {
    const conn = anyAt(words, i + 1, lex.monthConnectors);
    const mon =
      keyAt(words, i + 1 + conn, lex.months) ?? (conn ? keyAt(words, i + 1, lex.months) : null);
    if (mon) {
      const used = keyAt(words, i + 1 + conn, lex.months) ? conn : 0;
      const dt = monthDayDay(mon.value, d, now, timeZone);
      if (dt !== null) return { day: dt, consumed: 1 + used + mon.consumed };
    }
  }

  return null;
}

/** A date, optionally behind a lead-in word that only counts when a date follows ("am Montag"). */
function matchDate(
  words: string[],
  i: number,
  now: number,
  timeZone: string | undefined,
  lex: QuickAddLexicon,
): DateMatch | null {
  const lead = anyAt(words, i, lex.leadIns);
  if (lead) {
    const after = matchDateCore(words, i + lead, now, timeZone, lex);
    if (after) return { day: after.day, consumed: lead + after.consumed };
  }
  return matchDateCore(words, i, now, timeZone, lex);
}

/** "17", "17:30", "9.30" as minutes after midnight; null when out of range. */
function clock(h: string, m: string | undefined): number | null {
  const hour = Number(h);
  const min = m ? Number(m) : 0;
  return hour <= 23 && min <= 59 ? hour * 60 + min : null;
}

/** A self-contained time token, in any language: "5pm", "9:30am", "17:00", "9.30". */
function numericTime(word: string): number | null {
  const ampm = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(word);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = ampm[2] ? Number(ampm[2]) : 0;
    if (h > 12 || m > 59) return null;
    if (ampm[3] === "pm" && h !== 12) h += 12;
    if (ampm[3] === "am" && h === 12) h = 0;
    return h * 60 + m;
  }
  const h24 = /^(\d{1,2})[:.](\d{2})$/.exec(word);
  return h24 ? clock(h24[1]!, h24[2]) : null;
}

/**
 * A time starting at `words[i]` that needs no prefix: a numeric token, the hour glued to the
 * language's letter ("17h30", "17u"), or an hour before its suffix word ("17 Uhr").
 */
function timeTokenAt(words: string[], i: number, lex: QuickAddLexicon): TimeMatch | null {
  const w = words[i];
  if (w === undefined) return null;
  const suffix = (j: number) => anyAt(words, j, lex.timeSuffixes);
  const numeric = numericTime(bare(w)) ?? numericTime(w);
  if (numeric !== null) return { time: numeric, consumed: 1 + suffix(i + 1) };
  if (lex.hourLetter) {
    const m = new RegExp(`^(\\d{1,2})${lex.hourLetter}(\\d{2})?$`).exec(bare(w));
    const t = m ? clock(m[1]!, m[2]) : null;
    if (t !== null) return { time: t, consumed: 1 };
  }
  const hour = /^(\d{1,2})$/.exec(w);
  if (hour && suffix(i + 1)) {
    const t = clock(hour[1]!, undefined);
    if (t !== null) return { time: t, consumed: 1 + suffix(i + 1) };
  }
  return null;
}

function matchTime(words: string[], i: number, lex: QuickAddLexicon): TimeMatch | null {
  const noon = anyAt(words, i, lex.noon);
  if (noon) return { time: 12 * 60, consumed: noon };
  const midnight = anyAt(words, i, lex.midnight);
  if (midnight) return { time: 0, consumed: midnight };

  // "at 5pm" / "kl 17" / "um 17 Uhr" / "a las 9" / "à 17h30"
  for (const [prefix, bareHour] of Object.entries(lex.timePrefixes)) {
    const p = phraseAt(words, i, prefix);
    if (!p) continue;
    const j = i + p;
    const word = anyAt(words, j, [...lex.noon, ...lex.midnight]);
    if (word) return { time: anyAt(words, j, lex.noon) ? 12 * 60 : 0, consumed: p + word };
    const token = timeTokenAt(words, j, lex);
    if (token) return { time: token.time, consumed: p + token.consumed };
    const hour = bareHour ? /^(\d{1,2})$/.exec(words[j] ?? "") : null;
    const t = hour ? clock(hour[1]!, undefined) : null;
    if (t !== null) return { time: t, consumed: p + 1 };
  }

  // Danish "kl17", "kl.17:00"
  for (const prefix of lex.gluedTimePrefixes ?? []) {
    const w = words[i]!;
    if (!w.startsWith(prefix)) continue;
    const m = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(w.slice(prefix.length));
    const t = m ? clock(m[1]!, m[2]) : null;
    if (t !== null) return { time: t, consumed: 1 };
  }

  return timeTokenAt(words, i, lex);
}

/** The first lexicon (UI language, then English) that matches at `words[i]`. */
function firstOf<T>(
  lexicons: QuickAddLexicon[],
  match: (lex: QuickAddLexicon) => T | null,
): T | null {
  for (const lex of lexicons) {
    const found = match(lex);
    if (found) return found;
  }
  return null;
}

function formatDueChip(
  dueAt: number,
  withTime: boolean,
  timeZone?: string,
  language?: string,
): string {
  const d = new Date(dueAt);
  // Resolve "" (the "device" preference) to a real zone: `Intl` throws a RangeError on "".
  const tz = resolveTimeZone(timeZone);
  const locale = language && language.length >= 2 ? language : undefined;
  const date = d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: tz });
  if (!withTime) return date;
  const time = d.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
  return `${date}, ${time}`;
}

export function parseQuickAdd(
  text: string,
  now: number,
  ctx: QuickAddContext = {},
): QuickAddResult {
  const tz = ctx.timeZone;
  const lexicons = quickAddLexicons(ctx.language);
  const tokens = [...text.matchAll(/\S+/g)];
  const words = tokens.map((m) => m[0]);
  const wordStarts = tokens.map((m) => m.index ?? 0);
  const lower = words.map((w) => w.toLowerCase());
  // Accent-insensitive copies for the lexicons ("manana", "lunedi").
  const folded = words.map(fold);

  let priority: Priority | undefined;
  let projectName: string | undefined;
  let resolvedProjectId: string | undefined;
  let projectTokenSpan: TokenSpan | undefined;
  let projectMatch: TokenSpan | undefined;
  const labels: string[] = [];
  const labelTokenSpans: TokenSpan[] = [];
  const labelMatches: TokenSpan[] = [];
  let recurrence: string | undefined;
  let dueDay: number | undefined;
  let dueTime: number | null = null;
  // Whether the user typed a time (vs. the 23:59 default); an all-day due shows the date only.
  let explicitTime = false;
  let dateMatch: DateMatchSpan | undefined;
  const titleWords: string[] = [];

  interface MatchedDateInfo {
    startWord: number;
    consumed: number;
    day: number;
    phrase: string;
    span: { start: number; end: number };
  }
  interface MatchedTimeInfo {
    startWord: number;
    consumed: number;
    time: number;
    phrase: string;
    span: { start: number; end: number };
  }

  let matchedDate: MatchedDateInfo | undefined;
  let matchedTime: MatchedTimeInfo | undefined;
  const consumedWords = new Set<number>();

  for (let i = 0; i < words.length;) {
    const w = words[i]!;
    const lw = lower[i]!;

    if (/^p[1-4]$/.test(lw)) {
      priority = Number(lw[1]) as Priority;
      consumedWords.add(i);
      i += 1;
      continue;
    }
    if (w.startsWith("#") && w.length > 1) {
      const name = w.slice(1);
      const isUnlinked =
        ctx.ignoreProjects?.includes(w.toLowerCase()) ||
        ctx.ignoreProjects?.includes(name.toLowerCase()) ||
        ctx.ignoreProjects?.includes(w) ||
        ctx.ignoreProjects?.includes(name);
      if (!isUnlinked) {
        const resolvedId = ctx.projectIdByName ? ctx.projectIdByName(name) : undefined;
        if (ctx.projectIdByName === undefined || resolvedId) {
          projectName = name;
          projectTokenSpan = {
            start: wordStarts[i]!,
            end: wordStarts[i]! + w.length,
            text: w,
            value: projectName,
          };
          consumedWords.add(i);
          if (resolvedId) {
            resolvedProjectId = resolvedId;
            projectMatch = projectTokenSpan;
          } else if (ctx.projectIdByName === undefined) {
            projectMatch = projectTokenSpan;
          }
        }
      }
      i += 1;
      continue;
    }
    if (w.startsWith("@") && w.length > 1) {
      const labelName = w.slice(1);
      const isUnlinked =
        ctx.ignoreLabels?.includes(w.toLowerCase()) ||
        ctx.ignoreLabels?.includes(labelName.toLowerCase()) ||
        ctx.ignoreLabels?.includes(w) ||
        ctx.ignoreLabels?.includes(labelName);
      if (!isUnlinked) {
        const isKnown = ctx.isKnownLabel ? ctx.isKnownLabel(labelName) : true;
        if (isKnown) {
          labels.push(labelName);
          const span: TokenSpan = {
            start: wordStarts[i]!,
            end: wordStarts[i]! + w.length,
            text: w,
            value: labelName,
          };
          labelTokenSpans.push(span);
          labelMatches.push(span);
          consumedWords.add(i);
        }
      }
      i += 1;
      continue;
    }

    const rec = firstOf(lexicons, (lex) => matchRecurrence(folded, i, lex));
    if (rec) {
      recurrence = rec.rule;
      for (let k = 0; k < rec.consumed; k++) consumedWords.add(i + k);
      i += rec.consumed;
      continue;
    }
    const date = ctx.disableDates
      ? null
      : firstOf(lexicons, (lex) => matchDate(folded, i, now, tz, lex));
    if (date && !matchedDate) {
      const phrase = lower.slice(i, i + date.consumed).join(" ");
      const last = i + date.consumed - 1;
      const span = { start: wordStarts[i]!, end: wordStarts[last]! + words[last]!.length };
      matchedDate = {
        startWord: i,
        consumed: date.consumed,
        day: date.day,
        phrase,
        span,
      };
      i += date.consumed;
      continue;
    }
    const time = ctx.disableDates ? null : firstOf(lexicons, (lex) => matchTime(folded, i, lex));
    if (time !== null && !matchedTime) {
      const phrase = lower.slice(i, i + time.consumed).join(" ");
      const last = i + time.consumed - 1;
      const span = { start: wordStarts[i]!, end: wordStarts[last]! + words[last]!.length };
      matchedTime = {
        startWord: i,
        consumed: time.consumed,
        time: time.time,
        phrase,
        span,
      };
      i += time.consumed;
      continue;
    }

    i += 1;
  }

  if (matchedDate && matchedTime) {
    const isAdjacent =
      matchedDate.startWord + matchedDate.consumed === matchedTime.startWord ||
      matchedTime.startWord + matchedTime.consumed === matchedDate.startWord;

    if (isAdjacent) {
      const compStart = Math.min(matchedDate.span.start, matchedTime.span.start);
      const compEnd = Math.max(matchedDate.span.end, matchedTime.span.end);
      const compPhrase = text.slice(compStart, compEnd).toLowerCase().trim();
      const isUnlinked =
        ctx.ignoreDates?.includes(compPhrase) ||
        ctx.ignoreDates?.includes(matchedDate.phrase) ||
        ctx.ignoreDates?.includes(matchedTime.phrase);

      if (!isUnlinked) {
        dueDay = matchedDate.day;
        dueTime = matchedTime.time;
        explicitTime = true;
        dateMatch = { start: compStart, end: compEnd, text: compPhrase };
        for (let k = 0; k < matchedDate.consumed; k++) consumedWords.add(matchedDate.startWord + k);
        for (let k = 0; k < matchedTime.consumed; k++) consumedWords.add(matchedTime.startWord + k);
      }
    } else {
      const dateUnlinked = ctx.ignoreDates?.includes(matchedDate.phrase);
      const timeUnlinked = ctx.ignoreDates?.includes(matchedTime.phrase);

      if (!dateUnlinked) {
        dueDay = matchedDate.day;
        for (let k = 0; k < matchedDate.consumed; k++) consumedWords.add(matchedDate.startWord + k);
      }
      if (!timeUnlinked) {
        dueTime = matchedTime.time;
        explicitTime = true;
        for (let k = 0; k < matchedTime.consumed; k++) consumedWords.add(matchedTime.startWord + k);
      }
      if (!dateUnlinked) {
        dateMatch = {
          start: matchedDate.span.start,
          end: matchedDate.span.end,
          text: matchedDate.phrase,
        };
      } else if (!timeUnlinked) {
        dateMatch = {
          start: matchedTime.span.start,
          end: matchedTime.span.end,
          text: matchedTime.phrase,
        };
      }
    }
  } else if (matchedDate) {
    const isUnlinked = ctx.ignoreDates?.includes(matchedDate.phrase);
    if (!isUnlinked) {
      // Date without an explicit time = an all-day (23:59) due; the instant is built below.
      dueDay = matchedDate.day;
      dateMatch = {
        start: matchedDate.span.start,
        end: matchedDate.span.end,
        text: matchedDate.phrase,
      };
      for (let k = 0; k < matchedDate.consumed; k++) consumedWords.add(matchedDate.startWord + k);
    }
  } else if (matchedTime) {
    const isUnlinked = ctx.ignoreDates?.includes(matchedTime.phrase);
    if (!isUnlinked) {
      dueTime = matchedTime.time;
      explicitTime = true;
      dateMatch = {
        start: matchedTime.span.start,
        end: matchedTime.span.end,
        text: matchedTime.phrase,
      };
      for (let k = 0; k < matchedTime.consumed; k++) consumedWords.add(matchedTime.startWord + k);
    }
  }

  for (let i = 0; i < words.length; i++) {
    if (!consumedWords.has(i)) {
      titleWords.push(words[i]!);
    }
  }

  // Wall-clock time in the zone (adding minutes to midnight lands an hour off on a DST day).
  const day = dueDay ?? (recurrence !== undefined ? firstRuleDay(recurrence, now, tz) : undefined);
  let dueAt: number | undefined;
  if (day !== undefined) {
    dueAt = dueTime !== null ? atMinutes(day, dueTime, tz) : endOfDay(day, tz);
  } else if (dueTime !== null) {
    dueAt = atMinutes(now, dueTime, tz);
  }
  if (recurrence && dueAt !== undefined) recurrence = anchorMonthDay(recurrence, dueAt, tz);

  const title = titleWords.join(" ").trim();

  const chips: ParsedChip[] = [];
  if (dueAt !== undefined) {
    chips.push({ kind: "due", label: formatDueChip(dueAt, explicitTime, tz, ctx.language) });
  }
  if (recurrence) chips.push({ kind: "recurrence", label: formatRule(recurrence) ?? recurrence });
  if (projectName) chips.push({ kind: "project", label: `#${projectName}` });
  for (const l of labels) chips.push({ kind: "label", label: `@${l}` });
  if (priority) chips.push({ kind: "priority", label: `P${priority}` });

  const input: CreateTaskInput = { title };
  if (priority) input.priority = priority;
  if (dueAt !== undefined) input.due_at = dueAt;
  if (recurrence) input.recurrence = recurrence;
  if (resolvedProjectId) input.project_id = resolvedProjectId;

  return {
    input,
    title,
    chips,
    dateMatch,
    projectMatch,
    labelMatches: labelMatches.length > 0 ? labelMatches : undefined,
    labels,
  };
}
