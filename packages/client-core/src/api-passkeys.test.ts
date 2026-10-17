import { describe, expect, it, vi } from "vitest";
import { ApiClient, type FetchLike } from "./api";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function bodyOf(call: Parameters<FetchLike>): unknown {
  const body = call[1]!.body;
  return body === undefined ? undefined : JSON.parse(body as string);
}

describe("ApiClient: passkeys", () => {
  it("speaks the passkey routes and sends proofs as given", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockImplementation(async () => jsonResponse(200, { options: { challenge: "c" } }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });

    expect(await client.passkeyLoginOptions("a@b.dev")).toEqual({ challenge: "c" });
    await client.passkeySignupOptions({ userId: "u", email: "a@b.dev" });
    await client.removePasskey("p1", { reauth_token: "proof" });
    await client.deleteAccount({ reauth_token: "proof" });
    await client.deleteAccount("hash");
    await client.removePassword({ current_password: "hash" });

    const calls = fetchMock.mock.calls.map((c) => [c[0], c[1]!.method, bodyOf(c)]);
    expect(calls).toEqual([
      ["http://x/auth/passkeys/login/options", "POST", { email: "a@b.dev" }],
      [
        "http://x/auth/passkeys/signup/options",
        "POST",
        { user_id: "u", email: "a@b.dev", display_name: "" },
      ],
      ["http://x/auth/passkeys/p1", "DELETE", { reauth_token: "proof" }],
      ["http://x/auth/account", "DELETE", { reauth_token: "proof" }],
      ["http://x/auth/account", "DELETE", { password: "hash" }],
      ["http://x/auth/password", "DELETE", { current_password: "hash" }],
    ]);
  });

  it("does not rotate the refresh token over a refused passkey sign-in", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(401, { error: "no" }));
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "old",
      refreshToken: "r",
      fetch: fetchMock,
    });
    await expect(
      client.passkeyLogin({
        credential: {
          id: "i",
          rawId: "i",
          type: "public-key",
          response: { clientDataJSON: "", authenticatorData: "", signature: "" },
          clientExtensionResults: {},
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
