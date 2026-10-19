import { describe, expect, it, vi } from "vitest";
import { ApiClient, NetworkError, type FetchLike } from "./api";
import {
  LEGACY_DISCOVERY,
  ServerIncompatibleError,
  assertServerCompatible,
  parseDiscovery,
  serverIncompatibility,
} from "./discovery";

function response(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => JSON.parse(text),
    text: async () => text,
    headers: new Headers(),
  } as Response;
}

const SERVER_BODY = {
  service: "atlas-server",
  version: "0.2.0",
  protocol_version: 6,
  min_protocol_version: 6,
  capabilities: ["api_tokens", "app_manifests", "account_apps"],
  apps: [{ id: "todo", name: "Atlas Todo", version: 1 }],
};

function client(fetchImpl: FetchLike): ApiClient {
  return new ApiClient({ baseUrl: "http://x/api", fetch: fetchImpl });
}

describe("getDiscovery", () => {
  it("reads the server's discovery document", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, JSON.stringify(SERVER_BODY)));
    const d = await client(fetchMock).getDiscovery();
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/api/discovery");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("GET");
    expect(d).toEqual({
      legacy: false,
      version: "0.2.0",
      protocolVersion: 6,
      minProtocolVersion: 6,
      capabilities: ["api_tokens", "app_manifests", "account_apps"],
      apps: [{ id: "todo", name: "Atlas Todo", version: 1 }],
    });
  });

  it("treats a 404 as a legacy server", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(404, JSON.stringify({ error: "not found" })));
    expect(await client(fetchMock).getDiscovery()).toBe(LEGACY_DISCOVERY);
  });

  it("treats the web app's HTML in its place as a legacy server", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(response(200, "<!doctype html><html>Atlas</html>"));
    expect(await client(fetchMock).getDiscovery()).toBe(LEGACY_DISCOVERY);
  });

  it("still throws on network and server errors", async () => {
    const down = vi.fn<FetchLike>().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(client(down).getDiscovery()).rejects.toBeInstanceOf(NetworkError);
    const broken = vi.fn<FetchLike>().mockResolvedValue(response(500, '{"error":"boom"}'));
    await expect(client(broken).getDiscovery()).rejects.toMatchObject({ status: 500 });
  });
});

describe("parseDiscovery", () => {
  it("falls back to legacy on anything that is not a discovery document", () => {
    for (const body of [null, "x", 3, {}, { protocol_version: "6" }, { protocol_version: 0 }]) {
      expect(parseDiscovery(body)).toBe(LEGACY_DISCOVERY);
    }
  });

  it("drops malformed entries but keeps the rest", () => {
    const d = parseDiscovery({
      protocol_version: 7,
      capabilities: ["a", 1, "b"],
      apps: [{ id: "todo", version: 2 }, { id: 3 }, null, { id: "notes", version: "1" }],
    });
    expect(d.legacy).toBe(false);
    expect(d.version).toBeNull();
    expect(d.minProtocolVersion).toBeNull();
    expect(d.capabilities).toEqual(["a", "b"]);
    expect(d.apps).toEqual([{ id: "todo", name: "todo", version: 2 }]);
  });
});

describe("server compatibility", () => {
  const current = parseDiscovery(SERVER_BODY);

  it("accepts a server that meets the requirements", () => {
    expect(
      serverIncompatibility(current, {
        minProtocol: 6,
        capabilities: ["api_tokens"],
        apps: ["todo"],
      }),
    ).toBeNull();
    expect(serverIncompatibility(current, {})).toBeNull();
  });

  it("a legacy server passes only requirements protocol 1 meets", () => {
    expect(serverIncompatibility(LEGACY_DISCOVERY, { minProtocol: 1, apps: ["todo"] })).toBeNull();
    expect(serverIncompatibility(LEGACY_DISCOVERY, { minProtocol: 2 })).toEqual({
      reason: "protocol",
      required: 2,
      actual: 1,
    });
    expect(serverIncompatibility(LEGACY_DISCOVERY, { capabilities: ["api_tokens"] })).toEqual({
      reason: "capabilities",
      missing: ["api_tokens"],
    });
  });

  it("names what is missing", () => {
    expect(serverIncompatibility(current, { capabilities: ["x", "api_tokens", "y"] })).toEqual({
      reason: "capabilities",
      missing: ["x", "y"],
    });
    expect(serverIncompatibility(current, { apps: ["todo", "notes"] })).toEqual({
      reason: "apps",
      missing: ["notes"],
    });
  });

  it("throws a clear update-your-server error", () => {
    let caught: unknown;
    try {
      assertServerCompatible(current, { minProtocol: 9 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServerIncompatibleError);
    const err = caught as ServerIncompatibleError;
    expect(err.incompatibility).toEqual({ reason: "protocol", required: 9, actual: 6 });
    expect(err.discovery).toBe(current);
    expect(err.message).toMatch(/Atlas server 0\.2\.0 .*protocol 6.*Update your server/);
    expect(() => assertServerCompatible(current, { minProtocol: 6 })).not.toThrow();
  });
});
