import { describe, it, expect } from "vitest";
import { strToU8, zipSync } from "fflate";
import { LocalStore } from "@atlas/client-core";
import { importBundle } from "./dataTransfer";
import {
  parseTodoistDate,
  readTodoistFiles,
  todoistProjectName,
  todoistToBundle,
  type TodoistFile,
} from "./importTodoist";
import { endOfDay, makeInstant } from "./zonedTime";

const ZONE = "Europe/Copenhagen";
// Monday 2026-10-12, 12:00 in Copenhagen.
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);

/**
 * A miniature of a Todoist project export in its CSV template format: a BOM, CRLF line ends, a
 * meta row, tasks before and inside sections, nested subtasks (INDENT), a comment (TYPE=note) with
 * an embedded comma and newline, labels in CONTENT, every priority, fixed and repeating dates, a
 * deadline, a duration and an assignee.
 */
const CSV = [
  "﻿TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG",
  "meta,view_style=board,,,,,,,,,,,,",
  'task,Buy milk @errands @home,"2 litres, semi-skimmed",1,1,Ann (1),,Oct 14,en,Europe/Copenhagen,,,,',
  "task,Weekly review,,2,1,Ann (1),,every friday at 16:00,en,Europe/Copenhagen,30,minute,,",
  'note,"First comment, with a comma',
  'and a second line",,,,Ann (1),,,,,,,,',
  "note,Second comment,,,,Ann (1),,,,,,,,",
  ",,,,,,,,,,,,,",
  "section,Backlog,,,,,,,,,,,,",
  "task,Parent,,3,1,Ann (1),,,,,,,,",
  "task,Child,,4,2,Ann (1),,,,,,,,",
  "task,Grandchild,,,3,Ann (1),,,,,,,,",
  "task,Second child,,4,2,Ann (1),Bob (2),,,,,,,",
  "task,Sibling,,4,1,Ann (1),,every 3rd friday,en,,1,day,2026-10-30,en",
  "task,Deadline only,,4,1,Ann (1),,,,,,,2026-10-30,en",
  "section,Done soon,,,,,,,,,,,,",
  "task,Mail bob@example.com,,4,1,Ann (1),,2026-10-20T09:30:00,en,,,,,",
].join("\r\n");

function convert(files: TodoistFile[] = [{ name: "Work.csv", text: CSV }], userId = "alice") {
  return todoistToBundle(files, { userId, timeZone: ZONE, now: NOW });
}

/** Every task in the bundle, keyed by title. */
function tasksByTitle(bundle: ReturnType<typeof convert>["bundle"]) {
  const map = new Map<string, { id: string; fields: Record<string, unknown> }>();
  for (const e of bundle.entities.task ?? []) map.set(String(e.fields.title), e);
  return map;
}

const at = (y: number, m: number, d: number, h: number, min: number) =>
  makeInstant(y, m - 1, d, h, min, 0, ZONE);
const endOf = (y: number, m: number, d: number) => endOfDay(at(y, m, d, 12, 0), ZONE);

describe("todoistProjectName", () => {
  it("strips the extension, folders and the id the backup appends", () => {
    expect(todoistProjectName("Work.csv")).toBe("Work");
    expect(todoistProjectName("Home Renovation [2203306141].csv")).toBe("Home Renovation");
    expect(todoistProjectName("backup/Side [abc].CSV")).toBe("Side");
  });
});

describe("todoistToBundle", () => {
  it("names the project after the file and keeps its board layout", () => {
    const { bundle, counts } = convert();
    expect(counts.projects).toBe(1);
    expect(bundle.entities.project![0]!.fields).toMatchObject({
      name: "Work",
      kind: "project",
      default_view: "board",
    });
  });

  it("starts a section at each section row; tasks before the first have none", () => {
    const { bundle, counts } = convert();
    const sections = bundle.entities.section ?? [];
    expect(sections.map((s) => [s.fields.name, s.fields.sort_order])).toEqual([
      ["Backlog", 0],
      ["Done soon", 1],
    ]);
    expect(counts.sections).toBe(2);
    const tasks = tasksByTitle(bundle);
    const backlog = sections[0]!.id;
    expect(tasks.get("Buy milk")!.fields.section_id).toBeUndefined();
    expect(tasks.get("Parent")!.fields.section_id).toBe(backlog);
    expect(tasks.get("Grandchild")!.fields.section_id).toBe(backlog);
    expect(tasks.get("Mail bob@example.com")!.fields.section_id).toBe(sections[1]!.id);
  });

  it("nests subtasks by INDENT under the nearest less-indented task", () => {
    const { bundle, counts } = convert();
    const tasks = tasksByTitle(bundle);
    const id = (title: string) => tasks.get(title)!.id;
    const parentOf = (title: string) => tasks.get(title)!.fields.parent_id;
    expect(parentOf("Parent")).toBeUndefined();
    expect(parentOf("Child")).toBe(id("Parent"));
    expect(parentOf("Grandchild")).toBe(id("Child"));
    expect(parentOf("Second child")).toBe(id("Parent"));
    expect(parentOf("Sibling")).toBeUndefined();
    expect(counts.subtasks).toBe(3);
  });

  it("maps Todoist priorities (1 = p1) onto the Atlas 1..4 scale", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Buy milk")!.fields.priority).toBe(1);
    expect(tasks.get("Weekly review")!.fields.priority).toBe(2);
    expect(tasks.get("Parent")!.fields.priority).toBe(3);
    expect(tasks.get("Child")!.fields.priority).toBe(4);
    // An empty priority is no priority.
    expect(tasks.get("Grandchild")!.fields.priority).toBe(4);
  });

  it("turns @words in the content into labels and strips them from the title", () => {
    const { bundle, counts } = convert();
    const tasks = tasksByTitle(bundle);
    const labels = bundle.entities.label ?? [];
    expect(labels.map((l) => l.fields.name)).toEqual(["errands", "home"]);
    expect(counts.labels).toBe(2);
    expect(tasks.get("Buy milk")!.fields.label_ids).toEqual(labels.map((l) => l.id));
    // An address is not a label.
    expect(tasks.get("Mail bob@example.com")!.fields.label_ids).toBeUndefined();
  });

  it("keeps the description as notes and turns note rows into comments in order", () => {
    const { bundle, counts } = convert();
    const tasks = tasksByTitle(bundle);
    expect(tasks.get("Buy milk")!.fields.notes).toBe("2 litres, semi-skimmed");
    const comments = bundle.entities.comment ?? [];
    expect(counts.comments).toBe(2);
    expect(comments.map((c) => c.fields.body)).toEqual([
      "First comment, with a comma\nand a second line",
      "Second comment",
    ]);
    for (const c of comments) {
      expect(c.fields.task_id).toBe(tasks.get("Weekly review")!.id);
      expect(c.fields.author_id).toBe("alice");
    }
    expect(Number(comments[0]!.fields.created_at)).toBeLessThan(
      Number(comments[1]!.fields.created_at),
    );
  });

  it("reads fixed dates: all-day at the end of the day, a time as given", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Buy milk")!.fields.due_at).toBe(endOf(2026, 10, 14));
    expect(tasks.get("Mail bob@example.com")!.fields.due_at).toBe(at(2026, 10, 20, 9, 30));
    expect(tasks.get("Buy milk")!.fields.recurrence).toBeUndefined();
  });

  it("maps a supported repeat onto an Atlas rule starting at its first occurrence", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Weekly review")!.fields).toMatchObject({
      recurrence: "FREQ=WEEKLY;BYDAY=FR",
      due_at: at(2026, 10, 16, 16, 0),
      estimate_min: 30,
    });
  });

  it("imports a task whose repeat is unsupported without it, and says so", () => {
    const { bundle, warnings } = convert();
    const sibling = tasksByTitle(bundle).get("Sibling")!.fields;
    expect(sibling.recurrence).toBeUndefined();
    expect(sibling.due_at).toBeUndefined();
    expect(warnings).toContainEqual({ code: "recurrence", detail: "every 3rd friday" });
  });

  it("uses the deadline as the date only when there is no date", () => {
    const { bundle, warnings } = convert();
    const tasks = tasksByTitle(bundle);
    expect(tasks.get("Deadline only")!.fields.due_at).toBe(endOf(2026, 10, 30));
    expect(warnings).toContainEqual({ code: "deadline" });
  });

  it("reports what it could not carry over", () => {
    const codes = convert().warnings.map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(["recurrence", "deadline", "duration", "assignee"]),
    );
    expect(tasksByTitle(convert().bundle).get("Sibling")!.fields.estimate_min).toBeUndefined();
  });

  it("ranks tasks in file order within each section", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Buy milk")!.fields.sort_order).toBe(0);
    expect(tasks.get("Weekly review")!.fields.sort_order).toBe(1);
    expect(tasks.get("Parent")!.fields.sort_order).toBe(0);
    expect(tasks.get("Child")!.fields.sort_order).toBe(1);
    expect(tasks.get("Mail bob@example.com")!.fields.sort_order).toBe(0);
  });

  it("puts an Inbox export into the project-less Inbox", () => {
    const { bundle, counts } = convert([
      { name: "Inbox [1].csv", text: "TYPE,CONTENT\nsection,Later\ntask,Loose end\n" },
    ]);
    expect(counts.projects).toBe(0);
    expect(counts.sections).toBe(0);
    const task = tasksByTitle(bundle).get("Loose end")!.fields;
    expect(task.project_id).toBeUndefined();
    expect(task.section_id).toBeUndefined();
  });

  it("skips a note with no task above it and counts it", () => {
    const { counts, warnings } = convert([
      { name: "P.csv", text: "TYPE,CONTENT\nnote,About this project\ntask,Only task\n" },
    ]);
    expect(counts.comments).toBe(0);
    expect(counts.tasks).toBe(1);
    expect(warnings).toContainEqual({ code: "projectNote" });
  });

  it("tolerates unknown columns, lowercase headers and missing cells", () => {
    const { bundle } = convert([
      {
        name: "P.csv",
        text: "type,extra,content,priority\ntask,x,Short row\ntask,x,Full,1,more\n",
      },
    ]);
    const tasks = tasksByTitle(bundle);
    expect(tasks.get("Short row")!.fields.priority).toBe(4);
    expect(tasks.get("Full")!.fields.priority).toBe(1);
  });

  it("warns about an unknown time zone and reads the date in the fallback zone", () => {
    const csv = CSV.replace("en,Europe/Copenhagen,,,,", "en,Mars/Olympus_Mons,,,,");
    const { bundle, warnings } = convert([{ name: "Work.csv", text: csv }]);
    expect(warnings).toContainEqual({ code: "timezone", detail: "Mars/Olympus_Mons" });
    expect(tasksByTitle(bundle).get("Buy milk")!.fields.due_at).toBe(endOf(2026, 10, 14));
  });

  it("warns about a date it cannot read and imports the task without it", () => {
    const csv = CSV.replace(",Oct 14,", ",le 14 octobre,");
    const { bundle, warnings } = convert([{ name: "Work.csv", text: csv }]);
    expect(tasksByTitle(bundle).get("Buy milk")!.fields.due_at).toBeUndefined();
    expect(warnings).toContainEqual({ code: "date", detail: "le 14 octobre" });
  });

  it("rejects a file that is not a Todoist export", () => {
    expect(() => convert([{ name: "x.csv", text: "a,b\n1,2\n" }])).toThrow("not-todoist-csv");
  });

  it("produces a bundle the existing importer accepts, with resolvable links", () => {
    const store = new LocalStore("test");
    const { bundle, counts } = convert();
    const { count } = importBundle(store, () => {}, bundle);
    expect(count).toBe(
      counts.tasks + counts.projects + counts.sections + counts.labels + counts.comments,
    );
    const taskIds = new Set(store.list("task").map((t) => t.id));
    const sectionIds = new Set(store.list("section").map((s) => s.id));
    const labelIds = new Set(store.list("label").map((l) => l.id));
    for (const t of store.list("task")) {
      const f = t.fields;
      expect(f.project_id).toBe(store.list("project")[0]!.id);
      if (f.section_id != null) expect(sectionIds.has(String(f.section_id))).toBe(true);
      if (f.parent_id != null) expect(taskIds.has(String(f.parent_id))).toBe(true);
      for (const l of (f.label_ids as string[] | undefined) ?? [])
        expect(labelIds.has(l)).toBe(true);
    }
    for (const c of store.list("comment")) expect(taskIds.has(String(c.fields.task_id))).toBe(true);
  });

  it("is idempotent: re-importing the same file updates rather than duplicates", () => {
    const store = new LocalStore("test");
    importBundle(store, () => {}, convert().bundle);
    const sizes = () =>
      ["task", "project", "section", "label", "comment"].map((k) => store.list(k as "task").length);
    const first = sizes();
    importBundle(store, () => {}, convert().bundle);
    expect(sizes()).toEqual(first);
  });

  it("gives two same-titled tasks distinct ids, and other users other ids", () => {
    const { bundle } = convert([{ name: "P.csv", text: "TYPE,CONTENT\ntask,Same\ntask,Same\n" }]);
    const [a, b] = bundle.entities.task!;
    expect(a!.id).not.toBe(b!.id);
    const bob = convert([{ name: "P.csv", text: "TYPE,CONTENT\ntask,Same\ntask,Same\n" }], "bob");
    expect(bob.bundle.entities.task![0]!.id).not.toBe(a!.id);
  });
});

describe("readTodoistFiles", () => {
  it("decodes a single CSV as UTF-8", () => {
    const files = readTodoistFiles("Café.csv", strToU8("TYPE,CONTENT\ntask,Crème brûlée\n"));
    expect(files).toEqual([{ name: "Café.csv", text: "TYPE,CONTENT\ntask,Crème brûlée\n" }]);
  });

  it("reads every project CSV from a backup zip and skips everything else", () => {
    const zip = zipSync({
      "Work [111].csv": strToU8("TYPE,CONTENT,PRIORITY\ntask,Ship it @deploy,1\n"),
      "Home [222].csv": strToU8("TYPE,CONTENT\nsection,Garden\ntask,Mow\ntask,Edge,,\n"),
      "readme.txt": strToU8("not a project"),
      "__MACOSX/._Work [111].csv": strToU8("\u0000resource fork"),
    });
    const files = readTodoistFiles("Todoist backup.zip", zip);
    expect(files.map((f) => f.name)).toEqual(["Home [222].csv", "Work [111].csv"]);

    const { bundle, counts } = convert(files);
    expect((bundle.entities.project ?? []).map((p) => p.fields.name)).toEqual(["Home", "Work"]);
    expect(counts).toMatchObject({ projects: 2, sections: 1, tasks: 3, labels: 1 });
    const tasks = tasksByTitle(bundle);
    const projectByName = new Map(bundle.entities.project!.map((p) => [p.fields.name, p.id]));
    expect(tasks.get("Ship it")!.fields.project_id).toBe(projectByName.get("Work"));
    expect(tasks.get("Mow")!.fields.project_id).toBe(projectByName.get("Home"));
    expect(tasks.get("Ship it")!.fields.priority).toBe(1);
  });

  it("skips a CSV in the zip that is not a Todoist export and says which", () => {
    const zip = zipSync({
      "Work [1].csv": strToU8("TYPE,CONTENT\ntask,A\n"),
      "other.csv": strToU8("a,b\n1,2\n"),
    });
    const { counts, warnings } = convert(readTodoistFiles("b.zip", zip));
    expect(counts.tasks).toBe(1);
    expect(warnings).toContainEqual({ code: "notTodoist", detail: "other.csv" });
  });

  it("keeps two projects of the same name apart", () => {
    const zip = zipSync({
      "Ideas [1].csv": strToU8("TYPE,CONTENT\ntask,A\n"),
      "Ideas [2].csv": strToU8("TYPE,CONTENT\ntask,A\n"),
    });
    const { bundle } = convert(readTodoistFiles("b.zip", zip));
    const [p1, p2] = bundle.entities.project!;
    expect(p1!.id).not.toBe(p2!.id);
    const [t1, t2] = bundle.entities.task!;
    expect(t1!.id).not.toBe(t2!.id);
  });

  it("rejects a corrupt zip", () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    expect(() => readTodoistFiles("b.zip", bytes)).toThrow("not-todoist-backup");
  });
});

describe("parseTodoistDate", () => {
  const parse = (raw: string) => parseTodoistDate(raw, NOW, ZONE);

  it.each([
    ["Oct 14", endOf(2026, 10, 14)],
    ["14 October", endOf(2026, 10, 14)],
    ["oct 14, 2027", endOf(2027, 10, 14)],
    ["2026-10-14", endOf(2026, 10, 14)],
    // No year: the nearest such date, so an overdue one stays overdue.
    ["Oct 1", endOf(2026, 10, 1)],
    ["Jan 5", endOf(2027, 1, 5)],
    ["today", endOf(2026, 10, 12)],
    ["tomorrow at 9am", at(2026, 10, 13, 9, 0)],
    ["wednesday", endOf(2026, 10, 14)],
    ["next monday", endOf(2026, 10, 19)],
    ["Oct 14 at 5:30pm", at(2026, 10, 14, 17, 30)],
    ["2026-10-14 14:00", at(2026, 10, 14, 14, 0)],
    ["2026-10-14T14:00:00Z", Date.UTC(2026, 9, 14, 14, 0)],
  ])("reads %s", (raw, due) => {
    expect(parse(raw)).toEqual({ dueAt: due });
  });

  it.each([
    ["every day", "FREQ=DAILY", endOf(2026, 10, 12)],
    ["daily", "FREQ=DAILY", endOf(2026, 10, 12)],
    ["every 3 days", "FREQ=DAILY;INTERVAL=3", endOf(2026, 10, 12)],
    ["every! 2 weeks", "FREQ=WEEKLY;INTERVAL=2;MODE=COMPLETION", endOf(2026, 10, 12)],
    ["every other week", "FREQ=WEEKLY;INTERVAL=2", endOf(2026, 10, 12)],
    ["every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", endOf(2026, 10, 12)],
    ["every weekend", "FREQ=WEEKLY;BYDAY=SA,SU", endOf(2026, 10, 17)],
    ["every mon, wed and fri", "FREQ=WEEKLY;BYDAY=MO,WE,FR", endOf(2026, 10, 12)],
    ["every other tuesday", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", endOf(2026, 10, 13)],
    ["every day at 9am", "FREQ=DAILY", at(2026, 10, 12, 9, 0)],
    ["every month", "FREQ=MONTHLY;BYMONTHDAY=12", endOf(2026, 10, 12)],
    ["every 15th", "FREQ=MONTHLY;BYMONTHDAY=15", endOf(2026, 10, 15)],
    ["every 1st", "FREQ=MONTHLY;BYMONTHDAY=1", endOf(2026, 11, 1)],
    ["every 2 months", "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=12", endOf(2026, 10, 12)],
    ["every year", "FREQ=YEARLY", endOf(2026, 10, 12)],
    ["every jan 5", "FREQ=YEARLY", endOf(2027, 1, 5)],
    ["every day starting oct 20", "FREQ=DAILY", endOf(2026, 10, 20)],
  ])("maps %s", (raw, recurrence, due) => {
    expect(parse(raw)).toEqual({ dueAt: due, recurrence });
  });

  it.each([
    "every 2nd monday",
    "every last day",
    "every hour",
    "every day until dec 1",
    "every day for 3 weeks",
    "every constructor",
  ])("refuses the repeat %s", (raw) => {
    expect(parse(raw)).toEqual({ unsupported: "recurrence" });
  });

  it.each(["someday", "Feb 30 2026", "2026-13-01", "Oct 14 at 25:00", "constructor 5"])(
    "refuses the date %s",
    (raw) => {
      expect(parse(raw)).toEqual({ unsupported: "date" });
    },
  );

  it("returns null for no date", () => {
    expect(parse("  ")).toBeNull();
  });
});
