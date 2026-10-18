import { describe, it, expect } from "vitest";
import type { Task } from "@atlastodo/client-core";
import { evaluate, parse, type EvalContext, type FilterNode } from "./filterQuery";

const NOW = new Date(2026, 6, 15, 9).getTime(); // 2026-07-15 09:00 local

function task(overrides: Partial<Task>): Task {
  return {
    id: "t",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "task",
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return { now: NOW, labelsOf: () => [], projectNameOf: () => null, ...overrides };
}

/** Parse and fail the test if the query didn't parse. */
function ast(query: string): FilterNode {
  const r = parse(query);
  if (!r.ok) throw new Error(`expected parse ok, got: ${r.error}`);
  return r.ast;
}

describe("parse", () => {
  it("handles AND / OR with fields", () => {
    const r = parse("p1 & due:today");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast.type).toBe("and");
    const or = parse("@work | @home");
    expect(or.ok).toBe(true);
    if (or.ok) expect(or.ast.type).toBe("or");
  });

  it("treats adjacency as implicit AND", () => {
    const r = parse("p1 overdue");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast.type).toBe("and");
  });

  it("binds NOT tighter than AND, and AND tighter than OR", () => {
    // a | b & c  ==  a | (b & c)
    const r = parse("p1 | p2 & p3");
    expect(r.ok && r.ast.type).toBe("or");
  });

  it("respects parentheses", () => {
    const r = parse("(p1 | p2) & due:week");
    expect(r.ok && r.ast.type).toBe("and");
  });

  it("surfaces an error for invalid input instead of throwing", () => {
    expect(parse("")).toMatchObject({ ok: false });
    expect(parse("p1 &")).toMatchObject({ ok: false });
    expect(parse("(p1")).toMatchObject({ ok: false });
    expect(parse("@")).toMatchObject({ ok: false });
    expect(parse("due:whenever")).toMatchObject({ ok: false });
    expect(parse("due:8x")).toMatchObject({ ok: false });
    expect(parse("due:")).toMatchObject({ ok: false });
    expect(parse("due:d")).toMatchObject({ ok: false });
    const bad = parse("p1 )");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(typeof bad.at).toBe("number");
  });

  it("parses the extended due vocabulary + custom Nd window", () => {
    expect(ast("due:month")).toEqual({ type: "due", when: "month" });
    expect(ast("due:weekend")).toEqual({ type: "due", when: "weekend" });
    expect(ast("due:next-week")).toEqual({ type: "due", when: "next-week" });
    expect(ast("due:this-month")).toEqual({ type: "due", when: "month" }); // synonym
    expect(ast("due:7d")).toEqual({ type: "dueWithin", days: 7 });
    expect(ast("due:0d")).toEqual({ type: "dueWithin", days: 0 });
  });
});

describe("evaluate", () => {
  it("matches priority and due:today", () => {
    const node = ast("p1 & due:today");
    const match = task({ priority: 1, due_at: new Date(2026, 6, 15, 18).getTime() });
    const miss = task({ priority: 2, due_at: new Date(2026, 6, 15, 18).getTime() });
    expect(evaluate(node, match, ctx())).toBe(true);
    expect(evaluate(node, miss, ctx())).toBe(false);
  });

  it("evaluates label + due:week + priority over a fixture set", () => {
    const node = ast("@work & due:week & p1");
    const labels: Record<string, string[]> = { a: ["work"], b: ["home"], c: ["work"] };
    const c = ctx({ labelsOf: (t) => labels[t.id] ?? [] });

    const tasks = [
      task({ id: "a", priority: 1, due_at: new Date(2026, 6, 17).getTime() }), // work, in week, p1 -> match
      task({ id: "b", priority: 1, due_at: new Date(2026, 6, 17).getTime() }), // home -> no
      task({ id: "c", priority: 2, due_at: new Date(2026, 6, 17).getTime() }), // work but p2 -> no
    ];
    expect(tasks.filter((t) => evaluate(node, t, c)).map((t) => t.id)).toEqual(["a"]);
  });

  it("handles NOT and OR", () => {
    const node = ast("p1 | !due:none");
    const withDue = task({ priority: 4, due_at: NOW });
    const noDue = task({ priority: 4, due_at: null });
    const p1NoDue = task({ priority: 1, due_at: null });
    expect(evaluate(node, withDue, ctx())).toBe(true); // !due:none
    expect(evaluate(node, noDue, ctx())).toBe(false);
    expect(evaluate(node, p1NoDue, ctx())).toBe(true); // p1
  });

  it("matches project by name and free text on the title", () => {
    const node = ast("#home & report");
    const c = ctx({ projectNameOf: (t) => (t.project_id === "p1" ? "Home" : null) });
    expect(evaluate(node, task({ project_id: "p1", title: "Quarterly report" }), c)).toBe(true);
    expect(evaluate(node, task({ project_id: "p1", title: "groceries" }), c)).toBe(false);
    expect(evaluate(node, task({ project_id: "p2", title: "report" }), c)).toBe(false);
  });

  // NOW is Wednesday 2026-07-15; that week's weekend is Sat/Sun Jul 18-19, next week is Jul 20-26.
  it("matches this calendar month (due:month)", () => {
    const node = ast("due:month");
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 31).getTime() }), ctx())).toBe(true);
    expect(evaluate(node, task({ due_at: new Date(2026, 7, 1).getTime() }), ctx())).toBe(false);
    expect(evaluate(node, task({ due_at: new Date(2026, 5, 30).getTime() }), ctx())).toBe(false);
    expect(evaluate(node, task({ due_at: null }), ctx())).toBe(false);
  });

  it("matches a custom Nd window (due:3d): three days, today the first", () => {
    const node = ast("due:3d");
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 15, 18).getTime() }), ctx())).toBe(true);
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 17, 23).getTime() }), ctx())).toBe(true);
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 18).getTime() }), ctx())).toBe(false);
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 14).getTime() }), ctx())).toBe(false);
    // due:1d is today alone.
    const today = ast("due:1d");
    expect(evaluate(today, task({ due_at: new Date(2026, 6, 15, 18).getTime() }), ctx())).toBe(
      true,
    );
    expect(evaluate(today, task({ due_at: new Date(2026, 6, 16).getTime() }), ctx())).toBe(false);
  });

  it("matches the coming weekend (due:weekend)", () => {
    const node = ast("due:weekend");
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 18).getTime() }), ctx())).toBe(true); // Sat
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 19).getTime() }), ctx())).toBe(true); // Sun
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 15).getTime() }), ctx())).toBe(false); // Wed
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 25).getTime() }), ctx())).toBe(false); // out of window
  });

  it("means the weekend under way on a Saturday or Sunday, never the next one", () => {
    const node = ast("due:weekend");
    const due = (d: number) => task({ due_at: new Date(2026, 6, d, 12).getTime() });
    const saturday = ctx({ now: new Date(2026, 6, 18, 9).getTime() });
    expect(evaluate(node, due(18), saturday)).toBe(true);
    expect(evaluate(node, due(19), saturday)).toBe(true);
    expect(evaluate(node, due(25), saturday)).toBe(false); // the Saturday a week out
    const sunday = ctx({ now: new Date(2026, 6, 19, 9).getTime() });
    expect(evaluate(node, due(19), sunday)).toBe(true);
    expect(evaluate(node, due(25), sunday)).toBe(false);
    expect(evaluate(node, due(26), sunday)).toBe(false);
  });

  it("matches next calendar week (due:next-week), Monday-based by default", () => {
    const node = ast("due:next-week");
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 20).getTime() }), ctx())).toBe(true); // Mon
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 26).getTime() }), ctx())).toBe(true); // Sun
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 18).getTime() }), ctx())).toBe(false); // this weekend
    expect(evaluate(node, task({ due_at: new Date(2026, 6, 27).getTime() }), ctx())).toBe(false); // Mon after
  });

  it("follows the week-start preference for due:next-week", () => {
    const node = ast("due:next-week");
    const due = (d: number) => task({ due_at: new Date(2026, 6, d, 12).getTime() });
    // Sunday-start: from Wed Jul 15, next week runs Sun Jul 19 .. Sat Jul 25.
    const sundayStart = ctx({ weekStartsOn: 0 });
    expect(evaluate(node, due(18), sundayStart)).toBe(false);
    expect(evaluate(node, due(19), sundayStart)).toBe(true);
    expect(evaluate(node, due(25), sundayStart)).toBe(true);
    expect(evaluate(node, due(26), sundayStart)).toBe(false);
    // On the week-start day itself, next week begins seven days out.
    const onSunday = ctx({ weekStartsOn: 0, now: new Date(2026, 6, 19, 9).getTime() });
    expect(evaluate(node, due(25), onSunday)).toBe(false);
    expect(evaluate(node, due(26), onSunday)).toBe(true);
    // Saturday-start.
    expect(evaluate(node, due(17), ctx({ weekStartsOn: 6 }))).toBe(false);
    expect(evaluate(node, due(18), ctx({ weekStartsOn: 6 }))).toBe(true);
  });

  it("honors ctx.timeZone for due matching", () => {
    // A single instant lands on different calendar days depending on the zone.
    const now = Date.UTC(2026, 6, 15, 20); // 2026-07-15 20:00 UTC
    const t = task({ due_at: Date.UTC(2026, 6, 16, 12) });
    const node = ast("due:today");
    const west = ctx({ now, timeZone: "America/Noronha" }); // UTC-2 -> due is tomorrow
    const east = ctx({ now, timeZone: "Pacific/Guadalcanal" }); // UTC+11 -> due is today
    expect(evaluate(node, t, west)).toBe(false);
    expect(evaluate(node, t, east)).toBe(true);
  });
});
