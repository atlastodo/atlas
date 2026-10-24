/**
 * Atlas Journal's kinds through the store and the wire, as a journal client syncs them: a
 * journal-scoped session (`x-atlas-sync-apps: journal`) whose keyring holds the journal app key in
 * the DEK's role. Every field is a personal-scope envelope under that key, bound to the kind, so
 * neither the todo key nor another kind's location opens it.
 */
import { describe, expect, it } from "vitest";
import { ApiClient, fromEncryptedWire, toEncryptedWire, type FetchLike } from "./api";
import { Keyring, generateDek } from "./crypto";
import { resolveScope } from "./scope";
import { openSealed } from "./wire";
import type { FieldEnvelopeV3 } from "./crypto";
import { LocalStore } from "./store";
import { JOURNAL_APP, buildAppKey, generateRootKey } from "./index";
import type { EntityKind, Operation } from "./types";

const entry: EntityKind = "journal.entry";

function journalKeyring(): Keyring {
  const { keys } = buildAppKey(
    generateRootKey(),
    "00000000-0000-4000-8000-000000000001",
    JOURNAL_APP,
  );
  return new Keyring({ dek: keys.appKey, privateKey: keys.privateKey, publicKey: keys.publicKey });
}

describe("journal kinds", () => {
  it("are personal scope, whatever their fields say", () => {
    const store = new LocalStore("device");
    store.set(entry, "e1", "project_id", "p1");
    expect(resolveScope(store, entry, "e1")).toEqual({ kind: "personal" });
    expect(resolveScope(store, "journal.preference", "x")).toEqual({ kind: "personal" });
  });

  it("encrypt every field under the journal key, bound to the kind", () => {
    const keyring = journalKeyring();
    const op: Operation = {
      id: "op-1",
      entity: entry,
      entityId: "e1",
      ts: { wallMs: 1, counter: 0, node: "n" },
      op: "set",
      field: "tags",
      value: ["walks", "sea"],
    };
    const wire = toEncryptedWire(op, keyring, null);
    expect(wire).toMatchObject({
      entity: "journal.sealed",
      scope: null,
      value: { __enc: 3, kid: "dek" },
    });
    expect(JSON.stringify(wire)).not.toMatch(/walks|tags|journal\.entry/);
    expect(fromEncryptedWire(wire, keyring, null)).toEqual(op);

    const value = (wire as { value: FieldEnvelopeV3 }).value;
    const tag = (wire as { field: string }).field;
    const opened = (k: Keyring, wireKind: string) =>
      openSealed(k, wireKind, "e1", tag, null, value);
    expect(opened(keyring, "journal.sealed")?.value).toEqual(["walks", "sea"]);
    expect(opened(keyring, "journal.sealed")?.kind).toBe("journal.entry");
    // Not as another wire kind, and not with the todo key (the account's DEK).
    expect(opened(keyring, "todo.sealed")).toBeNull();
    expect(opened(new Keyring({ dek: generateDek() }), "journal.sealed")).toBeNull();
  });

  it("push and pull in a journal-scoped session", async () => {
    const sent: { headers: Headers; body?: string; url: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: init?.body as string,
      });
      const body = String(url).includes("/sync/push")
        ? { cursor: 1, applied: 1 }
        : { cursor: 1, operations: JSON.parse(sent[0]!.body!).operations };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const api = new ApiClient({ baseUrl: "https://atlas.test", fetch, apps: [JOURNAL_APP] });
    api.setKeyring(journalKeyring());
    api.setLegacyMigrated(true);
    const op: Operation = {
      id: "op-1",
      entity: entry,
      entityId: "e1",
      ts: { wallMs: 1, counter: 0, node: "n" },
      op: "set",
      field: "body",
      value: "Fog over the water.",
    };
    await api.syncPush([op]);
    const pulled = await api.syncPull(0);
    expect(pulled.operations).toEqual([op]);
    expect(pulled.repairs).toEqual([]);
    expect(sent.map((r) => r.headers.get("x-atlas-sync-apps"))).toEqual(["journal", "journal"]);
  });
});
