import { describe, expect, it } from "vitest";
import { AtlasClient } from "@atlas/sdk";
import { FakeServer } from "@atlas/sdk/testing";
import { run, USAGE } from "./cli";

/** Run the CLI against a fake server; `connects` counts sign-ins. */
async function atlas(server: FakeServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let connects = 0;
  const code = await run(argv, {
    env: { ATLAS_URL: "http://atlas.test", ATLAS_TOKEN: server.tokenString(), ATLAS_TZ: "UTC" },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    connect: (opts) => {
      connects++;
      return AtlasClient.connect({ ...opts, fetch: server.fetch });
    },
  });
  const json = out.length ? JSON.parse(out.join("\n")) : undefined;
  const error = err.length ? JSON.parse(err[0]!) : undefined;
  return { code, json, error, connects };
}

describe("atlas CLI", () => {
  it("adds, lists, updates, completes and deletes tasks as JSON", async () => {
    const server = new FakeServer();

    const added = await atlas(
      server,
      "tasks",
      "add",
      "--title",
      "Renew passport",
      "--due",
      "2026-11-02",
      "--priority",
      "2",
    );
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ title: "Renew passport", priority: 2 });
    expect(new Date(added.json.due_at).toISOString().slice(0, 10)).toBe("2026-11-02");
    const id = added.json.id as string;

    const fromJson = await atlas(
      server,
      "tasks",
      "add",
      "--json",
      '{"title":"From n8n","notes":"mail body"}',
    );
    expect(fromJson.json).toMatchObject({ title: "From n8n", notes: "mail body" });

    const listed = await atlas(server, "tasks", "list", "--search", "passport");
    expect(listed.json.map((t: { id: string }) => t.id)).toEqual([id]);

    const updated = await atlas(
      server,
      "tasks",
      "update",
      id,
      "--notes",
      "bring photo",
      "--due",
      "none",
    );
    expect(updated.json).toMatchObject({ notes: "bring photo", due_at: null });

    const done = await atlas(server, "tasks", "complete", id);
    expect(done.json.task.is_completed).toBe(true);

    expect((await atlas(server, "tasks", "delete", id)).json).toEqual({ deleted: id });
    expect((await atlas(server, "tasks", "get", id)).json.deleted_at).toEqual(expect.any(Number));
    expect(
      (await atlas(server, "tasks", "list")).json.map((t: { title: string }) => t.title),
    ).toEqual(["From n8n"]);
  });

  it("starts a change feed and reports what changed since its cursor", async () => {
    const server = new FakeServer();
    const start = await atlas(server, "changes");
    expect(start.json).toEqual({ cursor: expect.any(Number) });

    await atlas(server, "tasks", "add", "--title", "New one");
    const changes = await atlas(server, "changes", "--since", String(start.json.cursor));
    expect(changes.json.created.map((t: { title: string }) => t.title)).toEqual(["New one"]);
    expect(changes.json.cursor).toBeGreaterThan(start.json.cursor);
  });

  it("refuses bad usage before signing in", async () => {
    const server = new FakeServer();
    for (const argv of [
      ["tasks", "frobnicate"],
      ["tasks", "complete"],
      ["tasks", "list", "--nope"],
    ]) {
      const result = await atlas(server, ...argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.error.code).toBe("usage");
      expect(result.connects).toBe(0);
    }
    const noTitle = await atlas(server, "tasks", "add", "--notes", "x");
    expect(noTitle.code).toBe(2);
    expect((await atlas(server, "tasks", "add", "--json", "{nope")).code).toBe(2);
  });

  it("reports server and lookup errors as JSON with exit code 1", async () => {
    const server = new FakeServer();
    const unknown = await atlas(server, "tasks", "get", "00000000-0000-4000-8000-000000000000");
    expect(unknown).toMatchObject({ code: 1, error: { code: "unknown_task" } });

    server.revoked = true;
    const revoked = await atlas(server, "projects", "list");
    expect(revoked).toMatchObject({ code: 1, error: { code: "unauthorized", status: 401 } });
  });

  it("needs its configuration from the environment", async () => {
    const err: string[] = [];
    const code = await run(["tasks", "list"], {
      env: {},
      stdout: () => {},
      stderr: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err[0]).toContain("ATLAS_URL");
    const help: string[] = [];
    expect(await run(["--help"], { env: {}, stdout: (t) => help.push(t), stderr: () => {} })).toBe(
      0,
    );
    expect(help[0]).toBe(USAGE);
  });
});
