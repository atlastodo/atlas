import { describe, it, expect } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import { importBundle } from "./dataTransfer";
import {
  parseCsvRows,
  ticktickLegacyIdReusable,
  ticktickToBundle,
  ticktickUuid,
} from "./importTicktick";
import { endOfDay } from "./zonedTime";

/**
 * A miniature of a real TickTick export: the BOM + 3-line preamble (the third spans several
 * physical lines), then the header and rows covering every branch the converter has; a NOTE with
 * markdown/newlines/doubled quotes, kanban columns, a subtask, a completed row, priorities, an
 * all-day due date, a tagged row, a recurring row and an Inbox row.
 */
const CSV = `﻿"Date: 2026-08-02+0000"
"Version: 7.2"
"Status:
0 Normal
-1 Abandoned
2 Completed"
"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId","projectKind"
"","Noter","Note","NOTE","","### Stack
He said ""hi"", then left.","N","","","","","0","0","2026-07-01T11:41:52+0000","","-1099511627776","Europe/Copenhagen",,"false",,,"list","1","","NOTE"
"","Talent","Parent task","TEXT","","","N","","","","","5","0","2026-04-29T12:18:50+0000","","1","",,"false","General small fixes","3","list","8","","TASK"
"","Talent","Child task","TEXT","","body","N","","","","","3","0","2026-05-03T17:56:32+0000","","2","",,"false","General small fixes","3","list","7","8","TASK"
"","Talent","Second column","TEXT","","","N","","","","","1","0","2026-03-16T15:19:40+0000","","1","",,"false","semicolon inference","2","list","9","","TASK"
"","Todo","Done thing","TEXT","","","N","","","","","0","2","2026-04-26T12:40:06+0000","2026-07-01T11:32:41+0000","17","",,"false","Server","1","list","25","","TASK"
"","Todo","Given up","TEXT","","","N","","","","","0","-1","2026-04-26T12:40:06+0000","","18","",,"false","Server","1","list","26","","TASK"
"","Inbox","All day task","TEXT","home, errands","","N","2026-07-22T22:00:00+0000","2026-07-22T22:00:00+0000","","","1","0","2026-07-22T23:11:14+0000","","-28587302322176","Europe/Copenhagen","true","false",,,"list","113","","TASK"
"","Inbox","Weekly thing","TEXT","","","N","","2026-07-24T09:30:00+0000","","RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO","0","0","2026-07-20T19:36:03+0000","","-27487790694400","Europe/Copenhagen","false","false",,,"list","115","","TASK"
`;

function convert(csv = CSV, userId = "alice") {
  return ticktickToBundle(csv, { userId, timeZone: "Europe/Copenhagen", now: 1_754_100_000_000 });
}

/** Every task in the bundle, keyed by title. */
function tasksByTitle(bundle: ReturnType<typeof convert>["bundle"]) {
  const map = new Map<string, Record<string, unknown>>();
  for (const e of bundle.entities.task ?? []) map.set(String(e.fields.title), e.fields);
  return map;
}

describe("parseCsvRows", () => {
  it("handles quotes, doubled quotes, embedded newlines and CRLF", () => {
    const rows = parseCsvRows('a,"b,c","d""e"\r\n"multi\nline",f,\n');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e'],
      ["multi\nline", "f", ""],
    ]);
  });

  it("strips a leading BOM and keeps empty trailing fields", () => {
    expect(parseCsvRows('﻿"x",,')).toEqual([["x", "", ""]]);
  });
});

describe("ticktickToBundle", () => {
  it("skips the preamble and reads every data row", () => {
    const { counts } = convert();
    expect(counts.tasks).toBe(8);
    expect(counts.notes).toBe(1);
  });

  it("maps lists to projects and kanban columns to sections, Inbox to no project", () => {
    const { bundle } = convert();
    const projects = (bundle.entities.project ?? []).map((p) => p.fields.name);
    expect(projects).toEqual(expect.arrayContaining(["Noter", "Talent", "Todo"]));
    expect(projects).not.toContain("Inbox");

    const sections = (bundle.entities.section ?? []).map((s) => s.fields.name);
    expect(sections).toEqual(
      expect.arrayContaining(["General small fixes", "semicolon inference"]),
    );

    const tasks = tasksByTitle(bundle);
    expect(tasks.get("All day task")?.project_id).toBeUndefined();
    expect(tasks.get("Parent task")?.section_id).toBeDefined();
    expect(tasks.get("Done thing")?.section_id).toBeDefined();
  });

  it("orders sections by Column Order and tasks by Order within a bucket", () => {
    const { bundle } = convert();
    const sections = bundle.entities.section ?? [];
    const byName = new Map(sections.map((s) => [String(s.fields.name), s.fields]));
    // "semicolon inference" is Column Order 2, "General small fixes" is 3.
    expect(Number(byName.get("semicolon inference")!.sort_order)).toBeLessThan(
      Number(byName.get("General small fixes")!.sort_order),
    );
    const tasks = tasksByTitle(bundle);
    expect(Number(tasks.get("Parent task")!.sort_order)).toBeLessThan(
      Number(tasks.get("Child task")!.sort_order),
    );
  });

  it("links subtasks to their parent task", () => {
    const { bundle } = convert();
    const byTitle = new Map(
      (bundle.entities.task ?? []).map((e) => [String(e.fields.title), { id: e.id, f: e.fields }]),
    );
    expect(byTitle.get("Child task")!.f.parent_id).toBe(byTitle.get("Parent task")!.id);
    expect(byTitle.get("Parent task")!.f.parent_id).toBeUndefined();
  });

  it("maps TickTick priorities onto the Atlas 1..4 scale", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Parent task")!.priority).toBe(1); // TickTick 5 = High
    expect(tasks.get("Child task")!.priority).toBe(2); // 3 = Medium
    expect(tasks.get("Second column")!.priority).toBe(3); // 1 = Low
    expect(tasks.get("Done thing")!.priority).toBe(4); // 0 = None
  });

  it("maps status: completed keeps its completion time, abandoned is archived", () => {
    const tasks = tasksByTitle(convert().bundle);
    expect(tasks.get("Done thing")!.is_completed).toBe(true);
    expect(tasks.get("Done thing")!.completed_at).toBe(Date.parse("2026-07-01T11:32:41Z"));
    expect(tasks.get("Given up")!.is_completed).toBe(false);
    expect(typeof tasks.get("Given up")!.archived_at).toBe("number");
    expect(convert().counts.completed).toBe(1);
    expect(convert().counts.abandoned).toBe(1);
  });

  it("puts all-day dates at the end of that day in the row's timezone", () => {
    const tasks = tasksByTitle(convert().bundle);
    const exported = Date.parse("2026-07-22T22:00:00Z"); // = 2026-07-23 00:00 in Copenhagen
    expect(tasks.get("All day task")!.due_at).toBe(endOfDay(exported, "Europe/Copenhagen"));
    // A timed date is kept verbatim.
    expect(tasks.get("Weekly thing")!.due_at).toBe(Date.parse("2026-07-24T09:30:00Z"));
  });

  it("carries notes, tags as labels, and a supported recurrence rule", () => {
    const { bundle } = convert();
    const tasks = tasksByTitle(bundle);
    expect(tasks.get("Note")!.notes).toBe('### Stack\nHe said "hi", then left.');
    expect(tasks.get("Child task")!.notes).toBe("body");

    const labels = bundle.entities.label ?? [];
    expect(labels.map((l) => l.fields.name).sort()).toEqual(["errands", "home"]);
    expect(tasks.get("All day task")!.label_ids).toHaveLength(2);

    expect(tasks.get("Weekly thing")!.recurrence).toBe("FREQ=WEEKLY;BYDAY=MO");
  });

  it("gives a monthly rule the due date's day of month", () => {
    const csv = CSV.replace("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", "RRULE:FREQ=MONTHLY");
    expect(tasksByTitle(convert(csv).bundle).get("Weekly thing")!.recurrence).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=24",
    );
  });

  it("warns instead of throwing on an unsupported recurrence rule", () => {
    const csv = CSV.replace("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", "RRULE:FREQ=HOURLY");
    const { bundle, warnings } = ticktickToBundle(csv, {
      userId: "alice",
      timeZone: "UTC",
      now: 0,
    });
    expect(tasksByTitle(bundle).get("Weekly thing")!.recurrence).toBeUndefined();
    expect(warnings.map((w) => w.code)).toContain("repeat");
  });

  it("rejects a file that is not a TickTick export", () => {
    expect(() => ticktickToBundle("a,b\n1,2\n", { userId: "alice" })).toThrow("not-ticktick-csv");
  });

  it("is idempotent: re-importing the same file updates rather than duplicates", () => {
    const store = new LocalStore("test");
    const first = convert();
    importBundle(store, () => {}, first.bundle);
    const afterFirst = store.list("task").length;
    importBundle(store, () => {}, convert().bundle);
    expect(store.list("task")).toHaveLength(afterFirst);
    expect(store.list("project")).toHaveLength(3);
  });

  it("produces a bundle the existing importer accepts, with resolvable links", () => {
    const store = new LocalStore("test");
    const { bundle, counts } = convert();
    const { count } = importBundle(store, () => {}, bundle);
    expect(count).toBe(counts.tasks + counts.projects + counts.sections + counts.labels);

    const projectIds = new Set(store.list("project").map((p) => p.id));
    const sectionIds = new Set(store.list("section").map((s) => s.id));
    const taskIds = new Set(store.list("task").map((t) => t.id));
    for (const t of store.list("task")) {
      const f = t.fields;
      if (f.project_id != null) expect(projectIds.has(String(f.project_id))).toBe(true);
      if (f.section_id != null) expect(sectionIds.has(String(f.section_id))).toBe(true);
      if (f.parent_id != null) expect(taskIds.has(String(f.parent_id))).toBe(true);
    }
    for (const s of store.list("section")) {
      expect(projectIds.has(String(s.fields.project_id))).toBe(true);
    }
  });
});

/** Every entity id in a bundle. */
const allIds = (bundle: ReturnType<typeof convert>["bundle"]) =>
  Object.values(bundle.entities).flatMap((rows) => rows.map((e) => e.id));

describe("ticktickToBundle ids", () => {
  it("are per user: two members importing the same list names share no entity", () => {
    const alice = new Set(allIds(convert(CSV, "alice").bundle));
    const bob = allIds(convert(CSV, "bob").bundle);
    expect(bob.filter((id) => alice.has(id))).toEqual([]);
  });

  it("are stable for one user, so a re-import updates what it created", () => {
    expect(allIds(convert(CSV, "alice").bundle)).toEqual(allIds(convert(CSV, "alice").bundle));
  });

  it("keep an earlier import's ids for what this user holds privately", () => {
    const store = new LocalStore("test");
    const legacyProject = ticktickUuid("project", "Talent");
    const legacyTask = ticktickUuid("task", "8");
    store.set("project", legacyProject, "name", "Talent");
    store.set("task", legacyTask, "title", "Parent task");
    store.set("task", legacyTask, "project_id", legacyProject);

    const { bundle } = ticktickToBundle(CSV, {
      userId: "alice",
      reuseLegacyId: ticktickLegacyIdReusable(store),
    });

    const byTitle = new Map((bundle.entities.task ?? []).map((e) => [e.fields.title, e]));
    expect(byTitle.get("Parent task")!.id).toBe(legacyTask);
    expect(byTitle.get("Child task")!.fields.parent_id).toBe(legacyTask);
    expect(byTitle.get("Parent task")!.fields.project_id).toBe(legacyProject);
    // Nothing else was in the store, so everything else gets the per-user id.
    expect(byTitle.get("Child task")!.id).not.toBe(ticktickUuid("task", "7"));
  });

  it("never land in a shared project through a legacy id", () => {
    const store = new LocalStore("test");
    const legacyProject = ticktickUuid("project", "Talent");
    const legacyTask = ticktickUuid("task", "8");
    store.set("project", legacyProject, "name", "Talent");
    store.set("project_member", "m1", "project_id", legacyProject);
    store.set("project_member", "m1", "state", "active");
    store.set("project_member", "m1", "user_id", "carol");
    store.set("task", legacyTask, "project_id", legacyProject);

    const { bundle } = ticktickToBundle(CSV, {
      userId: "alice",
      reuseLegacyId: ticktickLegacyIdReusable(store),
    });

    const ids = allIds(bundle);
    expect(ids).not.toContain(legacyProject);
    expect(ids).not.toContain(legacyTask);
  });
});

describe("ticktickToBundle bad input", () => {
  it("warns about an unknown time zone and reads its dates in the fallback zone", () => {
    const csv = CSV.replace(
      '"-28587302322176","Europe/Copenhagen","true"',
      '"-28587302322176","Mars/Olympus_Mons","true"',
    );
    const { bundle, warnings } = convert(csv);
    expect(warnings).toContainEqual({ code: "timezone", detail: "Mars/Olympus_Mons" });
    expect(tasksByTitle(bundle).get("All day task")!.due_at).toBe(
      endOfDay(Date.UTC(2026, 6, 22, 22, 0, 0), "Europe/Copenhagen"),
    );
  });

  it("drops dates that do not exist instead of rolling them over", () => {
    for (const bad of [
      "2026-02-30T10:00:00+0000",
      "2026-13-01T10:00:00+0000",
      "2026-07-24T24:00:00+0000",
      "2026-07-24T09:60:00+0000",
      "2026-07-24T09:30:00+2500",
    ]) {
      const csv = CSV.replace('"2026-07-24T09:30:00+0000"', `"${bad}"`);
      expect(tasksByTitle(convert(csv).bundle).get("Weekly thing")!.due_at).toBeUndefined();
    }
  });
});

describe("ticktickUuid", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is a well-formed, stable UUID: the server rejects the whole push otherwise", () => {
    expect(ticktickUuid("task", "113")).toMatch(UUID_RE);
    expect(ticktickUuid("task", "113")).toBe(ticktickUuid("task", "113"));
    expect(ticktickUuid("task", "113")).not.toBe(ticktickUuid("project", "113"));
  });

  it("does not collide across a large id space", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(ticktickUuid("task", String(i)));
    expect(seen.size).toBe(20_000);
  });
});
