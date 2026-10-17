import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, SYNC_APPS_HEADER, type AccountAppView } from "./api";
import { RootKeyRequiredError, buildAppKey, enableApp, openAppKey, todoAppKeyRow } from "./rootKey";
import {
  generateAccountId,
  generateDek,
  generateRootKey,
  generateUserKeypair,
  getPublicKey,
  unwrapAppKey,
} from "./crypto";
import type { AppKeyRow, RootKeyResponse } from "./types";

const journalView: AccountAppView = {
  id: "journal",
  name: "Atlas Journal",
  version: 1,
  enabled: true,
  enabled_at: 1,
};

function account() {
  const userId = generateAccountId();
  const rootKey = generateRootKey();
  const keypair = generateUserKeypair();
  const todo = todoAppKeyRow(rootKey, userId, {
    dek: generateDek(),
    privateKey: keypair.secretKey,
  });
  return { userId, rootKey, todo };
}

/** A fake server holding the account's app key rows, set once like `PUT /auth/app-keys/:app`. */
function server(initial: AppKeyRow[]) {
  const rows = [...initial];
  const enabled = new Set<string>(["todo"]);
  const api = {
    putAppKey: vi.fn(async (app: string, wrapped: Omit<AppKeyRow, "app">) => {
      if (rows.some((r) => r.app === app)) {
        throw new ApiError(409, "exists", { code: "key_already_stored" });
      }
      rows.push({ app, ...wrapped });
    }),
    getRootKey: vi.fn(async (): Promise<RootKeyResponse> => ({
      has_root_key: true,
      encrypted_root_key: null,
      has_recovery_root_key: true,
      recovery_public_key: null,
      app_keys: [...rows],
    })),
    enableAccountApp: vi.fn(async (app: string) => {
      enabled.add(app);
      return { ...journalView, id: app };
    }),
  };
  return { api, rows, enabled };
}

describe("enableApp", () => {
  it("creates the app key and identity under the root, then enables the app", async () => {
    const acct = account();
    const { api, rows, enabled } = server([acct.todo]);
    const out = await enableApp(api, {
      userId: acct.userId,
      rootKey: acct.rootKey,
      app: "journal",
      state: { hasRootKey: true, appKeys: [acct.todo] },
    });
    expect(api.putAppKey).toHaveBeenCalledTimes(1);
    expect(api.putAppKey.mock.invocationCallOrder[0]!).toBeLessThan(
      api.enableAccountApp.mock.invocationCallOrder[0]!,
    );
    expect(enabled.has("journal")).toBe(true);
    expect(out.app.enabled).toBe(true);
    const row = rows.find((r) => r.app === "journal")!;
    expect(unwrapAppKey(row.wrapped_key, acct.rootKey, acct.userId, "journal")).toEqual(
      out.keys.appKey,
    );
    expect(out.keys.publicKey).toBe(getPublicKey(out.keys.privateKey));
    expect(out.state.appKeys!.map((k) => k.app)).toEqual(["todo", "journal"]);
    // The journal key is not the todo key, nor openable as it.
    expect(() => unwrapAppKey(row.wrapped_key, acct.rootKey, acct.userId, "todo")).toThrow();

    // Again with the updated state: the stored key is opened, nothing is written twice.
    const again = await enableApp(api, {
      userId: acct.userId,
      rootKey: acct.rootKey,
      app: "journal",
      state: out.state,
    });
    expect(api.putAppKey).toHaveBeenCalledTimes(1);
    expect(again.keys.appKey).toEqual(out.keys.appKey);
    expect(again.keys.privateKey).toEqual(out.keys.privateKey);
  });

  it("loads the winner's key when another device keyed the app first", async () => {
    const acct = account();
    const winner = buildAppKey(acct.rootKey, acct.userId, "journal");
    const { api } = server([acct.todo, winner.row]);
    // This device's state predates the other device's write.
    const out = await enableApp(api, {
      userId: acct.userId,
      rootKey: acct.rootKey,
      app: "journal",
      state: { hasRootKey: true, appKeys: [acct.todo] },
    });
    expect(api.putAppKey).toHaveBeenCalledTimes(1);
    expect(api.getRootKey).toHaveBeenCalledTimes(1);
    expect(out.keys.appKey).toEqual(winner.keys.appKey);
    expect(out.keys.privateKey).toEqual(winner.keys.privateKey);
    expect(out.state.appKeys!.find((k) => k.app === "journal")).toEqual(winner.row);
    expect(api.enableAccountApp).toHaveBeenCalledWith("journal");
  });

  it("two devices racing end up with one key", async () => {
    const acct = account();
    const { api, rows } = server([acct.todo]);
    const input = {
      userId: acct.userId,
      rootKey: acct.rootKey,
      app: "journal",
      state: { hasRootKey: true, appKeys: [acct.todo] },
    };
    const [a, b] = await Promise.all([enableApp(api, input), enableApp(api, input)]);
    expect(rows.filter((r) => r.app === "journal")).toHaveLength(1);
    expect(a.keys.appKey).toEqual(b.keys.appKey);
  });

  it("needs the root key: an unmigrated account migrates first", async () => {
    const acct = account();
    const { api } = server([acct.todo]);
    await expect(
      enableApp(api, { userId: acct.userId, rootKey: null, app: "journal" }),
    ).rejects.toBeInstanceOf(RootKeyRequiredError);
    await expect(
      enableApp(api, {
        userId: acct.userId,
        rootKey: acct.rootKey,
        app: "journal",
        state: { hasRootKey: false },
      }),
    ).rejects.toBeInstanceOf(RootKeyRequiredError);
    expect(api.putAppKey).not.toHaveBeenCalled();
    expect(api.enableAccountApp).not.toHaveBeenCalled();
  });

  it("refuses todo, whose key is the DEK", async () => {
    const acct = account();
    const { api } = server([acct.todo]);
    await expect(
      enableApp(api, { userId: acct.userId, rootKey: acct.rootKey, app: "todo" }),
    ).rejects.toThrow(/DEK/);
  });

  it("does not enable an app whose key write failed", async () => {
    const acct = account();
    const { api } = server([acct.todo]);
    api.putAppKey.mockRejectedValueOnce(new ApiError(500, "boom"));
    await expect(
      enableApp(api, { userId: acct.userId, rootKey: acct.rootKey, app: "journal" }),
    ).rejects.toThrow("boom");
    expect(api.enableAccountApp).not.toHaveBeenCalled();
  });

  it("a stored key under another root does not open", () => {
    const acct = account();
    const other = buildAppKey(generateRootKey(), acct.userId, "journal");
    expect(() => openAppKey(acct.rootKey, acct.userId, "journal", [other.row])).toThrow();
    expect(() => openAppKey(acct.rootKey, acct.userId, "journal", [])).toThrow(/no journal/);
  });
});

describe("app-scoped sync requests", () => {
  function client(apps?: readonly string[]) {
    const seen: Record<string, string>[] = [];
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return new Response(JSON.stringify({ apps: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const api = new ApiClient({
      baseUrl: "https://atlas.example",
      token: "t",
      fetch: fetch as unknown as typeof globalThis.fetch,
      apps,
    });
    return { api, seen };
  }

  it("names the client's apps on every request", async () => {
    const { api, seen } = client(["journal"]);
    await api.listAccountApps();
    expect(seen[0]![SYNC_APPS_HEADER]).toBe("journal");
    expect(seen[0]!["x-atlas-sync-protocol"]).toBeDefined();
  });

  it("sorts and deduplicates the scope", async () => {
    const { api, seen } = client(["todo", "journal", "todo"]);
    await api.listAccountApps();
    expect(seen[0]![SYNC_APPS_HEADER]).toBe("journal,todo");
  });

  it("sends no scope by default, so the server treats the client as todo", async () => {
    const { api, seen } = client();
    await api.listAccountApps();
    expect(seen[0]![SYNC_APPS_HEADER]).toBeUndefined();
  });

  it("refuses an empty scope", () => {
    expect(() => client([])).toThrow(/at least one app/);
  });
});
