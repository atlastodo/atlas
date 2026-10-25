import { describe, expect, it } from "vitest";
import { type FetchLike } from "@atlastodo/client-core";
import { createTask as appCreateTask, projectCreateFields } from "@atlastodo/shared";
import { AtlasClient, AtlasError } from "./client";
import { parseDue } from "./dates";
import { FakeServer, USER_ID } from "./testing";

const TZ = "Europe/Copenhagen";

async function connect(server: FakeServer): Promise<AtlasClient> {
  return AtlasClient.connect({
    serverUrl: "http://atlas.test/",
    token: server.tokenString(),
    fetch: server.fetch,
    timeZone: TZ,
  });
}

describe("AtlasClient", () => {
  it("creates a task the server only holds as ciphertext, and another client reads", async () => {
    const server = new FakeServer();
    const atlas = await connect(server);

    const task = await atlas.createTask({ title: "Water the plants", priority: 2 });
    expect(task).toMatchObject({ title: "Water the plants", priority: 2, is_completed: false });

    // Wire kinds, tags and sealed values only: neither the kind, a field name nor the title.
    expect(server.ops.length).toBeGreaterThan(0);
    expect(server.ops.every((o) => o.entity === "todo.sealed")).toBe(true);
    expect(JSON.stringify(server.ops)).not.toMatch(/Water the plants|"title"|"task"/);

    const app = await server.appDevice();
    expect(app.store.get("task", task.id)?.title).toBe("Water the plants");
    atlas.close();
  });

  it("lists, filters, updates and completes the app's tasks", async () => {
    const server = new FakeServer();
    const app = await server.appDevice();
    const projectId = app.store.newEntityId();
    for (const [field, value] of Object.entries(
      projectCreateFields({ name: "Work", owner_id: USER_ID } as never),
    )) {
      app.store.set("project", projectId, field, value);
    }
    appCreateTask(app.store, { title: "Ship it", project_id: projectId, priority: 1 });
    appCreateTask(app.store, { title: "Buy milk" });
    await app.sync.sync();

    const atlas = await connect(server);
    expect(atlas.projects().map((p) => p.name)).toEqual(["Work"]);
    expect(
      atlas
        .tasks()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["Buy milk", "Ship it"]);
    const [ship] = atlas.tasks({ project: "work" });
    expect(ship).toMatchObject({ title: "Ship it", project_name: "Work" });
    expect(atlas.tasks({ filter: "p1" }).map((t) => t.title)).toEqual(["Ship it"]);
    expect(atlas.tasks({ search: "MILK" }).map((t) => t.title)).toEqual(["Buy milk"]);
    expect(() => atlas.tasks({ project: "Nope" })).toThrow(AtlasError);

    const updated = await atlas.updateTask(ship!.id, { notes: "friday", priority: 3 });
    expect(updated).toMatchObject({ notes: "friday", priority: 3 });

    const { task, next } = await atlas.completeTask(ship!.id);
    expect(task.is_completed).toBe(true);
    expect(next).toBeNull();
    expect(atlas.tasks().map((t) => t.title)).toEqual(["Buy milk"]);
    expect(atlas.tasks({ status: "completed" }).map((t) => t.title)).toEqual(["Ship it"]);

    await app.sync.sync();
    expect(app.store.get("task", ship!.id)).toMatchObject({ is_completed: true, notes: "friday" });
  });

  it("completing a recurring task spawns the next occurrence, as in the app", async () => {
    const server = new FakeServer();
    const atlas = await connect(server);
    const due = parseDue("2026-10-13", TZ)!;
    const task = await atlas.createTask({
      title: "Stand-up",
      due_at: due,
      recurrence: "FREQ=DAILY",
    });

    const { next } = await atlas.completeTask(task.id);
    expect(next).toMatchObject({
      title: "Stand-up",
      recurrence: "FREQ=DAILY",
      is_completed: false,
    });
    expect(next!.due_at!).toBeGreaterThan(due);
  });

  it("quick-adds with the app's syntax", async () => {
    const server = new FakeServer();
    const app = await server.appDevice();
    const projectId = app.store.newEntityId();
    for (const [field, value] of Object.entries(
      projectCreateFields({ name: "Home", owner_id: USER_ID } as never),
    )) {
      app.store.set("project", projectId, field, value);
    }
    await app.sync.sync();
    const atlas = await connect(server);

    const task = await atlas.quickAdd("Pay rent tomorrow #Home p1");
    expect(task).toMatchObject({ title: "Pay rent", priority: 1, project_name: "Home" });
    expect(task.due_at).not.toBeNull();
  });

  it("reports what changed since a cursor", async () => {
    const server = new FakeServer();
    const app = await server.appDevice();
    const doneId = appCreateTask(app.store, { title: "Will be done" });
    const editId = appCreateTask(app.store, { title: "Will be edited" });
    const goneId = appCreateTask(app.store, { title: "Will be trashed" });
    await app.sync.sync();

    const atlas = await connect(server);
    const since = atlas.cursor();
    expect(await atlas.changes(since)).toMatchObject({
      created: [],
      updated: [],
      completed: [],
      deleted: [],
    });

    const newId = appCreateTask(app.store, { title: "Brand new" });
    app.store.set("task", doneId, "is_completed", true);
    app.store.set("task", editId, "title", "Was edited");
    app.store.set("task", goneId, "deleted_at", Date.now());
    await app.sync.sync();

    const changes = await atlas.changes(since);
    expect(changes.created.map((t) => t.id)).toEqual([newId]);
    expect(changes.completed.map((t) => t.id)).toEqual([doneId]);
    expect(changes.updated.map((t) => (t as { title: string }).title)).toEqual(["Was edited"]);
    expect(changes.deleted.map((t) => t.id)).toEqual([goneId]);
    expect(changes.cursor).toBeGreaterThan(since);
    expect(await atlas.changes(changes.cursor)).toMatchObject({ created: [], updated: [] });
  });

  it("opens a new session when the access token is refused", async () => {
    const server = new FakeServer();
    // The first access token stops working after connect, as an expired one would.
    let expired = false;
    const fetch: FetchLike = async (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      const exchange = String(url).endsWith("/auth/api-token/session");
      if (expired && !exchange && auth === "Bearer access-1") {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return server.fetch(url, init);
    };
    const atlas = await AtlasClient.connect({
      serverUrl: "http://atlas.test",
      token: server.tokenString(),
      fetch,
    });
    expired = true;

    await atlas.createTask({ title: "after expiry" });

    expect(server.sessions).toBe(2);
    expect(server.ops.some((o) => o.op === "set" && o.entity === "todo.sealed")).toBe(true);
  });

  it("refuses a malformed or revoked token", async () => {
    const server = new FakeServer();
    await expect(
      AtlasClient.connect({ serverUrl: "http://x", token: "nope", fetch: server.fetch }),
    ).rejects.toThrow("not an Atlas API token");
    server.revoked = true;
    await expect(connect(server)).rejects.toMatchObject({ status: 401 });
  });
});

describe("parseDue", () => {
  const now = Date.UTC(2026, 9, 13, 10, 0, 0);

  it("reads the forms integrations send", () => {
    expect(parseDue(null)).toBeNull();
    expect(parseDue("none")).toBeNull();
    expect(parseDue(" ")).toBeNull();
    expect(parseDue(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(parseDue("1800000000000")).toBe(1_800_000_000_000);
    expect(parseDue("2026-10-13T08:00:00Z")).toBe(Date.UTC(2026, 9, 13, 8));
    // A wall time is in the given zone (Copenhagen is UTC+2 in October).
    expect(parseDue("2026-10-13T09:30", TZ)).toBe(Date.UTC(2026, 9, 13, 7, 30));
    // A day is that day in the zone, at the app's default due time.
    const day = parseDue("2026-10-14", TZ)!;
    expect(new Date(day).toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(parseDue("tomorrow", TZ, now)).toBe(day);
  });

  it("refuses what it cannot read", () => {
    expect(() => parseDue("next blursday")).toThrow(AtlasError);
    expect(() => parseDue("2026-13-45T99:99")).toThrow();
  });
});
