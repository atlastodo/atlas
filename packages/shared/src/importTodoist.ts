import { strFromU8, unzipSync } from "fflate";
import type { BundleEntity, ExportBundle } from "./dataTransfer";
import { derivedUuidV2 } from "./ids";
import { parseCsvRows } from "./importTicktick";
import { DEFAULT_PROJECT_ICON, defaultColorForIndex } from "./projectStyle";
import { anchorMonthDay, ruleToString, type Freq, type Rule } from "./recurrence";
import { endOfDay, isValidTimeZone, makeInstant, zonedParts } from "./zonedTime";

/**
 * Todoist import: one project's CSV export, or the backup zip (one CSV per project), converted to
 * an `ExportBundle` that `importBundle` merges, as the TickTick import does.
 *
 * The CSV has no ids, so an entity's id is derived from the importing user and where it sits in
 * the file (project, section, parent chain, title): importing the same file again updates what the
 * first import created instead of duplicating it.
 */

export type TodoistKind = "project" | "section" | "label" | "task" | "comment";

export interface TodoistFile {
  // The file name as Todoist wrote it ("Work [2203306141].csv"); it names the project.
  name: string;
  text: string;
}

export interface TodoistImportOptions {
  userId: string;
  timeZone?: string;
  now?: number;
}

export interface TodoistImportCounts {
  projects: number;
  sections: number;
  labels: number;
  tasks: number;
  subtasks: number;
  comments: number;
}

// A code, not a sentence: the app owns the copy (i18n).
export type TodoistWarningCode =
  | "notTodoist"
  | "recurrence"
  | "date"
  | "deadline"
  | "duration"
  | "assignee"
  | "projectNote"
  | "timezone";

export interface TodoistWarning {
  code: TodoistWarningCode;
  detail?: string;
}

export interface TodoistImportResult {
  bundle: ExportBundle;
  counts: TodoistImportCounts;
  warnings: TodoistWarning[];
}

export function todoistUuid(userId: string, kind: TodoistKind, key: string): string {
  return derivedUuidV2(`todoist:${userId}:${kind}`, key);
}

/** "Work [2203306141].csv" -> "Work": the backup appends the project id to each file name. */
export function todoistProjectName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base
    .replace(/\.csv$/i, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * The CSV files of a picked file: every CSV in a backup zip, or the file itself. Decoded with
 * fflate's own UTF-8 decoder, as Hermes has no `TextDecoder` everywhere.
 */
export function readTodoistFiles(name: string, bytes: Uint8Array): TodoistFile[] {
  if (!isZip(bytes)) return [{ name, text: strFromU8(bytes) }];
  let entries: Record<string, Uint8Array>;
  try {
    // macOS adds `__MACOSX/._x.csv` resource forks when it re-zips a folder; they are not CSV.
    entries = unzipSync(bytes, {
      filter: (f) => /\.csv$/i.test(f.name) && !/(^|\/)(__MACOSX\/|\._)/.test(f.name),
    });
  } catch {
    throw new Error("not-todoist-backup");
  }
  return Object.keys(entries)
    .sort()
    .map((entry) => ({ name: entry, text: strFromU8(entries[entry]!) }));
}

// The CSV numbers priorities as the UI does (1 = p1, most urgent; 4 = p4, none), and so does Atlas.
// (Todoist's REST API runs the other way: 4 is p1.)
function atlasPriority(raw: string): number {
  const p = Number(raw);
  return Number.isInteger(p) && p >= 1 && p <= 4 ? p : 4;
}

// A label is an `@name` word; an `@` inside a word ("bob@example.com") is not one.
const LABEL_RE = /(^|\s)@([^\s@]+)/g;

function splitLabels(content: string): { title: string; labels: string[] } {
  const labels: string[] = [];
  const title = content
    .replace(LABEL_RE, (_m, lead: string, name: string) => {
      labels.push(name);
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { title, labels };
}

// --- Dates -----------------------------------------------------------------------------------

interface CivilDate {
  year: number;
  month: number; // 0-indexed
  day: number;
}

interface ParsedDate {
  dueAt: number;
  recurrence?: string;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// Monday = 0, as `Rule.byday` counts.
const WEEKDAYS: Record<string, number> = {
  mon: 0,
  monday: 0,
  tue: 1,
  tues: 1,
  tuesday: 1,
  wed: 2,
  wednesday: 2,
  thu: 3,
  thur: 3,
  thurs: 3,
  thursday: 3,
  fri: 4,
  friday: 4,
  sat: 5,
  saturday: 5,
  sun: 6,
  sunday: 6,
};

// Own keys only: `"constructor" in MONTHS` is true.
const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

const DAY_MS = 86_400_000;
const civilDays = (d: CivilDate) => Math.floor(Date.UTC(d.year, d.month, d.day) / DAY_MS);
const fromDays = (n: number): CivilDate => {
  const d = new Date(n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
};
const weekdayMon0 = (d: CivilDate) =>
  (new Date(Date.UTC(d.year, d.month, d.day)).getUTCDay() + 6) % 7;
const daysInMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

function validDate(year: number, month: number, day: number): CivilDate | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!(month >= 0 && month <= 11) || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

// A date without a year is the one nearest today: an overdue "Oct 1" stays this year's, while
// "Jan 5" exported in December is next year's.
function nearestYear(month: number, day: number, today: CivilDate): CivilDate | null {
  let best: CivilDate | null = null;
  for (const year of [today.year - 1, today.year, today.year + 1]) {
    const date = validDate(year, month, day);
    if (!date) continue;
    if (
      !best ||
      Math.abs(civilDays(date) - civilDays(today)) < Math.abs(civilDays(best) - civilDays(today))
    ) {
      best = date;
    }
  }
  return best;
}

// "at 9am", "14:00", "@ 5:30 pm" at the end of the phrase. A bare number is a day, not a time.
function splitTime(
  phrase: string,
): { rest: string; time: { hour: number; minute: number } | null } | null {
  const m = /(^|\s+)(?:(at|@)\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/.exec(phrase);
  if (!m || !(m[2] || m[4] || m[5])) return { rest: phrase, time: null };
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? "0");
  if (m[5]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[5] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return { rest: phrase.slice(0, m.index).trim(), time: { hour, minute } };
}

function parseMonthDay(phrase: string, today: CivilDate): CivilDate | null {
  const monthFirst = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(phrase);
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?(?:,?\s+(\d{4}))?$/.exec(phrase);
  const [monthName, day, year] = monthFirst
    ? [monthFirst[1]!, monthFirst[2]!, monthFirst[3]]
    : dayFirst
      ? [dayFirst[2]!, dayFirst[1]!, dayFirst[3]]
      : [];
  if (monthName === undefined || !own(MONTHS, monthName)) return null;
  const month = MONTHS[monthName]!;
  return year
    ? validDate(Number(year), month, Number(day))
    : nearestYear(month, Number(day), today);
}

function parseCivilDate(phrase: string, today: CivilDate): CivilDate | null {
  if (phrase === "" || phrase === "today" || phrase === "tod") return today;
  if (phrase === "tomorrow" || phrase === "tom") return fromDays(civilDays(today) + 1);
  if (phrase === "yesterday") return fromDays(civilDays(today) - 1);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(phrase);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  // "monday" is the next Monday, today included; "next monday" skips today.
  const weekday = /^(next\s+)?([a-z]+)$/.exec(phrase);
  if (weekday && own(WEEKDAYS, weekday[2]!)) {
    const target = WEEKDAYS[weekday[2]!]!;
    const delta = (target - weekdayMon0(today) + 7) % 7 || (weekday[1] ? 7 : 0);
    return fromDays(civilDays(today) + delta);
  }
  return parseMonthDay(phrase, today);
}

interface ParsedRule {
  rule: Rule;
  // A yearly rule's month and day ("every jan 5").
  yearDay?: { month: number; day: number };
}

const FREQ_UNITS: Record<string, Freq> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
};
const FREQ_WORDS: Record<string, Freq> = {
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
  yearly: "yearly",
  annually: "yearly",
};

// The "every ..." phrases the Atlas engine can repeat on; anything else is null.
function parseEvery(body: string, interval: number, mode: Rule["mode"]): ParsedRule | null {
  const rule = (
    freq: Freq,
    n = interval,
    byday: number[] = [],
    bymonthday: number | null = null,
  ): Rule => ({
    freq,
    interval: n,
    byday,
    bymonthday,
    mode,
  });
  const unit = /^(?:(\d+)\s+)?(day|week|month|year)s?$/.exec(body);
  if (unit) {
    const n = (unit[1] ? Number(unit[1]) : 1) * interval;
    return n >= 1 && n <= 1000 ? { rule: rule(FREQ_UNITS[unit[2]!]!, n) } : null;
  }
  if (body === "weekday" || body === "workday")
    return { rule: rule("weekly", interval, [0, 1, 2, 3, 4]) };
  if (body === "weekend") return { rule: rule("weekly", interval, [5, 6]) };
  const days = body.split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
  if (days.length > 0 && days.every((d) => own(WEEKDAYS, d))) {
    const byday = [...new Set(days.map((d) => WEEKDAYS[d]!))].sort((a, b) => a - b);
    return { rule: rule("weekly", interval, byday) };
  }
  const monthDay = /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+the\s+month)?$/.exec(body);
  if (monthDay) {
    const day = Number(monthDay[1]);
    return day >= 1 && day <= 31 ? { rule: rule("monthly", interval, [], day) } : null;
  }
  // A date without a year repeats yearly. The reference year is a leap year, so Feb 29 parses.
  const yearly = parseMonthDay(body, { year: 2024, month: 0, day: 1 });
  if (yearly && !/\d{4}/.test(body)) {
    return { rule: rule("yearly"), yearDay: { month: yearly.month, day: yearly.day } };
  }
  return null;
}

type DateOutcome = ParsedDate | { unsupported: "recurrence" | "date" };

/**
 * A Todoist due string ("every monday at 9am", "Oct 12", "2026-10-12") as a due instant, plus an
 * Atlas rule when it repeats. A repeating task starts on its first occurrence from today, as a
 * task typed into Todoist would.
 */
export function parseTodoistDate(raw: string, now: number, timeZone?: string): DateOutcome | null {
  let phrase = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (phrase === "") return null;
  const p = zonedParts(now, timeZone);
  const today: CivilDate = { year: p.year, month: p.month, day: p.day };

  const instant = (date: CivilDate, time: { hour: number; minute: number } | null) =>
    time
      ? makeInstant(date.year, date.month, date.day, time.hour, time.minute, 0, timeZone)
      : endOfDay(makeInstant(date.year, date.month, date.day, 12, 0, 0, timeZone), timeZone);

  // Todoist writes a fixed date with a time as ISO ("2026-10-12T09:00:00").
  const isoTime = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::\d{2})?(z)?$/.exec(phrase);
  if (isoTime) {
    const date = validDate(Number(isoTime[1]), Number(isoTime[2]) - 1, Number(isoTime[3]));
    const [hour, minute] = [Number(isoTime[4]), Number(isoTime[5])];
    if (!date || hour > 23 || minute > 59) return { unsupported: "date" };
    if (isoTime[6]) return { dueAt: Date.UTC(date.year, date.month, date.day, hour, minute) };
    return { dueAt: instant(date, { hour, minute }) };
  }

  const repeating = /^(every!?|daily|weekly|monthly|yearly|annually)\b/.exec(phrase);
  if (!repeating) {
    const split = splitTime(phrase);
    const date = split && parseCivilDate(split.rest, today);
    return date ? { dueAt: instant(date, split.time) } : { unsupported: "date" };
  }

  // "every day starting oct 20": the series' first day. An end ("until", "for 3 weeks") cannot be kept.
  let start = today;
  const starting = /\s+(?:starting(?:\s+on)?|from)\s+(.+)$/.exec(phrase);
  if (starting) {
    const date = parseCivilDate(starting[1]!, today);
    if (!date) return { unsupported: "recurrence" };
    start = date;
    phrase = phrase.slice(0, starting.index);
  }
  if (/\b(until|ending|ends|for)\b/.test(phrase)) return { unsupported: "recurrence" };

  const split = splitTime(phrase);
  if (!split) return { unsupported: "recurrence" };
  let parsed: ParsedRule | null;
  const word = own(FREQ_WORDS, split.rest) ? FREQ_WORDS[split.rest] : undefined;
  if (word) {
    parsed = {
      rule: { freq: word, interval: 1, byday: [], bymonthday: null, mode: "on_schedule" },
    };
  } else {
    const every = /^every(!?)\s+(?:(other)\s+)?(.+)$/.exec(split.rest);
    parsed = every
      ? parseEvery(every[3]!, every[2] ? 2 : 1, every[1] ? "after_completion" : "on_schedule")
      : null;
  }
  if (!parsed) return { unsupported: "recurrence" };

  const { rule, yearDay } = parsed;
  let first = start;
  if (rule.freq === "weekly" && rule.byday.length > 0) {
    const delta = Math.min(...rule.byday.map((d) => (d - weekdayMon0(start) + 7) % 7));
    first = fromDays(civilDays(start) + delta);
  } else if (rule.freq === "monthly" && rule.bymonthday !== null) {
    const day = rule.bymonthday;
    const clamp = (y: number, m: number) => ({
      year: y,
      month: m,
      day: Math.min(day, daysInMonth(y, m)),
    });
    first = clamp(start.year, start.month);
    if (civilDays(first) < civilDays(start)) {
      const next = new Date(Date.UTC(start.year, start.month + 1, 1));
      first = clamp(next.getUTCFullYear(), next.getUTCMonth());
    }
  } else if (yearDay) {
    for (let year = start.year; year <= start.year + 8; year++) {
      const date = validDate(year, yearDay.month, yearDay.day);
      if (date && civilDays(date) >= civilDays(start)) {
        first = date;
        break;
      }
    }
  }
  const dueAt = instant(first, split.time);
  // A monthly or yearly rule falls on the due date's day, as one set in the app does.
  return { dueAt, recurrence: anchorMonthDay(ruleToString(rule), dueAt, timeZone) };
}

// --- Conversion ------------------------------------------------------------------------------

export function todoistToBundle(
  files: TodoistFile[],
  options: TodoistImportOptions,
): TodoistImportResult {
  const now = options.now ?? Date.now();
  const fallbackZone = options.timeZone || undefined;
  const idFor = (kind: TodoistKind, key: string) => todoistUuid(options.userId, kind, key);

  const warnings: TodoistWarning[] = [];
  const seenWarnings = new Set<string>();
  const warn = (code: TodoistWarningCode, detail?: string) => {
    const key = `${code}:${detail ?? ""}`;
    if (seenWarnings.has(key)) return;
    seenWarnings.add(key);
    warnings.push(detail == null ? { code } : { code, detail });
  };

  const projects = new Map<string, BundleEntity>();
  const sections = new Map<string, BundleEntity>();
  const labels = new Map<string, BundleEntity>();
  const tasks: BundleEntity[] = [];
  const comments: BundleEntity[] = [];
  const counts: TodoistImportCounts = {
    projects: 0,
    sections: 0,
    labels: 0,
    tasks: 0,
    subtasks: 0,
    comments: 0,
  };
  const usedProjectKeys = new Set<string>();
  let todoistFiles = 0;

  for (const file of files) {
    const rows = parseCsvRows(file.text);
    const headerIndex = rows.findIndex((r) => {
      const cells = r.map((c) => c.trim().toUpperCase());
      return cells.includes("TYPE") && cells.includes("CONTENT");
    });
    if (headerIndex === -1) {
      warn("notTodoist", file.name);
      continue;
    }
    todoistFiles++;
    const header = rows[headerIndex]!.map((h) => h.trim().toUpperCase());
    const records = rows
      .slice(headerIndex + 1)
      .filter((cells) => cells.some((c) => c.trim() !== ""))
      .map((cells) => {
        const rec: Record<string, string> = {};
        header.forEach((name, i) => {
          // A quoted cell keeps the file's line ends; Atlas stores "\n".
          rec[name] = (cells[i] ?? "").replace(/\r\n?/g, "\n");
        });
        return rec;
      });

    // Project: the file's name; "Inbox" is Atlas's project-less Inbox.
    const projectName = todoistProjectName(file.name) || "Todoist";
    const isInbox = projectName.toLowerCase() === "inbox";
    // Two projects of one name in a backup stay apart through the id Todoist put in the file name.
    let projectKey = projectName;
    if (usedProjectKeys.has(projectKey)) projectKey = `${projectName}\u0000${file.name}`;
    usedProjectKeys.add(projectKey);
    let projectId: string | undefined;
    if (!isInbox) {
      projectId = idFor("project", projectKey);
      projects.set(projectId, {
        id: projectId,
        fields: {
          name: projectName,
          kind: "project",
          icon: DEFAULT_PROJECT_ICON,
          color: defaultColorForIndex(projects.size),
          sort_order: projects.size,
        },
      });
    }

    let sectionName = "";
    let sectionId: string | undefined;
    let sectionCount = 0;
    let taskOrder = 0;
    // The open ancestors by indent: a row's parent is the nearest earlier task indented less.
    let stack: { indent: number; id: string; key: string }[] = [];
    let lastTask: { id: string; key: string; comments: number } | null = null;
    const seenKeys = new Map<string, number>();

    for (const rec of records) {
      const type = (rec.TYPE ?? "").trim().toLowerCase();
      const content = (rec.CONTENT ?? "").trim();

      if (type === "meta") {
        // `view_style=board` is the project's layout.
        const view = /view_style=(\w+)/.exec(content)?.[1];
        if (projectId && view === "board") projects.get(projectId)!.fields.default_view = "board";
        continue;
      }

      if (type === "section") {
        sectionName = content;
        stack = [];
        lastTask = null;
        taskOrder = 0;
        if (!projectId || !content) {
          // The Inbox has no sections in Atlas; its tasks stay in the Inbox.
          sectionId = undefined;
          continue;
        }
        sectionId = idFor("section", `${projectKey}\u0000${content}`);
        if (!sections.has(sectionId)) {
          sections.set(sectionId, {
            id: sectionId,
            fields: { project_id: projectId, name: content, sort_order: sectionCount++ },
          });
        }
        continue;
      }

      if (type === "note") {
        if (!lastTask) {
          warn("projectNote");
          continue;
        }
        if (!content) continue;
        const commentId = idFor("comment", `${lastTask.key}\u0000${lastTask.comments}`);
        comments.push({
          id: commentId,
          fields: {
            task_id: lastTask.id,
            author_id: options.userId,
            body: content,
            // One millisecond apart, so the thread keeps the file's order.
            created_at: now + lastTask.comments,
          },
        });
        lastTask.comments++;
        counts.comments++;
        continue;
      }

      if (type !== "task" || !content) continue;

      const indent = Math.max(1, Number(rec.INDENT) || 1);
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];

      const baseKey = `${projectKey}\u0000${sectionName}\u0000${parent?.key ?? ""}\u0000${content}`;
      const dup = seenKeys.get(baseKey) ?? 0;
      seenKeys.set(baseKey, dup + 1);
      const key = `${baseKey}\u0000${dup}`;
      const taskId = idFor("task", key);

      const { title, labels: labelNames } = splitLabels(content);
      const labelIds = labelNames.map((name) => {
        const id = idFor("label", name.toLowerCase());
        if (!labels.has(id)) {
          labels.set(id, { id, fields: { name, color: defaultColorForIndex(labels.size) } });
        }
        return id;
      });

      const fields: Record<string, unknown> = {};
      if (projectId) fields.project_id = projectId;
      if (sectionId) fields.section_id = sectionId;
      if (parent) {
        fields.parent_id = parent.id;
        counts.subtasks++;
      }
      fields.title = title || content;
      const description = (rec.DESCRIPTION ?? "").trim();
      if (description) fields.notes = description;
      fields.priority = atlasPriority((rec.PRIORITY ?? "").trim());
      fields.is_completed = false;

      const rawZone = (rec.TIMEZONE ?? "").trim();
      let zone = fallbackZone;
      if (rawZone) {
        if (isValidTimeZone(rawZone)) zone = rawZone;
        else warn("timezone", rawZone);
      }
      const dateText = (rec.DATE ?? "").trim();
      const deadlineText = (rec.DEADLINE ?? "").trim();
      // Atlas has one date per task: the deadline stands in only when there is no date.
      const dueText = dateText || deadlineText;
      if (dateText && deadlineText) warn("deadline");
      const date = parseTodoistDate(dueText, now, zone);
      if (date && "unsupported" in date) {
        warn(date.unsupported, dueText);
      } else if (date) {
        fields.due_at = date.dueAt;
        if (date.recurrence) fields.recurrence = date.recurrence;
      }

      const duration = Number(rec.DURATION);
      if (Number.isFinite(duration) && duration > 0) {
        const unit = (rec.DURATION_UNIT ?? "").trim().toLowerCase();
        if (unit === "" || unit.startsWith("minute")) fields.estimate_min = Math.round(duration);
        else warn("duration");
      }
      if ((rec.RESPONSIBLE ?? "").trim()) warn("assignee");

      if (labelIds.length > 0) fields.label_ids = labelIds;
      fields.sort_order = taskOrder++;
      fields.created_at = now;
      fields.updated_at = now;

      tasks.push({ id: taskId, fields });
      counts.tasks++;
      stack.push({ indent, id: taskId, key });
      lastTask = { id: taskId, key, comments: 0 };
    }
  }

  if (todoistFiles === 0) throw new Error("not-todoist-csv");

  counts.projects = projects.size;
  counts.sections = sections.size;
  counts.labels = labels.size;

  // Containers before their contents, so the server can resolve each task's project for fan-out.
  const entities: Record<string, BundleEntity[]> = {};
  if (projects.size > 0) entities.project = [...projects.values()];
  if (sections.size > 0) entities.section = [...sections.values()];
  if (labels.size > 0) entities.label = [...labels.values()];
  if (tasks.length > 0) entities.task = tasks;
  if (comments.length > 0) entities.comment = comments;

  return {
    bundle: { app: "atlas-todo", version: 1, exportedAt: now, entities },
    counts,
    warnings,
  };
}
