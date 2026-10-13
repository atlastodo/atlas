import { describe, expect, it, vi } from "vitest";
import { ApiClient, type FetchLike } from "./api";

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

const wrapped = { iv: "aXY=", ct: "Y3Q=" };

function bodyOf(call: Parameters<FetchLike>): Record<string, unknown> {
  return JSON.parse(call[1]!.body as string) as Record<string, unknown>;
}

describe("ApiClient auth: recovery key", () => {
  it("signs up with the phrase-derived recovery public key", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, {}));
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock });

    await client.signup({
      email: "a@b.dev",
      password: "hash",
      salt: "00",
      publicKey: "aa".repeat(32),
      recoveryPublicKey: "bb".repeat(32),
      encryptedDek: wrapped,
      encryptedPrivateKey: wrapped,
      recoveryEncryptedDek: wrapped,
      recoveryEncryptedPrivateKey: wrapped,
    });

    const body = bodyOf(fetchMock.mock.calls[0]!);
    expect(body.recovery_public_key).toBe("bb".repeat(32));
    expect(body).not.toHaveProperty("device_id");
  });

  it("registers a recovery key with PUT /auth/recovery-key", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });

    await client.registerRecoveryKey({ current_password: "hash", recovery_public_key: "cc" });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://x/auth/recovery-key");
    expect(init!.method).toBe("PUT");
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({
      current_password: "hash",
      recovery_public_key: "cc",
    });
  });
});

/** A scripted server: each path answers from its queue (the last answer repeats). */
function scripted(answers: Record<string, [number, unknown][]>) {
  const fetchMock = vi.fn<FetchLike>(async (url) => {
    const path = new URL(url).pathname;
    const queue = answers[path];
    if (!queue?.length) return jsonResponse(404, { error: "not found" });
    const [status, body] = queue.length > 1 ? queue.shift()! : queue[0]!;
    return jsonResponse(status, body);
  });
  const paths = () => fetchMock.mock.calls.map(([url]) => new URL(url).pathname);
  return { fetchMock, paths };
}

const ROTATED = {
  access_token: "access-2",
  refresh_token: "refresh-2",
  expires_in: 900,
  device_id: "d",
  user: { id: "u", email: "a@b.dev", display_name: "A" },
};

describe("ApiClient auth: what a rejection rotates", () => {
  it("does not rotate the refresh token over a wrong password at sign-in", async () => {
    // A 401 from a credential endpoint is about the credential, not the access token.
    const { fetchMock, paths } = scripted({ "/auth/login": [[401, { error: "unauthorized" }]] });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
    });

    await expect(client.login("a@b.dev", "hash")).rejects.toMatchObject({ status: 401 });
    expect(paths()).toEqual(["/auth/login"]);
  });

  it("does not rotate over a failed recovery or deletion cancel", async () => {
    const { fetchMock, paths } = scripted({
      "/auth/recover": [[401, { error: "unauthorized" }]],
      "/auth/account/cancel-deletion": [[401, { error: "unauthorized" }]],
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
    });

    await expect(
      client.recoverAccount({
        email: "a@b.dev",
        challenge_token: "c",
        challenge_response: "00",
        new_auth_hash: "h",
        encrypted_dek: wrapped,
        encrypted_private_key: wrapped,
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      client.cancelAccountDeletion({ email: "a@b.dev", password: "h" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(paths()).toEqual(["/auth/recover", "/auth/account/cancel-deletion"]);
  });

  it("does not rotate over a wrong current password (403 invalid_credentials)", async () => {
    const wrong = { error: "invalid credentials", code: "invalid_credentials" };
    const { fetchMock, paths } = scripted({
      "/auth/change-password": [[403, wrong]],
      "/auth/account": [[403, wrong]],
      "/auth/recovery-key": [[403, wrong]],
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
    });

    await expect(
      client.changePassword({
        current_password: "a",
        new_password: "b",
        encrypted_dek: wrapped,
        encrypted_private_key: wrapped,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(client.deleteAccount("a")).rejects.toMatchObject({ status: 403 });
    await expect(
      client.registerRecoveryKey({ current_password: "a", recovery_public_key: "b" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(paths()).not.toContain("/auth/refresh");
  });

  it("still rotates an expired access token on a bearer route", async () => {
    const { fetchMock, paths } = scripted({
      "/auth/change-password": [
        [401, { error: "unauthorized" }],
        [204, undefined],
      ],
      "/auth/refresh": [[200, ROTATED]],
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
    });

    await client.changePassword({
      current_password: "a",
      new_password: "b",
      encrypted_dek: wrapped,
      encrypted_private_key: wrapped,
    });
    expect(paths()).toEqual(["/auth/change-password", "/auth/refresh", "/auth/change-password"]);
  });
});

describe("ApiClient auth: refresh", () => {
  function refreshBody(fetchMock: ReturnType<typeof vi.fn<FetchLike>>) {
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/auth/refresh"))!;
    return bodyOf(call);
  }

  it("asks for the reuse grace only when the token store cannot serialize rotations", async () => {
    for (const grace of [true, false]) {
      const { fetchMock } = scripted({
        "/auth/me": [
          [401, { error: "unauthorized" }],
          [200, ROTATED.user],
        ],
        "/auth/refresh": [[200, ROTATED]],
      });
      const client = new ApiClient({
        baseUrl: "http://x",
        token: "t",
        refreshToken: "r",
        fetch: fetchMock,
        tokenStore: { read: async () => null, write: async () => {}, refreshGrace: () => grace },
      });
      await client.me();
      if (grace) expect(refreshBody(fetchMock)).toEqual({ refresh_token: "r", grace: true });
      else expect(refreshBody(fetchMock)).toEqual({ refresh_token: "r" });
    }
  });

  it("reports why the refresh was refused, so the app can say so", async () => {
    const { fetchMock } = scripted({
      "/auth/me": [[401, { error: "unauthorized" }]],
      "/auth/refresh": [[403, { error: "account_scheduled_deletion", days_remaining: 12 }]],
    });
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
      onAuthExpired,
    });

    await expect(client.me()).rejects.toMatchObject({ status: 403 });
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    const reason = onAuthExpired.mock.calls[0]![0];
    expect(reason).toMatchObject({ status: 403, message: "account_scheduled_deletion" });
    expect(reason.data.days_remaining).toBe(12);
  });

  it("waits for the sibling's rotation after refresh_superseded instead of ending the session", async () => {
    // Without a lock, another tab rotated the same token a moment ago; its pair lands in storage
    // shortly after the server tells us so.
    const { fetchMock } = scripted({
      "/auth/me": [
        [401, { error: "unauthorized" }],
        [200, ROTATED.user],
      ],
      "/auth/refresh": [[401, { error: "refresh superseded", code: "refresh_superseded" }]],
    });
    let reads = 0;
    const onAuthExpired = vi.fn();
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
      onAuthExpired,
      tokenStore: {
        read: async () =>
          ++reads < 3
            ? { accessToken: "t", refreshToken: "r" }
            : { accessToken: "a2", refreshToken: "r2" },
        write: async () => {},
        refreshGrace: () => true,
      },
    });

    await expect(client.me()).resolves.toEqual(ROTATED.user);
    expect(onAuthExpired).not.toHaveBeenCalled();
    const last = fetchMock.mock.calls.at(-1)!;
    expect((last[1]!.headers as Record<string, string>).authorization).toBe("Bearer a2");
    // The superseded token is never presented again.
    expect(client.hasPresented("r")).toBe(true);
    expect(client.hasPresented("r2")).toBe(false);
  });

  it("remembers every refresh token it presented", async () => {
    const { fetchMock } = scripted({
      "/auth/me": [
        [401, { error: "unauthorized" }],
        [200, ROTATED.user],
      ],
      "/auth/refresh": [[200, ROTATED]],
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "r",
      fetch: fetchMock,
    });
    expect(client.hasPresented("r")).toBe(false);
    await client.me();
    expect(client.hasPresented("r")).toBe(true);
    expect(client.hasPresented("refresh-2")).toBe(false);
  });

  it("signs out a given refresh token's device", async () => {
    const { fetchMock } = scripted({ "/auth/logout": [[204, undefined]] });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "t",
      refreshToken: "current",
      fetch: fetchMock,
    });
    await client.logout("abandoned");
    expect(bodyOf(fetchMock.mock.calls[0]!)).toEqual({ refresh_token: "abandoned" });
  });
});

describe("ApiClient auth: API tokens", () => {
  it("re-opens a token session on a 401, once for concurrent requests", async () => {
    let live = "old";
    const fetchMock = vi.fn<FetchLike>(async (_url, init) => {
      const auth = (init!.headers as Record<string, string>)["authorization"];
      return auth === `Bearer ${live}` ? jsonResponse(200, []) : jsonResponse(401, {});
    });
    const reauthenticate = vi.fn(async () => {
      live = "fresh";
      return live;
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      fetch: fetchMock,
      reauthenticate,
    });

    await Promise.all([client.listMembers("p"), client.listMembers("p")]);

    expect(reauthenticate).toHaveBeenCalledTimes(1);
  });

  it("does not re-open on the exchange itself", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(401, {}));
    const reauthenticate = vi.fn(async () => "x");
    const client = new ApiClient({ baseUrl: "http://x", fetch: fetchMock, reauthenticate });

    await expect(client.openApiTokenSession("id", "auth")).rejects.toMatchObject({ status: 401 });
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("manages tokens under /auth/api-tokens", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(204, undefined));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });

    await client.listApiTokens();
    await client.revokeApiToken("t1");

    expect(fetchMock.mock.calls.map(([url, init]) => `${init!.method} ${url}`)).toEqual([
      "GET http://x/auth/api-tokens",
      "DELETE http://x/auth/api-tokens/t1",
    ]);
  });
});
