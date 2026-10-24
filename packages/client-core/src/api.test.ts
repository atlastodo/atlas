import { describe, it, expect, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  NetworkError,
  UpgradeRequiredError,
  toEncryptedWire,
  type FetchLike,
  type TokenStore,
} from "./api";
import { SYNC_PROTOCOL } from "./realtime";
import { Keyring, generateDek } from "./crypto";
import type { BugReportPayload, Operation } from "./types";

/** Build a Response-like object without a real DOM/fetch. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

describe("ApiClient", () => {
  it("sends auth header and parses JSON on success", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, [{ device_id: "d1", current: true }]));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });

    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/sessions");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, []));
    const client = new ApiClient({ baseUrl: "http://x/", fetch: fetchMock });
    await client.listInvites();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/invites");
  });

  it("serializes body and sets content-type on POST", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { access_token: "a" }));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    await client.login("e@example.com", "pw");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toEqual({ email: "e@example.com", password: "pw" });
  });

  it("throws ApiError carrying the status and server message", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(400, { error: "invalid credentials" }));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    await expect(client.login("e@example.com", "bad")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "invalid credentials",
    });
  });

  it("returns undefined for 204 responses", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    await expect(client.revokeSession("1")).resolves.toBeUndefined();
  });

  it("omits auth header when no token is set", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, []));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    await client.listInvites();
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init!.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("exposes ApiError as an Error subclass", () => {
    const err = new ApiError(404, "not found");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
  });

  it("throws a NetworkError (not ApiError) when fetch rejects — the server is unreachable", async () => {
    const cause = new TypeError("Failed to fetch");
    const fetchMock = vi.fn<FetchLike>().mockRejectedValue(cause);
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    const err = await client.listInvites().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as NetworkError).cause).toBe(cause);
  });

  it("aborts a request that hangs past fetchTimeoutMs as a NetworkError", async () => {
    // A server that never answers (dead connection, wrong port) must fail by our cap, not by the
    // OS TCP timeout, which on phones can hold a login for minutes. The stub mimics a real fetch:
    // it rejects only when its signal fires.
    const fetchMock = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        }),
    );
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock, fetchTimeoutMs: 10 });
    await expect(client.listInvites()).rejects.toMatchObject({
      name: "NetworkError",
      message: expect.stringContaining("timed out after 10ms"),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refreshes once on a 401 and retries the original request", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      // 1) original request → 401
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      // 2) POST /auth/refresh → new tokens
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 900,
          device_id: "d",
          user: { id: "u", email: "e", display_name: "" },
        }),
      )
      // 3) replayed original request → success
      .mockResolvedValueOnce(jsonResponse(200, []));

    const onTokens = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r",
      fetch: fetchMock,
      onTokens,
    });

    const tasks = await client.listInvites();
    expect(tasks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The refresh endpoint was hit, and the replay carried the new token.
    expect(fetchMock.mock.calls[1]![0]).toBe("http://x/auth/refresh");
    const replayHeaders = fetchMock.mock.calls[2]![1]!.headers as Record<string, string>;
    expect(replayHeaders["authorization"]).toBe("Bearer new-access");
    expect(onTokens).toHaveBeenCalledOnce();
  });

  it("rotates ONCE when several requests 401 at the same time", async () => {
    // A refresh token is single-use, and presenting a consumed one is a theft signal the server
    // answers by revoking the device's whole token family; including the replacement it had just
    // issued. So two concurrent 401s racing to refresh permanently wedged sync at 401. This is the
    // cold-start shape: a sync, `me()` and `listInvites()` all fire with one expired access token.
    let refreshed = false;
    const fetchMock = vi.fn<FetchLike>().mockImplementation((url: string) => {
      if (url.endsWith("/auth/refresh")) {
        return Promise.resolve(
          jsonResponse(200, {
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 900,
            device_id: "d",
            user: { id: "u", email: "e", display_name: "" },
          }),
        );
      }
      // Every non-refresh call 401s until the rotation lands, then succeeds.
      return Promise.resolve(refreshed ? jsonResponse(200, []) : jsonResponse(401, {}));
    });

    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r",
      fetch: fetchMock,
      onTokens: () => {
        refreshed = true;
      },
    });

    await Promise.all([client.listInvites(), client.me(), client.listInvites()]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith("/auth/refresh"));
    expect(refreshCalls).toHaveLength(1);
  });

  it("reports a rejected refresh as terminal and drops the dead tokens", async () => {
    // A refresh token can die for reasons no client can prevent (revoked, expired, a logout
    // elsewhere). Retrying is futile, and the 5s sync poll turned that into an endless 401 loop that
    // eventually tripped the auth rate limit; while the app still looked signed in.
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(401, {}));
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "dead",
      fetch: fetchMock,
      onAuthExpired,
    });

    await expect(client.listInvites()).rejects.toBeInstanceOf(ApiError);
    expect(onAuthExpired).toHaveBeenCalledOnce();

    // The dead credentials are gone, so a later call cannot present them again.
    fetchMock.mockClear();
    await expect(client.listInvites()).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledOnce(); // no refresh attempt: there is no token to rotate
    expect(onAuthExpired).toHaveBeenCalledOnce();
  });

  it("leaves the session alone when a refresh fails transiently", async () => {
    // 429 and network failures are not the session's fault.
    for (const failure of [jsonResponse(429, { error: "too many requests" }), null]) {
      const onAuthExpired = vi.fn();
      const fetchMock = vi.fn<FetchLike>().mockImplementation((url: string) => {
        if (!url.endsWith("/auth/refresh")) return Promise.resolve(jsonResponse(401, {}));
        return failure ? Promise.resolve(failure) : Promise.reject(new TypeError("offline"));
      });
      const client = new ApiClient({
        baseUrl: "http://x",
        token: "stale",
        refreshToken: "r",
        fetch: fetchMock,
        onAuthExpired,
      });

      await expect(client.listInvites()).rejects.toBeTruthy();
      expect(onAuthExpired).not.toHaveBeenCalled();
    }
  });

  it("does not attempt refresh when no refresh token is held", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const client = new ApiClient({ baseUrl: "http://x", token: "stale", fetch: fetchMock });
    await expect(client.listInvites()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("logout is a no-op without a refresh token", async () => {
    const fetchMock = vi.fn<FetchLike>();
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });
    await client.logout();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("builds the realtime WS URL around a fresh ticket, never the access token", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, { ticket: "a/b+c", expires_in: 30 }))
      .mockResolvedValueOnce(jsonResponse(200, { ticket: "t2", expires_in: 30 }));
    const client = new ApiClient({
      baseUrl: "https://api.example.com/",
      token: "access-jwt",
      fetch: fetchMock,
    });

    const url = await client.syncWsUrl(7);
    expect(url).toBe("wss://api.example.com/sync/ws?ticket=a%2Fb%2Bc&since=7&protocol=7");
    expect(url).not.toContain("access-jwt");
    const [ticketUrl, init] = fetchMock.mock.calls[0]!;
    expect(ticketUrl).toBe("https://api.example.com/sync/ws-ticket");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer access-jwt");
    // One ticket per connect attempt.
    expect(await client.syncWsUrl(0)).toBe(
      "wss://api.example.com/sync/ws?ticket=t2&since=0&protocol=7",
    );

    // Signed out: there is nothing to connect with, and nothing is asked.
    const signedOut = vi.fn<FetchLike>();
    expect(await new ApiClient({ baseUrl: "http://x", fetch: signedOut }).syncWsUrl(0)).toBeNull();
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token before asking for a socket ticket", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: "fresh", refresh_token: "r2", user: { id: "u" } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ticket: "t", expires_in: 30 }));
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r1",
      fetch: fetchMock,
    });

    expect(await client.syncWsUrl(0)).toBe("ws://x/sync/ws?ticket=t&since=0&protocol=7");
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
      "http://x/sync/ws-ticket",
      "http://x/auth/refresh",
      "http://x/sync/ws-ticket",
    ]);
    const retried = fetchMock.mock.calls[2]![1]!;
    expect((retried.headers as Record<string, string>)["authorization"]).toBe("Bearer fresh");
  });

  it("decodes a pull-shaped payload — the same JSON /sync/pull and the WS stream deliver", () => {
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: vi.fn() });
    const keyring = new Keyring({ dek: generateDek() });
    client.setKeyring(keyring);

    const op: Operation = {
      id: "op-1",
      entity: "task",
      entityId: "t1",
      ts: { wallMs: 1, counter: 0, node: "n" },
      op: "set",
      field: "title",
      value: "hello",
    };
    // The wire form, encrypted exactly as it sits in the server's log — and as the realtime hub
    // broadcasts it verbatim. Decoding must decrypt it identically to a pull over HTTP.
    const wire = toEncryptedWire(op, client.getKeyring(), null);
    const decoded = client.decodeWirePayload({ operations: [wire], cursor: 3 });
    expect(decoded.cursor).toBe(3);
    expect(decoded.operations).toEqual([op]);

    // A malformed payload throws: the HTTP path retries the cycle; realtime drops the batch.
    expect(() => client.decodeWirePayload({ operations: "nope", cursor: 3 })).toThrow(/malformed/);
    expect(() => client.decodeWirePayload(null)).toThrow(/malformed/);
  });
});

describe("ApiClient bug reports", () => {
  const REPORT: BugReportPayload = {
    id: "0198ab00-0000-7000-8000-000000000001",
    kind: "crash",
    message: "boom",
    stack: "at render (bundle.js:1:2)",
    appVersion: "0.18.0",
    platform: "ios",
    osVersion: "18.0",
    route: "/today",
    deviceId: "dev-1",
    diagnostics: {
      syncStatus: "offline",
      lastSyncAt: 1000,
      pending: 3,
      quarantined: 1,
      lastErrorKind: "network",
      lastErrorStatus: null,
      lastErrorMessage: "unreachable",
      online: false,
    },
    breadcrumbs: [{ at: 5, code: "nav", ref: "/today" }],
    occurredAt: 1234,
  };

  it("submits a report with no auth header when signed out", async () => {
    // The endpoint exists precisely for crashes that happen before a session exists, so the call
    // must not require; or invent; a token.
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(202, undefined));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });

    await client.submitReport(REPORT);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/reports");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("converts the payload to the snake_case wire form", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(202, undefined));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });

    await client.submitReport(REPORT);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.app_version).toBe("0.18.0");
    expect(body.occurred_at).toBe(1234);
    expect(body.device_id).toBe("dev-1");
    expect(body.os_version).toBe("18.0");
    // Diagnostics are snake_cased too; one conversion rule at the boundary, no exceptions.
    expect(body.diagnostics).toEqual({
      sync_status: "offline",
      last_sync_at: 1000,
      pending: 3,
      quarantined: 1,
      last_error_kind: "network",
      last_error_status: null,
      last_error_message: "unreachable",
      online: false,
    });
    // Nothing camelCase survives the boundary.
    expect(body).not.toHaveProperty("appVersion");
    expect(body).not.toHaveProperty("occurredAt");
  });

  it("builds the admin list query only from the params given", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, []));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.listReports();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/admin/reports");

    await client.listReports({ resolved: false, limit: 25, beforeMs: 99 });
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://x/admin/reports?resolved=false&limit=25&before_ms=99",
    );
  });

  it("patches a report's resolved state", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { id: "r-1" }));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.setReportResolved("r-1", true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/admin/reports/r-1");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ resolved: true });
  });

  it("deletes a single report", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, null));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.deleteReport("r-1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/admin/reports/r-1");
    expect(init!.method).toBe("DELETE");
  });

  it("deletes all reports", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { deleted: 5 }));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    const result = await client.deleteAllReports();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/admin/reports");
    expect(init!.method).toBe("DELETE");
    expect(result.deleted).toBe(5);
  });
});

describe("ApiClient admin panel (users, invites, settings, audit)", () => {
  it("builds the user-list query only from the params given", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, []));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.listUsers();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/admin/users");

    await client.listUsers({ search: "ada", limit: 25, beforeId: "0199-abc" });
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://x/admin/users?search=ada&limit=25&before_id=0199-abc",
    );
  });

  it("patches a user's admin and disabled flags", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { id: "u-1" }));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.setUserAdmin("u-1", true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/admin/users/u-1");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ is_admin: true });

    await client.setUserDisabled("u-1", true);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ disabled: true });
  });

  it("sends the user actions to their own endpoints", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, null));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.logoutUserDevices("u-1");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/admin/users/u-1/logout");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");

    await client.deleteUser("u-1");
    expect(fetchMock.mock.calls[1]![0]).toBe("http://x/admin/users/u-1");
    expect(fetchMock.mock.calls[1]![1]!.method).toBe("DELETE");
  });

  it("creates an invite with the optional validity and revokes it", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, { id: "i-1" }));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.createSignupInvite();
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({});

    await client.createSignupInvite(30);
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ days_valid: 30 });

    await client.revokeSignupInvite("i-1");
    expect(fetchMock.mock.calls[2]![0]).toBe("http://x/admin/invites/i-1");
    expect(fetchMock.mock.calls[2]![1]!.method).toBe("DELETE");
  });

  it("round-trips the settings and audit endpoints", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { signup_enabled: false }));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    const settings = await client.getAdminSettings();
    expect(settings.signup_enabled).toBe(false);

    await client.updateAdminSettings({ signup_enabled: true });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({
      signup_enabled: true,
    });

    await client.listAudit({ limit: 10, beforeId: 42 });
    expect(fetchMock.mock.calls[2]![0]).toBe("http://x/admin/audit?limit=10&before_id=42");
  });
});

describe("ApiClient account security (change password, delete account)", () => {
  it("posts the change-password payload verbatim to /auth/change-password", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.changePassword({
      current_password: "current-auth-hash",
      new_password: "new-auth-hash",
      encrypted_dek: { iv: "iv", ct: "dek" },
      encrypted_private_key: { iv: "iv", ct: "priv" },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/change-password");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      current_password: "current-auth-hash",
      new_password: "new-auth-hash",
      encrypted_dek: { iv: "iv", ct: "dek" },
      encrypted_private_key: { iv: "iv", ct: "priv" },
    });
  });

  it("sends the account password on the delete-account request", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.deleteAccount("current-auth-hash");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/account");
    expect(init!.method).toBe("DELETE");
    expect(JSON.parse(init!.body as string)).toEqual({ password: "current-auth-hash" });
  });
});

describe("ApiClient sessions / device management", () => {
  it("lists the caller's sessions (the server's live refresh-token families)", async () => {
    const sessions = [
      {
        device_id: "d1",
        created_at: 1000,
        last_used_at: 2000,
        expires_at: 3000,
        current: true,
      },
      {
        device_id: "d2",
        created_at: 1500,
        last_used_at: 2500,
        expires_at: 3500,
        current: false,
      },
    ];
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, sessions));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await expect(client.listSessions()).resolves.toEqual(sessions);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/sessions");
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer t");
  });

  it("revokes a session by device id with DELETE", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.revokeSession("device-9");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/sessions/device-9");
    expect(init!.method).toBe("DELETE");
  });

  it("revokes every other session with a body-less POST", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.revokeOtherSessions();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/sessions/revoke-others");
    expect(init!.method).toBe("POST");
    expect(init!.body).toBeUndefined();
  });

  it("renames a session with PATCH", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.renameSession("device-9", "Work Laptop");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/sessions/device-9");
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ name: "Work Laptop" });
  });

  it("fetches the GDPR-style data export", async () => {
    const bundle = { account: { email: "a@b.c" }, data: { operations: [] } };
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, bundle));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await expect(client.exportData()).resolves.toEqual(bundle);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/auth/export");
  });
});

describe("ApiClient token rotation shared across clients (browser tabs)", () => {
  type Pair = { accessToken?: string; refreshToken?: string };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  /**
   * A server with single-use refresh tokens: presenting a consumed one answers 401 (the 30s
   * `refresh_superseded` grace) without rotating anything. The access token that works is the
   * one issued with the live refresh token.
   */
  function rotatingServer(live = { access: "a1", refresh: "r1" }) {
    let n = 1;
    const state = { ...live, refreshCalls: 0 };
    const fetchImpl = vi.fn<FetchLike>(async (url, init) => {
      if (url.endsWith("/auth/refresh")) {
        state.refreshCalls++;
        await tick();
        const presented = JSON.parse(init!.body as string).refresh_token;
        if (presented !== state.refresh) return jsonResponse(401, { code: "refresh_superseded" });
        n++;
        state.access = `a${n}`;
        state.refresh = `r${n}`;
        return jsonResponse(200, {
          access_token: state.access,
          refresh_token: state.refresh,
          expires_in: 900,
          device_id: "d",
          user: { id: "u", email: "e", display_name: "" },
        });
      }
      const auth = (init!.headers as Record<string, string>)["authorization"];
      return auth === `Bearer ${state.access}` ? jsonResponse(200, []) : jsonResponse(401, {});
    });
    return { state, fetchImpl };
  }

  /** The storage every tab shares (localStorage), optionally with a cross-tab mutex. */
  function sharedStore(initial: Pair, { lock = true } = {}) {
    let stored: Pair | null = { ...initial };
    let tail: Promise<unknown> = Promise.resolve();
    const store: TokenStore = {
      read: async () => (stored ? { ...stored } : null),
      write: async (auth) => {
        await tick(); // a real write is async; the lock must be held until it lands
        stored = { accessToken: auth.access_token, refreshToken: auth.refresh_token };
      },
    };
    if (lock) {
      store.withRefreshLock = <T>(fn: () => Promise<T>) => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => {});
        return run;
      };
    }
    return {
      store,
      get: () => stored,
      set: (p: Pair) => {
        stored = { ...p };
      },
    };
  }

  it("rotates once when two tabs 401 together; the other tab adopts the stored pair", async () => {
    // Each tab holds its own in-memory copy of the refresh token. Without a shared lock the second
    // tab presented the token the first had just consumed, and the server revoked the family.
    const server = rotatingServer({ access: "a0-expired", refresh: "r1" });
    server.state.access = "never-matches";
    const shared = sharedStore({ accessToken: "stale", refreshToken: "r1" });
    const onAuthExpired = vi.fn();
    const tab = () =>
      new ApiClient({
        baseUrl: "http://x",
        token: "stale",
        refreshToken: "r1",
        fetch: server.fetchImpl,
        tokenStore: shared.store,
        onAuthExpired,
      });
    const a = tab();
    const b = tab();

    await Promise.all([a.listInvites(), b.listInvites()]);

    expect(server.state.refreshCalls).toBe(1);
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(shared.get()).toEqual({ accessToken: "a2", refreshToken: "r2" });
  });

  it("adopts a newer stored pair after a refresh 401 and retries, instead of signing out", async () => {
    // Lock-less race: another tab rotated between our read and our POST.
    const server = rotatingServer({ access: "a2", refresh: "r2" }); // the sibling already rotated
    const shared = sharedStore({ accessToken: "stale", refreshToken: "r1" }, { lock: false });
    const read = shared.store.read;
    let reads = 0;
    shared.store.read = async () => {
      // The sibling's write lands just after our first read.
      if (reads++ === 1) shared.set({ accessToken: "a2", refreshToken: "r2" });
      return read();
    };
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r1",
      fetch: server.fetchImpl,
      tokenStore: shared.store,
      onAuthExpired,
    });

    await expect(client.listInvites()).resolves.toEqual([]);

    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(server.state.refreshCalls).toBe(1);
    const last = server.fetchImpl.mock.calls.at(-1)!;
    expect((last[1]!.headers as Record<string, string>)["authorization"]).toBe("Bearer a2");
  });

  it("ends the session when a refresh 401s and no newer pair is stored", async () => {
    const server = rotatingServer({ access: "a9", refresh: "r9" }); // family revoked for us
    const shared = sharedStore({ accessToken: "stale", refreshToken: "r1" });
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r1",
      fetch: server.fetchImpl,
      tokenStore: shared.store,
      onAuthExpired,
    });

    await expect(client.listInvites()).rejects.toMatchObject({ status: 401 });
    expect(onAuthExpired).toHaveBeenCalledOnce();
  });

  it("without a lock, a tab that 401s after another rotated adopts the stored pair unasked", async () => {
    const server = rotatingServer({ access: "stale-a", refresh: "r1" });
    server.state.access = "never-matches";
    const shared = sharedStore({ accessToken: "stale", refreshToken: "r1" }, { lock: false });
    const onTokens = vi.fn();
    const tab = () =>
      new ApiClient({
        baseUrl: "http://x",
        token: "stale",
        refreshToken: "r1",
        fetch: server.fetchImpl,
        tokenStore: shared.store,
        onTokens,
      });
    const a = tab();
    const b = tab();

    await a.listInvites();
    await b.listInvites();

    // Only tab A hit /auth/refresh; B read A's pair from storage and never presented r1.
    expect(server.state.refreshCalls).toBe(1);
    expect(onTokens).toHaveBeenCalledOnce();
  });

  it("never adopts a pair it already consumed, even if storage lags behind", async () => {
    // A failed keychain write leaves an older pair in storage; presenting it again would be the
    // reuse the server punishes by revoking the whole family.
    const server = rotatingServer({ access: "stale-a", refresh: "r1" });
    server.state.access = "never-matches";
    let stored: Pair = { accessToken: "stale", refreshToken: "r1" };
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r1",
      fetch: server.fetchImpl,
      tokenStore: {
        read: async () => stored,
        write: async () => {
          throw new Error("keychain refused");
        },
      },
    });
    await client.listInvites(); // rotates r1 -> r2 (the write fails; storage still says r1)
    server.state.access = "never-matches"; // expire a2 so the next call refreshes again
    stored = { accessToken: "stale", refreshToken: "r1" };

    await client.listInvites();

    const presented = server.fetchImpl.mock.calls
      .filter(([url]) => url.endsWith("/auth/refresh"))
      .map(([, init]) => JSON.parse(init!.body as string).refresh_token);
    expect(presented).toEqual(["r1", "r2"]);
  });
});

describe("ApiClient sync protocol version", () => {
  it("announces the sync protocol on every request, JSON and blob alike", async () => {
    // The server refuses sync from builds that predate the E2EE fixes; the header is how it tells.
    expect(SYNC_PROTOCOL).toBe(7);
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, []));
    const client = new ApiClient({ baseUrl: "http://x", token: "t", fetch: fetchMock });

    await client.listInvites();
    await client.putBlob("ab".repeat(32), new Uint8Array([1]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init!.headers as Record<string, string>)["x-atlas-sync-protocol"]).toBe("7");
    }
  });

  it("reports a 426 through onUpgradeRequired and rejects with an UpgradeRequiredError", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse(426, {
        error: "client update required",
        code: "upgrade_required",
        min_protocol: 3,
      }),
    );
    const onUpgradeRequired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      fetch: fetchMock,
      onUpgradeRequired,
    });

    const err = await client.listInvites().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err).toBeInstanceOf(ApiError); // still an HTTP answer to every existing handler
    expect((err as UpgradeRequiredError).status).toBe(426);
    expect((err as UpgradeRequiredError).minProtocol).toBe(3);
    expect(onUpgradeRequired).toHaveBeenCalledWith({ minProtocol: 3 });
  });
});
