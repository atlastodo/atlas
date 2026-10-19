import {
  ApiClient,
  LocalStore,
  SyncClient,
  Keyring,
  SYNC_APPS_HEADER,
  appOfKind,
  deriveApiTokenKeys,
  formatApiToken,
  generateApiToken,
  randomBytes,
  wrapAppKeysForApiToken,
  wrapKeysForApiToken,
  type FetchLike,
  type WireOp,
} from "@atlastodo/client-core";

export const USER_ID = "01920000-0000-7000-8000-0000000000aa";

export interface FakeServerOptions {
  /** The apps the token is for; todo by default. */
  apps?: readonly string[];
  /** The apps `GET /discovery` offers; without it the server predates discovery (404). */
  offers?: readonly string[];
  /** Whether the token may write (`write` of the session); a push is 403 when it may not. */
  write?: boolean;
  /** The token's `expires_at` (unix ms) in the session response. */
  expiresAt?: number;
}

/**
 * A stand-in for the server's sync surface: one account's op log, kept as the opaque wire ops the
 * clients push (ciphertext), like the real server. Enough of the API for the SDK and an app-like
 * second client.
 *
 * Its token is for todo unless made for other `apps`, each with a fresh key and identity. Sync
 * requests are scoped as the server scopes a token session (`x-atlas-sync-apps`, todo when
 * absent): an app the token is not for is 403 `app_not_enabled`, pull and the snapshot serve only
 * the scope's ops. A read-only token's push is 403 `api_token_read_only`; once {@link expired},
 * the exchange and every request are 401 `api_token_expired`.
 */
export class FakeServer {
  readonly ops: (WireOp & { seq: number })[] = [];
  private seq = 0;
  readonly token = generateApiToken();
  readonly keys = { dek: randomBytes(32), privateKey: randomBytes(32) };
  readonly apps: readonly string[];
  /** Every other app's key and X25519 private key, by app. */
  readonly appKeys: Record<string, { appKey: Uint8Array; privateKey: Uint8Array }> = {};
  sessions = 0;
  revoked = false;
  expired = false;
  write: boolean;
  /** The `x-atlas-sync-apps` header of every `/sync/*` request (null when absent). */
  readonly syncApps: (string | null)[] = [];

  constructor(private readonly opts: FakeServerOptions = {}) {
    this.apps = opts.apps ?? ["todo"];
    this.write = opts.write ?? true;
    for (const app of this.apps) {
      if (app !== "todo")
        this.appKeys[app] = { appKey: randomBytes(32), privateKey: randomBytes(32) };
    }
  }

  tokenString(): string {
    return formatApiToken(this.token);
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, data: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });
    const headers = (init?.headers as Record<string, string> | undefined) ?? {};
    const authed = headers.authorization;
    const expired = () =>
      json(401, { error: "this API token has expired", code: "api_token_expired" });
    switch (`${init?.method} ${u.pathname}`) {
      case "GET /discovery": {
        if (!this.opts.offers) return json(404, { error: "not found" });
        return json(200, {
          service: "atlas-server",
          version: "0.2.0",
          protocol_version: 6,
          min_protocol_version: 6,
          capabilities: [
            "api_tokens",
            "app_manifests",
            "account_apps",
            "root_key",
            "app_scoped_sync",
            "app_scoped_api_tokens",
            "api_token_policies",
          ],
          apps: this.opts.offers.map((id) => ({ id, name: id, version: 1 })),
        });
      }
      case "POST /auth/api-token/session": {
        if (
          this.revoked ||
          body.token_id !== this.token.id ||
          body.auth !== deriveApiTokenKeys(this.token).auth
        ) {
          return json(401, { error: "unauthorized" });
        }
        if (this.expired) return expired();
        this.sessions++;
        const appKeys = Object.fromEntries(
          Object.entries(this.appKeys).map(([app, keys]) => [
            app,
            wrapAppKeysForApiToken(this.token, USER_ID, app, keys),
          ]),
        );
        return json(200, {
          access_token: `access-${this.sessions}`,
          expires_in: 900,
          token_id: this.token.id,
          user_id: USER_ID,
          apps: this.apps,
          write: this.write,
          ...(this.opts.expiresAt !== undefined ? { expires_at: this.opts.expiresAt } : {}),
          ...(this.apps.includes("todo")
            ? wrapKeysForApiToken(this.token, USER_ID, this.keys)
            : {}),
          ...(Object.keys(appKeys).length ? { app_keys: appKeys } : {}),
        });
      }
    }
    if (this.revoked || !authed?.startsWith("Bearer ")) return json(401, { error: "unauthorized" });
    if (this.expired) return expired();
    const scopeHeader = headers[SYNC_APPS_HEADER] ?? null;
    const scope = scopeHeader ? scopeHeader.split(",").map((a) => a.trim()) : ["todo"];
    const inScope = (op: WireOp) => scope.includes(appOfKind(op.entity)?.app ?? "");
    if (u.pathname.startsWith("/sync/")) {
      this.syncApps.push(scopeHeader);
      const outside = scope.find((a) => !this.apps.includes(a));
      if (outside) {
        return json(403, { code: "app_not_enabled", app: outside, scope: "token", error: "no" });
      }
    }
    switch (`${init?.method} ${u.pathname}`) {
      case "GET /sync/snapshot":
        return json(200, { operations: this.ops.filter(inScope), cursor: this.seq });
      case "GET /sync/pull": {
        const since = Number(u.searchParams.get("since"));
        const page = this.ops.filter((o) => o.seq > since).slice(0, 500);
        return json(200, {
          operations: page.filter(inScope),
          from: since,
          cursor: page.length ? page[page.length - 1]!.seq : Math.max(since, this.seq),
        });
      }
      case "POST /sync/push": {
        if (!this.write) {
          return json(403, { error: "this API token is read-only", code: "api_token_read_only" });
        }
        const outside = (body.operations as WireOp[]).find((op) => !inScope(op));
        if (outside) {
          const app = appOfKind(outside.entity)?.app ?? "unknown";
          return json(403, { code: "app_not_enabled", app, scope: "session", error: "no" });
        }
        const from = this.seq;
        for (const op of body.operations as WireOp[]) {
          if (this.ops.some((o) => o.id === op.id)) continue;
          this.ops.push({ ...op, seq: ++this.seq });
        }
        return json(200, { applied: body.operations.length, from, cursor: this.seq });
      }
      case "GET /project-keys":
        return json(200, { keys: [], canonical: {} });
    }
    return json(404, { error: `not found: ${init?.method} ${u.pathname}` });
  };

  /** A signed-in app device of the same account, for writes the SDK should see. */
  async appDevice(): Promise<{ store: LocalStore; sync: SyncClient }> {
    const api = new ApiClient({ baseUrl: "http://atlas.test", token: "app", fetch: this.fetch });
    api.setKeyring(new Keyring({ dek: this.keys.dek, privateKey: this.keys.privateKey }));
    const store = new LocalStore("app-device", { newId: () => crypto.randomUUID() });
    api.setScopeContext(store, USER_ID);
    const sync = new SyncClient(store, api, { cursor: 0 });
    await sync.sync();
    return { store, sync };
  }
}
