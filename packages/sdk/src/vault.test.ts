import { describe, expect, it } from "vitest";
import {
  ApiError,
  ServerIncompatibleError,
  Keyring,
  openSealed,
  type FieldEnvelopeV3,
  isEncryptedEnvelope,
} from "@atlastodo/client-core";
import { AtlasError } from "./client";
import { FakeServer } from "./testing";
import { VaultClient } from "./vault";

function vaultServer(opts: { write?: boolean; apps?: string[]; offers?: string[] } = {}) {
  return new FakeServer({
    apps: opts.apps ?? ["vault"],
    offers: opts.offers ?? ["todo", "vault"],
    write: opts.write,
    expiresAt: 1_800_000_000_000,
  });
}

const connect = (server: FakeServer) =>
  VaultClient.connect({
    serverUrl: "http://atlas.test",
    token: server.tokenString(),
    fetch: server.fetch,
  });

async function code(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof AtlasError) return e.code;
    if (e instanceof ApiError)
      return ((e.data as { code?: string } | undefined)?.code ?? "") as string;
    if (e instanceof ServerIncompatibleError) return "server_incompatible";
    throw e;
  }
  throw new Error("no error");
}

describe("VaultClient", () => {
  it("writes items only the vault key opens, and reads secrets back by name", async () => {
    const server = vaultServer();
    const vault = await connect(server);
    expect(vault.canWrite).toBe(true);
    expect(vault.expiresAt).toBe(1_800_000_000_000);

    const folder = await vault.createFolder(" CI ");
    expect(folder.name).toBe("CI");
    const item = await vault.createItem({
      type: "api_key",
      name: "Deploy key",
      folder: "ci",
      fields: [{ name: "token", kind: "hidden", value: "sk_live_secret" }],
      urls: ["https://deploy.example"],
    });
    expect(item.folder).toBe(folder.id);
    expect(item.folder_name).toBe("CI");

    // Only ciphertext, every sync request scoped to the vault, every value under the vault key.
    expect(server.syncApps.every((a) => a === "vault")).toBe(true);
    const raw = JSON.stringify(server.ops);
    for (const plain of ["sk_live_secret", "Deploy key", "api_key", "deploy.example"]) {
      expect(raw).not.toContain(plain);
    }
    const { appKey } = server.appKeys.vault!;
    for (const op of server.ops) {
      expect(op.entity).toBe("vault.sealed");
      expect(op.scope ?? null).toBeNull();
      if (op.op !== "set") continue;
      expect(isEncryptedEnvelope(op.value)).toBe(true);
      const opened = (key: Uint8Array) =>
        openSealed(
          new Keyring({ dek: key }),
          op.entity,
          op.entity_id,
          op.field,
          null,
          op.value as FieldEnvelopeV3,
        );
      expect(opened(appKey)?.kind.startsWith("vault.")).toBe(true);
      expect(opened(server.keys.dek)).toBeNull();
    }

    const other = await connect(server);
    expect(other.secret("deploy KEY", "TOKEN")).toBe("sk_live_secret");
    expect(JSON.stringify(other.items())).not.toContain("sk_live_secret");
    expect(other.items({ folder: "CI" })).toHaveLength(1);
    expect(other.items({ search: "EXAMPLE" })).toHaveLength(1);
    expect(other.items({ type: "login" })).toHaveLength(0);
    expect(await code(() => other.items({ type: "wifi" }))).toBe("bad_input");
    expect(await code(() => other.secret("Deploy key", "password"))).toBe("unknown_vault_field");

    const rotated = await other.updateItem("Deploy key", {
      set_fields: [{ name: "token", value: "sk_live_new" }],
    });
    expect(rotated.history.map((h) => h.value)).toEqual(["sk_live_secret"]);
    await other.deleteItem(item.id);
    expect(other.items()).toEqual([]);
    expect(await code(() => other.item("Deploy key"))).toBe("unknown_vault_item");
    vault.close();
    other.close();
  });

  it("refuses a read-only token's writes before pushing", async () => {
    const server = vaultServer();
    const writer = await connect(server);
    await writer.createItem({
      name: "DB",
      fields: [{ name: "password", kind: "hidden", value: "pw" }],
    });
    server.write = false;
    const reader = await connect(server);
    expect(reader.canWrite).toBe(false);
    expect(reader.secret("db", "password")).toBe("pw");
    const pushed = server.ops.length;
    expect(await code(reader.createItem({ name: "x" }))).toBe("api_token_read_only");
    expect(await code(reader.updateItem("DB", { notes: "x" }))).toBe("api_token_read_only");
    expect(await code(reader.deleteItem("DB"))).toBe("api_token_read_only");
    expect(await code(reader.createFolder("x"))).toBe("api_token_read_only");
    expect(server.ops.length).toBe(pushed);
    writer.close();
    reader.close();
  });

  it("is refused clearly for an expired token, a token without the vault, or a server without it", async () => {
    const expired = vaultServer();
    expired.expired = true;
    expect(await code(connect(expired))).toBe("api_token_expired");
    expect(await code(connect(vaultServer({ apps: ["todo"] })))).toBe("app_not_in_token");
    expect(await code(connect(vaultServer({ offers: ["todo"] })))).toBe("server_incompatible");
  });
});
