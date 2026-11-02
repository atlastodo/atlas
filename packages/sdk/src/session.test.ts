import { describe, expect, it } from "vitest";
import { registerApp, resolveScope, type AppDefinition } from "@atlastodo/client-core";
import vectors from "../../../test-vectors/scope_rule_vectors.json";
import { TokenSession } from "./session";
import { FakeServer } from "./testing";

// The test app of scope_rule_vectors.json: kinds (`vector_note`) core has no code for.
registerApp(vectors.definition as unknown as AppDefinition);

async function connect(server: FakeServer): Promise<TokenSession> {
  return TokenSession.connect({
    serverUrl: "http://atlas.test/",
    token: server.tokenString(),
    fetch: server.fetch,
  });
}

describe("TokenSession", () => {
  it("syncs a kind only an app definition names, sealed, to another device", async () => {
    const server = new FakeServer();
    const a = await connect(server);
    const task = a.store.newEntityId();
    const comment = a.store.newEntityId();
    const note = a.store.newEntityId();
    a.store.set("task", task, "title", "Plan");
    a.store.set("comment", comment, "task_id", task);
    a.store.set("vector_note", note, "comment_id", comment);
    a.store.set("vector_note", note, "body", "Remember the milk");
    await a.push();

    // The server sees the app's sealed wire kind only: not the kind, a field name or a value.
    expect(server.ops.every((o) => o.entity === "todo.sealed")).toBe(true);
    expect(JSON.stringify(server.ops)).not.toMatch(/vector_note|Remember the milk|comment_id/);

    const b = await connect(server);
    expect(b.store.get("vector_note", note)).toMatchObject({
      comment_id: comment,
      body: "Remember the milk",
    });
    expect(resolveScope(b.store, "vector_note", note)).toEqual({ kind: "personal" });
    a.close();
    b.close();
  });
});
