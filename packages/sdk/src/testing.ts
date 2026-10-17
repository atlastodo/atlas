import {
  ApiClient,
  LocalStore,
  SyncClient,
  Keyring,
  deriveApiTokenKeys,
  formatApiToken,
  generateApiToken,
  randomBytes,
  wrapKeysForApiToken,
  type FetchLike,
  type WireOp,
} from "@atlastodo/client-core";

export const USER_ID = "01920000-0000-7000-8000-0000000000aa";

/**
 * A stand-in for the server's sync surface: one account's op log, kept as the opaque wire ops the
 * clients push (ciphertext), like the real server. Enough of the API for the SDK and an app-like
 * second client.
 */
export class FakeServer {
  readonly ops: (WireOp & { seq: number })[] = [];
  private seq = 0;
  readonly token = generateApiToken();
  readonly keys = { dek: randomBytes(32), privateKey: randomBytes(32) };
  sessions = 0;
  revoked = false;

  tokenString(): string {
    return formatApiToken(this.token);
  }

  fetch: FetchLike = async (url, init) => {
    const u = new URL(String(url));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, data: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });
    const authed = (init?.headers as Record<string, string> | undefined)?.authorization;
    switch (`${init?.method} ${u.pathname}`) {
      case "POST /auth/api-token/session": {
        if (
          this.revoked ||
          body.token_id !== this.token.id ||
          body.auth !== deriveApiTokenKeys(this.token).auth
        ) {
          return json(401, { error: "unauthorized" });
        }
        this.sessions++;
        return json(200, {
          access_token: `access-${this.sessions}`,
          expires_in: 900,
          token_id: this.token.id,
          user_id: USER_ID,
          ...wrapKeysForApiToken(this.token, USER_ID, this.keys),
        });
      }
    }
    if (this.revoked || !authed?.startsWith("Bearer ")) return json(401, { error: "unauthorized" });
    switch (`${init?.method} ${u.pathname}`) {
      case "GET /sync/snapshot":
        return json(200, { operations: this.ops, cursor: this.seq });
      case "GET /sync/pull": {
        const since = Number(u.searchParams.get("since"));
        const page = this.ops.filter((o) => o.seq > since).slice(0, 500);
        return json(200, {
          operations: page,
          from: since,
          cursor: page.length ? page[page.length - 1]!.seq : Math.max(since, this.seq),
        });
      }
      case "POST /sync/push": {
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
