import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { parseQuickAdd } from "./quickAddParse";
import { evaluate, parse } from "./filterQuery";
import { allTasks, createTask, softDeleteTask, toggleTask, updateTask } from "./taskOps";

/**
 * The shared task-rule fixtures in `test-vectors/` (quick add, filter queries, the task rules),
 * which the Rust client (`crates/atlas-client/src/rules`) asserts as well. To add a case, add its
 * input to the fixture and copy the value this test reports into `expected`.
 */

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../test-vectors/${name}`, import.meta.url)), "utf8"),
  ) as T;

interface QuickAddCase {
  name: string;
  text: string;
  now: number;
  tz: string;
  language?: string;
  projects?: Record<string, string>;
  labels?: string[];
  expected: unknown;
}

describe("quick add vectors", () => {
  const { cases } = fixture<{ cases: QuickAddCase[] }>("quick_add_vectors.json");
  for (const c of cases) {
    it(`parses ${JSON.stringify(c.text)} (${c.tz}${c.language ? `, ${c.language}` : ""})`, () => {
      const { projects, labels } = c;
      const r = parseQuickAdd(c.text, c.now, {
        timeZone: c.tz,
        language: c.language,
        projectIdByName: projects
          ? (name) =>
              Object.entries(projects).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1] ??
              null
          : undefined,
        isKnownLabel: labels
          ? (name) => labels.some((l) => l.toLowerCase() === name.toLowerCase())
          : undefined,
      });
      expect({
        title: r.title,
        priority: r.input.priority ?? null,
        due_at: r.input.due_at ?? null,
        recurrence: r.input.recurrence ?? null,
        project_id: r.input.project_id ?? null,
        labels: r.labels,
        date_match: r.dateMatch ?? null,
      }).toEqual(c.expected);
    });
  }
});

interface FilterTask {
  id: string;
  title: string;
  priority: number;
  due_at: number | null;
  labels: string[];
  project: string | null;
  is_completed?: boolean;
}

describe("filter vectors", () => {
  const { tasks, cases } = fixture<{
    tasks: FilterTask[];
    cases: {
      query: string;
      now: number;
      tz: string;
      expected?: string[];
      error?: string;
      at?: number;
    }[];
  }>("filter_vectors.json");
  const asTask = (x: FilterTask): Task => ({
    id: x.id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title: x.title,
    notes: "",
    priority: x.priority as Task["priority"],
    start_at: null,
    due_at: x.due_at,
    is_completed: x.is_completed === true,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
  });
  for (const c of cases) {
    it(`${JSON.stringify(c.query)} at ${c.now} in ${c.tz}`, () => {
      const r = parse(c.query);
      if (!r.ok) {
        expect({ error: r.error, at: r.at }).toEqual({ error: c.error, at: c.at });
        return;
      }
      const ctx = {
        now: c.now,
        timeZone: c.tz,
        labelsOf: (t: Task) => tasks.find((x) => x.id === t.id)!.labels,
        projectNameOf: (t: Task) => tasks.find((x) => x.id === t.id)!.project,
      };
      expect(tasks.filter((t) => evaluate(r.ast, asTask(t), ctx)).map((t) => t.id)).toEqual(
        c.expected,
      );
    });
  }
});

type Fields = Record<string, unknown>;

interface RuleScenario {
  name: string;
  tz: string;
  now: number;
  actor: string | null;
  task?: Fields;
  reminders?: Fields[];
  action: "create" | "update" | "complete" | "reopen" | "delete";
  input?: Fields;
  patch?: [string, unknown][];
  result: unknown;
  expected: unknown;
}

const RULE_TASK_ID = "00000000-0000-4000-8000-000000000001";

/** Run a task-rule scenario on a fresh store: what it returned and what it wrote. */
function runRuleScenario(s: RuleScenario): { result: unknown; expected: unknown } {
  let n = 0x100;
  const store = new LocalStore("00000000-0000-4000-8000-0000000000ff", {
    now: () => s.now,
    newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`,
  });
  if (s.task) for (const [k, v] of Object.entries(s.task)) store.set("task", RULE_TASK_ID, k, v);
  (s.reminders ?? []).forEach((r, i) => {
    const id = `00000000-0000-4000-8000-0000000000${(0xa0 + i).toString(16)}`;
    store.set("reminder", id, "task_id", RULE_TASK_ID);
    for (const [k, v] of Object.entries(r)) store.set("reminder", id, k, v);
  });
  const before = new Set(store.unsyncedOps().map((o) => o.id));
  vi.useFakeTimers({ now: s.now, toFake: ["Date"] });
  let result: unknown = null;
  let subject = RULE_TASK_ID;
  try {
    const task = s.task ? allTasks(store).find((t) => t.id === RULE_TASK_ID)! : null;
    const actor = s.actor ?? undefined;
    switch (s.action) {
      case "create":
        subject = createTask(store, s.input as never, s.tz);
        break;
      case "complete":
      case "reopen":
        result = toggleTask(store, task!, actor, s.now, s.tz) !== null;
        break;
      case "update":
        result = updateTask(store, task!, Object.fromEntries(s.patch!), actor, s.now, s.tz);
        break;
      case "delete":
        result = softDeleteTask(store, task!, s.now);
        break;
    }
  } finally {
    vi.useRealTimers();
  }
  const ops = store.unsyncedOps().filter((o) => !before.has(o.id));
  const written = (entity: string) => {
    const byId = new Map<string, Fields>();
    for (const o of ops) {
      if (o.entity !== entity || o.op !== "set") continue;
      const f = byId.get(o.entityId) ?? {};
      f[o.field] = o.value;
      byId.set(o.entityId, f);
    }
    return byId;
  };
  const tasks = written("task");
  const spawnedId = [...tasks.keys()].find((id) => id !== subject && id !== RULE_TASK_ID) ?? null;
  const swap = (v: unknown) =>
    typeof v !== "string"
      ? v
      : v === spawnedId
        ? "<spawned>"
        : v === subject && s.action === "create"
          ? "<created>"
          : v;
  const clean = (f: Fields | undefined) =>
    f ? Object.fromEntries(Object.entries(f).map(([k, v]) => [k, swap(v)])) : null;
  return {
    result,
    expected: {
      written: clean(tasks.get(subject)),
      spawned: spawnedId ? clean(tasks.get(spawnedId)) : null,
      activities: [...written("activity").values()].map(clean),
      reminders: [...written("reminder").values()].map(clean),
    },
  };
}

describe("task rule vectors", () => {
  const { scenarios } = fixture<{ scenarios: RuleScenario[] }>("task_rules_vectors.json");
  for (const s of scenarios) {
    it(s.name, () => {
      expect(runRuleScenario(s)).toEqual({ result: s.result, expected: s.expected });
    });
  }
});
