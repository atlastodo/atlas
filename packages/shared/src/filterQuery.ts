import type { Priority, Task } from "@atlastodo/client-core";
import { isOverdue } from "./smartLists";
import { dayOffset } from "./zonedTime";
import { zonedParts } from "./zonedTime";

/**
 * A small query language for saved filters and smart lists, e.g. `@work & due:week & p1`,
 * `#home | (p1 & !due:none)`.
 *
 * Grammar (NOT binds tightest, then AND, then OR; adjacency means AND):
 *
 *   or    := and ( ('|' | 'or') and )*
 *   and   := not ( ('&' | 'and')? not )*
 *   not   := ('!' | 'not') not | term
 *   term  := '(' or ')' | atom
 *   atom  := pN | @label | #project | due:WHEN | due:Nd | overdue | text
 *
 * `due:WHEN` is today/tomorrow/week/month/weekend/next-week/overdue/none; `due:Nd` is the next N
 * days. `parse` never throws: invalid input returns `{ ok: false, error, at }`.
 */

export type DueWhen =
  "today" | "tomorrow" | "week" | "month" | "weekend" | "next-week" | "overdue" | "none";

export type FilterNode =
  | { type: "and"; left: FilterNode; right: FilterNode }
  | { type: "or"; left: FilterNode; right: FilterNode }
  | { type: "not"; child: FilterNode }
  | { type: "priority"; value: Priority }
  | { type: "label"; name: string }
  | { type: "project"; name: string }
  | { type: "due"; when: DueWhen }
  | { type: "dueWithin"; days: number }
  | { type: "text"; value: string };

export type ParseResult = { ok: true; ast: FilterNode } | { ok: false; error: string; at: number };

type Token =
  | { kind: "and" | "or" | "not" | "lparen" | "rparen"; at: number }
  | { kind: "atom"; value: string; at: number };

type SymbolKind = "and" | "or" | "not" | "lparen" | "rparen";
const SYMBOLS: Record<string, SymbolKind> = {
  "&": "and",
  "|": "or",
  "!": "not",
  "(": "lparen",
  ")": "rparen",
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let wordAt = 0;
  const flush = () => {
    if (!word) return;
    const lower = word.toLowerCase();
    if (lower === "and" || lower === "or" || lower === "not") {
      tokens.push({ kind: lower, at: wordAt });
    } else {
      tokens.push({ kind: "atom", value: word, at: wordAt });
    }
    word = "";
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      flush();
    } else if (ch in SYMBOLS) {
      flush();
      tokens.push({ kind: SYMBOLS[ch]!, at: i });
    } else {
      if (!word) wordAt = i;
      word += ch;
    }
  }
  flush();
  return tokens;
}

const DUE_VALUES: DueWhen[] = [
  "today",
  "tomorrow",
  "week",
  "month",
  "weekend",
  "next-week",
  "overdue",
  "none",
];

const DUE_SYNONYMS: Record<string, DueWhen> = {
  "this-week": "week",
  "this-month": "month",
  nextweek: "next-week",
};

function atomToNode(value: string, at: number): FilterNode {
  if (/^p[1-4]$/i.test(value)) {
    return { type: "priority", value: Number(value[1]) as Priority };
  }
  if (value === "overdue") return { type: "due", when: "overdue" };
  if (value.startsWith("@")) {
    const name = value.slice(1);
    if (!name) throw new ParseError("expected a label name after '@'", at);
    return { type: "label", name };
  }
  if (value.startsWith("#")) {
    const name = value.slice(1);
    if (!name) throw new ParseError("expected a project name after '#'", at);
    return { type: "project", name };
  }
  if (value.toLowerCase().startsWith("due:")) {
    const raw = value.slice(4).toLowerCase();
    const window = /^(\d+)d$/.exec(raw);
    if (window) return { type: "dueWithin", days: Number(window[1]) };
    const when = DUE_SYNONYMS[raw] ?? raw;
    if (!DUE_VALUES.includes(when as DueWhen)) {
      throw new ParseError(
        `unknown due value '${raw}' (expected ${DUE_VALUES.join(", ")}, or Nd e.g. 7d)`,
        at,
      );
    }
    return { type: "due", when: when as DueWhen };
  }
  return { type: "text", value };
}

class ParseError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

function isTermStart(kind: Token["kind"]): boolean {
  return kind === "atom" || kind === "lparen" || kind === "not";
}

export function parse(input: string): ParseResult {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const nextIndex = () => tokens[pos]?.at ?? input.length;

  function parseOr(): FilterNode {
    let left = parseAnd();
    while (peek()?.kind === "or") {
      pos++;
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): FilterNode {
    let left = parseNot();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.kind === "and") {
        pos++;
        left = { type: "and", left, right: parseNot() };
      } else if (isTermStart(t.kind)) {
        // Adjacency = implicit AND.
        left = { type: "and", left, right: parseNot() };
      } else {
        break;
      }
    }
    return left;
  }

  function parseNot(): FilterNode {
    if (peek()?.kind === "not") {
      pos++;
      return { type: "not", child: parseNot() };
    }
    return parseTerm();
  }

  function parseTerm(): FilterNode {
    const t = peek();
    if (!t) throw new ParseError("unexpected end of query", input.length);
    if (t.kind === "lparen") {
      pos++;
      const inner = parseOr();
      const close = peek();
      if (close?.kind !== "rparen") throw new ParseError("expected ')'", nextIndex());
      pos++;
      return inner;
    }
    if (t.kind === "atom") {
      pos++;
      return atomToNode(t.value, t.at);
    }
    throw new ParseError(`unexpected '${t.kind}'`, t.at);
  }

  try {
    if (tokens.length === 0) throw new ParseError("empty query", 0);
    const ast = parseOr();
    if (pos < tokens.length) throw new ParseError("unexpected trailing input", nextIndex());
    return { ok: true, ast };
  } catch (err) {
    if (err instanceof ParseError) return { ok: false, error: err.message, at: err.at };
    throw err;
  }
}

export interface EvalContext {
  now: number;
  labelsOf: (task: Task) => string[];
  projectNameOf: (task: Task) => string | null;
  timeZone?: string;
  weekStartsOn?: number;
}

function daysUntilNextWeek(now: number, weekStartsOn: number, timeZone?: string): number {
  const start = ((weekStartsOn % 7) + 7) % 7;
  return 7 - ((zonedParts(now, timeZone).weekday - start + 7) % 7);
}

function matchesDue(
  task: Task,
  when: DueWhen,
  now: number,
  timeZone?: string,
  weekStartsOn = 1,
): boolean {
  switch (when) {
    case "none":
      return task.due_at === null;
    case "overdue":
      return isOverdue(task, now, timeZone);
    case "month": {
      if (task.due_at === null) return false;
      const d = zonedParts(task.due_at, timeZone);
      const n = zonedParts(now, timeZone);
      return d.year === n.year && d.month === n.month;
    }
    case "weekend": {
      // The weekend under way, else the coming one (from a Saturday, next Saturday is not "the weekend").
      if (task.due_at === null) return false;
      const off = dayOffset(task.due_at, now, timeZone);
      const sunday = (7 - zonedParts(now, timeZone).weekday) % 7;
      return off >= Math.max(0, sunday - 1) && off <= sunday;
    }
    case "next-week": {
      if (task.due_at === null) return false;
      const off = dayOffset(task.due_at, now, timeZone);
      const start = daysUntilNextWeek(now, weekStartsOn, timeZone);
      return off >= start && off <= start + 6;
    }
    default: {
      if (task.due_at === null) return false;
      const off = dayOffset(task.due_at, now, timeZone);
      if (when === "today") return off === 0;
      if (when === "tomorrow") return off === 1;
      return off >= 0 && off <= 7; // "week": today through the next 7 days
    }
  }
}

function matchesDueWithin(task: Task, days: number, now: number, timeZone?: string): boolean {
  if (task.due_at === null) return false;
  const off = dayOffset(task.due_at, now, timeZone);
  return off >= 0 && off < days;
}

export function evaluate(node: FilterNode, task: Task, ctx: EvalContext): boolean {
  switch (node.type) {
    case "and":
      return evaluate(node.left, task, ctx) && evaluate(node.right, task, ctx);
    case "or":
      return evaluate(node.left, task, ctx) || evaluate(node.right, task, ctx);
    case "not":
      return !evaluate(node.child, task, ctx);
    case "priority":
      return task.priority === node.value;
    case "text":
      return task.title.toLowerCase().includes(node.value.toLowerCase());
    case "due":
      return matchesDue(task, node.when, ctx.now, ctx.timeZone, ctx.weekStartsOn);
    case "dueWithin":
      return matchesDueWithin(task, node.days, ctx.now, ctx.timeZone);
    case "label":
      return ctx.labelsOf(task).some((n) => n.toLowerCase() === node.name.toLowerCase());
    case "project": {
      const name = ctx.projectNameOf(task);
      return name !== null && name.toLowerCase() === node.name.toLowerCase();
    }
  }
}
