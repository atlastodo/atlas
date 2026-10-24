import { describe, expect, it, vi } from "vitest";
import {
  ApiClient,
  ApiError,
  NetworkError,
  fromEncryptedWire,
  toEncryptedWire,
  type BlobDownload,
  type FetchLike,
  type WireOp,
} from "./api";
import {
  AttachmentTooLargeError,
  AttachmentQueue,
  BLOB_REFRESH_MS,
  MAX_SERVER_ATTEMPTS,
  blobSource,
  bytesSource,
  decryptBlob,
  decryptMeta,
  encryptBlob,
  encryptMeta,
  fetchBlob,
  generateAek,
  maxAttachmentBytes,
  sealSource,
  unwrapAek,
  unwrapAekAny,
  wrapAek,
  type AttachmentQueueEvent,
  type AttachmentSource,
  type BlobTransport,
} from "./attachments";
import {
  BLOB_CHUNK_SIZE,
  BlobIntegrityError,
  DEK_KEY_ID,
  Keyring,
  bytesToHex,
  decryptJson,
  generateDek,
  generatePek,
  projectKeyId,
  randomBytes,
  sealedBlobSize,
  utf8ToBytes,
  wrapKey,
} from "./crypto";
import { keyForScope, type ScopeKey } from "./scope";
import { LocalStore } from "./store";
import { MemoryPersistence, type AttachmentCiphertext, type Persistence } from "./persistence";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import type { Operation } from "./types";

/** `n` bytes of noise; `randomBytes` draws at most 64 KiB at once. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) out.set(randomBytes(Math.min(65536, n - at)), at);
  return out;
}

const NODE = "00000000-0000-0000-0000-0000000000a7";

/** The file most tests upload: one chunk (multi-chunk files have tests of their own). */
const FILE = utf8ToBytes("quarterly report — do not leak");
const DRAFT = {
  taskId: "task-1",
  projectId: null,
  filename: "report.txt",
  mime: "text/plain",
  source: FILE,
};
const FILE_SHA = bytesToHex(sha256(FILE));

/** The personal DEK as the scope key an attachment outside any shared project is wrapped under. */
function personalKey(keyring: Keyring): ScopeKey {
  return keyForScope(keyring, { kind: "personal" }, new Set());
}

/** `pek` as the scope key of `projectId`. */
function projectScopeKey(pek: Uint8Array, projectId: string): ScopeKey {
  return { key: pek, keyId: projectKeyId(pek), scope: { kind: "project", projectId } };
}

describe("attachment blob crypto", () => {
  it("round-trips a file held in memory", () => {
    const aek = generateAek();
    const { blob } = encryptBlob(aek, FILE);
    expect(decryptBlob(aek, blob)).toEqual(FILE);
    expect(decryptBlob(aek, blob, FILE_SHA)).toEqual(FILE); // plain sha verifies
  });

  it("addresses the blob by the sha256 of the ENTIRE body, header and tags included", () => {
    const aek = generateAek();
    const { sha, blob } = encryptBlob(aek, FILE);
    // The address covers the whole body the server receives, which is exactly what its CAS
    // verifies and what a download re-checks.
    expect(sha).toBe(bytesToHex(sha256(blob)));
    expect(blob.length).toBe(sealedBlobSize(FILE.length));
  });

  it("encrypts the same file to DIFFERENT addresses (fresh nonces — no dedup side-channel)", () => {
    const aek = generateAek();
    const a = encryptBlob(aek, FILE);
    const b = encryptBlob(aek, FILE);
    expect(a.sha).not.toBe(b.sha);
    expect(a.blob).not.toEqual(b.blob);
    // Yet both decrypt to the same plaintext.
    expect(decryptBlob(aek, a.blob)).toEqual(FILE);
    expect(decryptBlob(aek, b.blob)).toEqual(FILE);
  });

  it("refuses tampered bodies and truncated headers", () => {
    const aek = generateAek();
    const { blob } = encryptBlob(aek, FILE);
    const tampered = blob.slice();
    tampered[tampered.length - 1]! ^= 1; // flip one tag bit
    expect(() => decryptBlob(aek, tampered)).toThrow(BlobIntegrityError);
    expect(() => decryptBlob(aek, blob.subarray(0, 20))).toThrow(BlobIntegrityError);
    // And the wrong AEK is just a failed tag verification.
    expect(() => decryptBlob(generateAek(), blob)).toThrow(BlobIntegrityError);
  });

  it("still opens an older client's single-message blob", () => {
    const aek = generateAek();
    const iv = randomBytes(12);
    const legacy = new Uint8Array([...iv, ...gcm(aek, iv).encrypt(FILE)]);
    expect(decryptBlob(aek, legacy, FILE_SHA)).toEqual(FILE);
  });

  it("sizes the largest attachment so its blob fits the cap exactly", () => {
    for (const cap of [1_000, 70_000, 25 * 1024 * 1024]) {
      const max = maxAttachmentBytes(cap);
      expect(sealedBlobSize(max)).toBeLessThanOrEqual(cap);
      expect(sealedBlobSize(max + 1)).toBeGreaterThan(cap);
    }
  });
});

// Pure-JS AES-GCM over multi-chunk files: on a loaded CI runner (all test jobs share it) this
// crossed vitest's 5s default and timed out, so give the ciphers room to breathe.
describe("sealing a file from a source", { timeout: 30_000 }, () => {
  /** A multi-chunk file with a partial last chunk. */
  const BIG = noise(3 * BLOB_CHUNK_SIZE + 1234);

  function countingSource(bytes: Uint8Array): AttachmentSource & { reads: number[] } {
    const reads: number[] = [];
    return {
      reads,
      size: bytes.length,
      read: async (offset, length) => {
        reads.push(length);
        return bytes.slice(offset, offset + length);
      },
    };
  }

  it("reads the file in ranges and seals it chunk by chunk", async () => {
    const aek = generateAek();
    const source = countingSource(BIG);
    const sealed = await sealSource(aek, source);
    const blob = sealed.ciphertext as Uint8Array;
    expect(sealed.size).toBe(blob.length);
    expect(sealed.sha).toBe(bytesToHex(sha256(blob)));
    expect(sealed.plainSha).toBe(bytesToHex(sha256(BIG)));
    expect(decryptBlob(aek, blob, sealed.plainSha)).toEqual(BIG);
    expect(source.reads.reduce((a, b) => a + b, 0)).toBe(BIG.length);
  });

  it("reads a large file in bounded ranges", async () => {
    const huge = new Uint8Array(40 * BLOB_CHUNK_SIZE + 7);
    const source = countingSource(huge);
    await sealSource(generateAek(), source);
    expect(source.reads.length).toBeGreaterThan(1);
    expect(Math.max(...source.reads)).toBeLessThanOrEqual(16 * BLOB_CHUNK_SIZE);
  });

  it("seals an empty file and a file of whole chunks", async () => {
    for (const file of [new Uint8Array(), noise(2 * BLOB_CHUNK_SIZE)]) {
      const aek = generateAek();
      const sealed = await sealSource(aek, bytesSource(file));
      expect(sealed.size).toBe(sealedBlobSize(file.length));
      expect(decryptBlob(aek, sealed.ciphertext as Uint8Array)).toEqual(file);
    }
  });

  it("writes a Blob when asked, sealed exactly like the buffer", async () => {
    const aek = generateAek();
    const sealed = await sealSource(aek, blobSource(new Blob([BIG as BlobPart])), {
      asBlob: true,
    });
    expect(sealed.ciphertext).toBeInstanceOf(Blob);
    const bytes = new Uint8Array(await (sealed.ciphertext as Blob).arrayBuffer());
    expect(bytes.length).toBe(sealed.size);
    expect(bytesToHex(sha256(bytes))).toBe(sealed.sha);
    expect(decryptBlob(aek, bytes)).toEqual(BIG);
  });

  it("fails when the file changes while it is read", async () => {
    const shrunk: AttachmentSource = {
      size: BIG.length,
      read: async (offset, length) => BIG.slice(offset, offset + Math.min(length, 10)),
    };
    await expect(sealSource(generateAek(), shrunk)).rejects.toThrow(/changed/);
  });
});

describe("attachment meta crypto (__aenc marker)", () => {
  it("round-trips the descriptive meta under the AEK", () => {
    const aek = generateAek();
    const meta = encryptMeta(aek, {
      filename: "report.txt",
      mime: "text/plain",
      plain_sha: "f".repeat(64),
      dims: { width: 10, height: 20 },
    });
    expect(meta.__aenc).toBe(1);
    expect(decryptMeta(aek, meta)).toEqual({
      filename: "report.txt",
      mime: "text/plain",
      plain_sha: "f".repeat(64),
      dims: { width: 10, height: 20 },
    });
  });

  it("is opaque to the generic __enc wire path — the markers never meet", () => {
    const aek = generateAek();
    const scopeKey = generateDek();
    const keyring = new Keyring({ dek: scopeKey });
    const meta = encryptMeta(aek, { filename: "f", mime: "m", plain_sha: "a".repeat(64) });

    const wire: WireOp = {
      id: "op-1",
      entity: "attachment",
      entity_id: "att-1",
      ts: { wall_ms: 1000, counter: 0, node: NODE },
      op: "set",
      field: "meta",
      value: meta,
    };
    // A pulled op carrying an __aenc payload is NOT decrypted by the generic path (it decrypts
    // only __enc values) — the payload round-trips as ciphertext, untouched.
    const back = fromEncryptedWire(wire, keyring, null);
    expect(back.op).toBe("set");
    if (back.op === "set") expect(back.value).toEqual(meta);
    // Marker separation runs deeper than the check: even FORCING the generic decrypt with the
    // scope key cannot read it — the payload is locked to the AEK.
    expect(() =>
      decryptJson(scopeKey, meta as unknown as { __enc: 1; iv: string; ct: string }),
    ).toThrow();
    // Only the AEK path reads it.
    expect(decryptMeta(aek, meta).filename).toBe("f");
  });

  it("leaves only the blob addresses readable: public and in plaintext", () => {
    // blob_sha authorizes downloads and keeps blobs alive, so the server reads it; the task link
    // and the already encrypted `meta` are sealed like any field (protocol 7).
    const keyring = new Keyring({ dek: generateDek() });
    keyring.setProjectKey("proj-1", generatePek());
    const ts = { wallMs: 1000, counter: 0, node: NODE };
    const meta = encryptMeta(generateAek(), {
      filename: "f",
      mime: "m",
      plain_sha: "a".repeat(64),
    });
    const fields: [string, unknown][] = [
      ["task_id", "task-1"],
      ["blob_sha", "b".repeat(64)],
      ["meta", meta],
    ];
    for (const [field, value] of fields) {
      const wire = toEncryptedWire(
        { id: "op-1", entity: "attachment", entityId: "att-1", ts, op: "set", field, value },
        keyring,
        "proj-1",
      );
      expect(wire.op).toBe("set");
      if (wire.op !== "set") continue;
      if (field === "blob_sha") {
        expect(wire.field).toBe("blob_sha");
        expect(wire.value).toEqual(value); // untouched by toEncryptedWire
      } else {
        expect(wire.field).toMatch(/^[0-9a-f]{32}$/);
        expect(wire.value).toMatchObject({ __enc: 3 });
      }
      expect(wire).toMatchObject({ entity: "todo.sealed", scope: "proj-1" });
      expect(fromEncryptedWire(wire, keyring)).toMatchObject({
        entity: "attachment",
        field,
        value,
      });
    }
  });

  it("rejects payloads without the __aenc marker", () => {
    const generic = { __enc: 1 as const, iv: "aXY=", ct: "Y3Q=" };
    expect(() => decryptMeta(generateAek(), generic as never)).toThrow(BlobIntegrityError);
  });
});

describe("AEK wrapping (scope keys)", () => {
  it("wraps under the project PEK and unwraps only for holders of that PEK", () => {
    // Mirrors the shared-project pattern in api-encryption.test.ts: the AEK is only as reachable
    // as the project key it was wrapped under.
    const dek = generateDek();
    const pek = generatePek();
    const aek = generateAek();

    const wrapped = wrapAek(aek, projectScopeKey(pek, "proj-1"), "att-1");
    expect(wrapped).toMatchObject({ v: 2, kid: projectKeyId(pek) });
    expect(unwrapAek(wrapped, projectScopeKey(pek, "proj-1"), "att-1")).toEqual(aek);
    // A keyring (or user) holding only the personal DEK cannot unwrap it.
    expect(() => unwrapAek(wrapped, personalKey(new Keyring({ dek })), "att-1")).toThrow();
  });

  it("wraps under the personal DEK when there is no project scope", () => {
    const keyring = new Keyring({ dek: generateDek() });
    const aek = generateAek();
    const wrapped = wrapAek(aek, personalKey(keyring), "att-1");
    expect(wrapped.kid).toBe(DEK_KEY_ID);
    expect(unwrapAek(wrapped, personalKey(keyring), "att-1")).toEqual(aek);
    const other = new Keyring({ dek: generateDek() });
    expect(() => unwrapAek(wrapped, personalKey(other), "att-1")).toThrow();
  });

  it("binds the wrapped key to its attachment and scope", () => {
    const pek = generatePek();
    const aek = generateAek();
    const wrapped = wrapAek(aek, projectScopeKey(pek, "proj-1"), "att-1");
    // Copied onto another attachment, or claimed for another project holding the same key, it
    // does not open.
    expect(() => unwrapAek(wrapped, projectScopeKey(pek, "proj-1"), "att-2")).toThrow();
    expect(() => unwrapAek(wrapped, projectScopeKey(pek, "proj-2"), "att-1")).toThrow();

    const keyring = new Keyring({ dek: generateDek() });
    keyring.setProjectKey("proj-1", pek);
    expect(unwrapAekAny(wrapped, keyring, "att-1")).toEqual(aek);
    expect(() => unwrapAekAny(wrapped, keyring, "att-2")).toThrow(BlobIntegrityError);
  });

  it("opens a bound key with the project key its kid names, canonical or not", () => {
    const keyring = new Keyring({ dek: generateDek() });
    const older = generatePek();
    keyring.addProjectKey("proj-1", projectKeyId(older), older);
    keyring.setProjectKey("proj-1", generatePek());
    const aek = generateAek();
    const wrapped = wrapAek(aek, projectScopeKey(older, "proj-1"), "att-1");
    expect(unwrapAekAny(wrapped, keyring, "att-1")).toEqual(aek);
  });

  it("still reads an older client's unbound wrapped key", () => {
    const keyring = new Keyring({ dek: generateDek() });
    const pek = generatePek();
    keyring.setProjectKey("proj-1", pek);
    const aek = generateAek();
    const unbound = wrapKey(aek, pek);
    expect(unwrapAek(unbound, projectScopeKey(pek, "proj-1"), "att-1")).toEqual(aek);
    expect(unwrapAekAny(unbound, keyring, "att-1")).toEqual(aek);
    expect(unwrapAekAny(unbound, keyring, "att-1", pek)).toEqual(aek);
  });
});

// Decrypts multi-chunk blobs in pure JS; see "sealing a file from a source" for the timeout.
describe("fetchBlob (download path)", { timeout: 30_000 }, () => {
  function transportReturning(body: Uint8Array | BlobDownload): BlobTransport {
    return { put: vi.fn(), get: vi.fn(async () => body) };
  }

  /** `bytes` as a download arriving in pieces of `size` bytes. */
  function inPieces(bytes: Uint8Array, size: number, declared: number | null = bytes.length) {
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, at + size);
    }
    return { size: declared, chunks: chunks() };
  }

  it("fetches, verifies the address, and decrypts", async () => {
    const aek = generateAek();
    const { sha, blob } = encryptBlob(aek, FILE);
    await expect(fetchBlob(transportReturning(blob), sha, aek)).resolves.toEqual(FILE);
  });

  it("decrypts a multi-chunk blob streamed in pieces of any size", async () => {
    const aek = generateAek();
    const file = noise(2 * BLOB_CHUNK_SIZE + 999);
    const { sha, blob } = encryptBlob(aek, file);
    const plainSha = bytesToHex(sha256(file));
    for (const [size, declared] of [
      [1, blob.length],
      [7_777, null],
      [BLOB_CHUNK_SIZE + 16, blob.length],
      [blob.length, 2 ** 40],
      [3_000, 10], // a length the server under-declared
    ] as const) {
      const download = inPieces(blob, size, declared);
      await expect(fetchBlob(transportReturning(download), sha, aek, plainSha)).resolves.toEqual(
        file,
      );
    }
  });

  it("poisons a body that does not hash to its address — clear error, nothing decrypted", async () => {
    const aek = generateAek();
    const { sha } = encryptBlob(aek, FILE);
    const lie = utf8ToBytes("not the blob you asked for");
    await expect(fetchBlob(transportReturning(lie), sha, aek)).rejects.toThrow(BlobIntegrityError);
    // A different blob that opens under the same key is still not the one asked for.
    const other = encryptBlob(aek, FILE).blob;
    await expect(fetchBlob(transportReturning(other), sha, aek)).rejects.toThrow(
      BlobIntegrityError,
    );
  });

  it("refuses a stream cut short at a chunk boundary", async () => {
    const aek = generateAek();
    const { sha, blob } = encryptBlob(aek, noise(2 * BLOB_CHUNK_SIZE + 5));
    const cut = blob.subarray(0, blob.length - (5 + 16));
    await expect(fetchBlob(transportReturning(inPieces(cut, 4096)), sha, aek)).rejects.toThrow(
      BlobIntegrityError,
    );
  });

  it("verifies the plaintext against the meta's plain sha after decrypting", async () => {
    const aek = generateAek();
    const { sha, blob } = encryptBlob(aek, FILE);
    // Right bytes, wrong recorded plain sha → the file is not the one the metadata describes.
    await expect(fetchBlob(transportReturning(blob), sha, aek, "f".repeat(64))).rejects.toThrow(
      BlobIntegrityError,
    );
    await expect(fetchBlob(transportReturning(blob), sha, aek, FILE_SHA)).resolves.toEqual(FILE);
  });

  it("opens an older client's single-message blob", async () => {
    const aek = generateAek();
    const iv = randomBytes(12);
    const legacy = new Uint8Array([...iv, ...gcm(aek, iv).encrypt(FILE)]);
    const sha = bytesToHex(sha256(legacy));
    await expect(
      fetchBlob(transportReturning(inPieces(legacy, 5)), sha, aek, FILE_SHA),
    ).resolves.toEqual(FILE);
  });

  it("propagates 403/404 as the transport's typed errors", async () => {
    const forbidden: BlobTransport = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new ApiError(403, "no live attachment references this blob in your account");
      }),
    };
    const gone: BlobTransport = {
      put: vi.fn(),
      get: vi.fn(async () => {
        throw new ApiError(404, "not found");
      }),
    };
    await expect(fetchBlob(forbidden, "a".repeat(64), generateAek())).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
    });
    await expect(fetchBlob(gone, "a".repeat(64), generateAek())).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });
});

// ---- ApiClient blob transport ----

function okResponse(status: number): Response {
  return new Response(JSON.stringify({ sha256: "x" }), { status });
}

describe("ApiClient blob transport (putBlob/getBlob)", () => {
  it("PUTs a raw octet-stream body with the auth header and maps 201/200 exactly", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(okResponse(201));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(client.putBlob("a".repeat(64), bytes)).resolves.toBe("stored");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://x/attachments/blobs/${"a".repeat(64)}`);
    expect(init!.method).toBe("PUT");
    const headers = init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(init!.body).toEqual(bytes); // ciphertext only — never JSON-encoded

    // 200 = the blob was already there (idempotent re-accept) — "exists", not an error.
    fetchMock.mockResolvedValue(okResponse(200));
    await expect(client.putBlob("a".repeat(64), bytes)).resolves.toBe("exists");
  });

  it("PUTs a Blob body as it is, for the browser to stream", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(okResponse(201));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });
    const body = new Blob([new Uint8Array([1, 2, 3])]);
    await expect(client.putBlob("a".repeat(64), body)).resolves.toBe("stored");
    expect(fetchMock.mock.calls[0]![1]!.body).toBe(body);
  });

  it("sends blob requests, and only those, through the blob fetch", async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(Response.json({ enabled: true }));
    const blobFetch = vi.fn<FetchLike>().mockResolvedValue(okResponse(201));
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "tok",
      fetch: fetchMock,
      blobFetch,
    });
    await client.putBlob("a".repeat(64), new Uint8Array([1]));
    await client.getAttachmentConfig();
    expect(blobFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://x/attachments/config");
  });

  it("streams a download piece by piece, with its declared length", async () => {
    const pieces = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of pieces) controller.enqueue(p);
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response(body, { status: 200, headers: { "content-length": "6" } }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });
    const download = await client.streamBlob("b".repeat(64));
    expect(download.size).toBe(6);
    const got: Uint8Array[] = [];
    for await (const piece of download.chunks) got.push(piece);
    expect(got).toEqual(pieces);
  });

  it("yields a body it cannot stream whole", async () => {
    const blob = new Uint8Array([9, 8, 7]);
    const res = new Response(blob, { status: 200 });
    Object.defineProperty(res, "body", { value: undefined });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "tok",
      fetch: vi.fn<FetchLike>().mockResolvedValue(res),
    });
    const download = await client.streamBlob("b".repeat(64));
    const got: Uint8Array[] = [];
    for await (const piece of download.chunks) got.push(piece);
    expect(got).toEqual([blob]);
  });

  it("reports a connection lost mid-download as a NetworkError", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new TypeError("connection reset"));
      },
    });
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "tok",
      fetch: vi.fn<FetchLike>().mockResolvedValue(new Response(body, { status: 200 })),
    });
    const download = await client.streamBlob("b".repeat(64));
    await expect(
      (async () => {
        for await (const _ of download.chunks) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ name: "NetworkError" });
  });

  it("GETs the raw ciphertext bytes", async () => {
    const blob = new Uint8Array([9, 8, 7]);
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue(new Response(blob, { status: 200 }));
    const client = new ApiClient({ baseUrl: "http://x", token: "tok", fetch: fetchMock });
    await expect(client.getBlob("b".repeat(64))).resolves.toEqual(blob);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://x/attachments/blobs/${"b".repeat(64)}`);
    expect((init!.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  });

  it("refreshes once on a 401 and replays the blob request with the new token", async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      // 1) blob PUT → 401  2) refresh → new tokens  3) replayed PUT → 201
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 900,
            device_id: "d",
            user: { id: "u", email: "e", display_name: "" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(okResponse(201));
    const client = new ApiClient({
      baseUrl: "http://x",
      token: "stale",
      refreshToken: "r",
      fetch: fetchMock,
    });

    await expect(client.putBlob("c".repeat(64), new Uint8Array([1]))).resolves.toBe("stored");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe("http://x/auth/refresh");
    const replayHeaders = fetchMock.mock.calls[2]![1]!.headers as Record<string, string>;
    expect(replayHeaders["authorization"]).toBe("Bearer new-access");
  });

  it("passes server rejections through as ApiErrors with their status", async () => {
    const mismatch = new ApiClient({
      baseUrl: "http://x",
      token: "tok",
      fetch: vi
        .fn<FetchLike>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "sha256 mismatch" }), { status: 409 }),
        ),
    });
    await expect(mismatch.putBlob("d".repeat(64), new Uint8Array([1]))).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      message: "sha256 mismatch",
    });

    const quota = new ApiClient({
      baseUrl: "http://x",
      token: "tok",
      fetch: vi
        .fn<FetchLike>()
        .mockResolvedValue(new Response(JSON.stringify({ error: "over quota" }), { status: 413 })),
    });
    await expect(quota.putBlob("e".repeat(64), new Uint8Array([1]))).rejects.toMatchObject({
      status: 413,
    });

    const unreachable = new ApiClient({
      baseUrl: "http://x",
      fetch: vi.fn<FetchLike>().mockRejectedValue(new TypeError("network down")),
    });
    await expect(unreachable.getBlob("f".repeat(64))).rejects.toMatchObject({
      name: "NetworkError",
    });
  });
});

// ---- Upload queue ----

/**
 * A real LocalStore stands in as the AttachmentStore port, so outbox assertions exercise the
 * ordinary `set`-per-field path (and, with a persistence attached, the durability ordering).
 */
function makeStore(persistence?: Persistence): LocalStore {
  let n = 0;
  return new LocalStore(NODE, { newId: () => `op-${n++}`, persistence });
}

interface Harness {
  queue: AttachmentQueue;
  persistence: MemoryPersistence;
  store: LocalStore;
  transport: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  events: AttachmentQueueEvent[];
  setNow(ms: number): void;
  keyring: Keyring;
}

function harness(opts: { now?: number } = {}): Harness {
  let now = opts.now ?? 1_000_000;
  const persistence = new MemoryPersistence();
  const store = makeStore();
  const transport = {
    put: vi.fn(async () => "stored" as const),
    get: vi.fn(async () => new Uint8Array()),
  };
  const events: AttachmentQueueEvent[] = [];
  const keyring = new Keyring({ dek: generateDek() });
  let entrySeq = 0;
  const queue = new AttachmentQueue({
    transport,
    persistence,
    keyring,
    store,
    now: () => now,
    newId: () => `att-${entrySeq++}`,
    random: () => 0.5, // no jitter — backoff delays are exactly base * 2^(attempts-1)
    onStateChange: (e) => events.push(e),
  });
  return {
    queue,
    persistence,
    store,
    transport,
    events,
    keyring,
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

function attachmentOps(store: LocalStore): Operation[] {
  return store.unsyncedOps().filter((o) => o.entity === "attachment");
}

describe("AttachmentQueue", () => {
  it("encrypts at enqueue time so the durable row is upload-ready without the plaintext", async () => {
    const h = harness();
    const entry = await h.queue.enqueue(DRAFT);

    const rows = await h.persistence.loadAttachmentQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(entry);
    expect(rows[0]!.state).toBe("queued");
    expect(rows[0]!.thumbSha).toBeNull(); // v1: no thumbnails
    // From the durable row alone — no plaintext anywhere — the upload payload can be rebuilt:
    // unwrap the AEK, read the meta, and recover the original bytes against the recorded sha.
    const aek = unwrapAek(rows[0]!.wrappedKey, personalKey(h.keyring), rows[0]!.id);
    const meta = decryptMeta(aek, rows[0]!.meta);
    expect(meta).toMatchObject({ filename: "report.txt", mime: "text/plain", plain_sha: FILE_SHA });
    const ciphertext = rows[0]!.ciphertext as Uint8Array;
    expect(decryptBlob(aek, ciphertext, meta.plain_sha)).toEqual(FILE);
    // And the row's address is the sha of the exact bytes that will be PUT.
    expect(rows[0]!.blobSha).toBe(bytesToHex(sha256(ciphertext)));
    expect(rows[0]!.blobSize).toBe(ciphertext.length);
  });

  it("queues the AEK under the DEK and re-wraps it for the task's shared project at release", async () => {
    const h = harness();
    const pek = generatePek();
    h.keyring.setProjectKey("proj-1", pek);
    await h.queue.enqueue({ ...DRAFT, projectId: null });
    const row = (await h.persistence.loadAttachmentQueue())[0]!;
    expect(unwrapAek(row.wrappedKey, personalKey(h.keyring), row.id)).toBeDefined();

    // Before the release, the task moved into a project that is now shared.
    h.store.set("task", "task-1", "project_id", "proj-1");
    h.store.set("project_member", "m-1", "project_id", "proj-1");
    h.store.set("project_member", "m-1", "state", "active");
    await h.queue.drain();
    const released = h.store.get("attachment", row.id)!.wrapped_key as typeof row.wrappedKey;
    expect(released).toMatchObject({ v: 2, kid: projectKeyId(pek) });
    expect(unwrapAek(released, projectScopeKey(pek, "proj-1"), row.id)).toBeDefined();
    expect(() => unwrapAek(released, personalKey(h.keyring), row.id)).toThrow();
  });

  it("drains blob-first: the metadata op is enqueued only after the put attempt resolves", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    let resolvePut!: (v: "stored") => void;
    h.transport.put.mockImplementationOnce(
      () => new Promise<"stored">((resolve) => (resolvePut = resolve)),
    );

    const draining = h.queue.drain();
    await vi.waitFor(() => expect(h.transport.put).toHaveBeenCalled());
    // The put is in flight and NOTHING has been published yet.
    expect(attachmentOps(h.store)).toHaveLength(0);

    resolvePut("stored");
    const summary = await draining;
    expect(summary.stored).toBe(1);
    // All eight metadata fields are now in the outbox, keyed to the entry's entity id.
    const ops = attachmentOps(h.store);
    expect(ops.map((o) => (o.op === "set" ? o.field : ""))).toEqual([
      "task_id",
      "blob_sha",
      "thumb_sha",
      "blob_size",
      "wrapped_key",
      "meta",
      "sort_order",
      "created_at",
    ]);
    expect(ops.every((o) => o.entityId === "att-0")).toBe(true);
    // A stored entry leaves the queue: its work now lives in the op log.
    expect(await h.queue.entries()).toHaveLength(0);
    expect(h.events.map((e) => e.state)).toEqual(["queued", "uploading", "stored"]);
  });

  it("never blocks the metadata beyond one attempt: a transient failure still releases it", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValue(new NetworkError("airplane mode"));

    const summary = await h.queue.drain();
    expect(summary.stored).toBe(0);
    expect(summary.retried).toBe(1);
    // Metadata flowed despite the failed blob attempt…
    expect(attachmentOps(h.store).map((o) => (o.op === "set" ? o.field : ""))).toContain(
      "blob_sha",
    );
    // …while the blob entry stays queued for a later drain, one attempt deeper into the backoff.
    const row = (await h.queue.entries())[0]!;
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBe(1_000_000 + 1_000); // base delay, no jitter
    expect(row.lastError).toBe("airplane mode");
    expect(row.metaReleased).toBe(true);
    expect(h.events.map((e) => e.state)).toEqual(["queued", "uploading", "queued"]);
  });

  it("backs off exponentially and only retries once the window has elapsed", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValue(new NetworkError("offline"));

    // Attempt 1 at t=1_000_000 → next try at +1000.
    await h.queue.drain();
    // An immediate re-drain defers: the entry is not due yet.
    expect(await h.queue.drain()).toEqual({
      stored: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      deferred: 1,
    });
    expect(h.transport.put).toHaveBeenCalledTimes(1);

    // Attempt 2 at t=1_001_000 → the delay doubles.
    h.setNow(1_001_000);
    await h.queue.drain();
    expect((await h.queue.entries())[0]!.attempts).toBe(2);
    expect((await h.queue.entries())[0]!.nextAttemptAt).toBe(1_001_000 + 2_000);

    // Attempt 3 at t=1_003_000 → 4000ms out.
    h.setNow(1_003_000);
    await h.queue.drain();
    expect((await h.queue.entries())[0]!.nextAttemptAt).toBe(1_003_000 + 4_000);
    expect(h.transport.put).toHaveBeenCalledTimes(3);
  });

  it("releases the metadata exactly once across retries", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValueOnce(new NetworkError("offline"));
    await h.queue.drain(); // transient failure → released here
    const released = attachmentOps(h.store).length;
    expect(released).toBe(8);

    // Success on a later drain must NOT publish the fields a second time.
    h.setNow(2_000_000);
    await h.queue.drain();
    expect(attachmentOps(h.store)).toHaveLength(released);
  });

  it("keeps retrying across a relaunch (new queue and store over the same durable persistence)", async () => {
    // Both durables are shared, exactly as in the app: the store's op log and the queue table.
    const queuePersistence = new MemoryPersistence();
    const storePersistence = new MemoryPersistence();

    // Enqueue offline: the first drain fails transiently — metadata released, blob still queued.
    let now = 1_000_000;
    let entrySeq = 0;
    const keyring = new Keyring({ dek: generateDek() });
    const firstStore = makeStore(storePersistence);
    const firstQueue = new AttachmentQueue({
      transport: {
        put: async () => {
          throw new NetworkError("offline");
        },
        get: async () => new Uint8Array(),
      },
      persistence: queuePersistence,
      keyring,
      store: firstStore,
      now: () => now,
      newId: () => `att-${entrySeq++}`,
      random: () => 0.5,
    });
    const draft = await firstQueue.enqueue(DRAFT);
    await firstQueue.drain();
    expect((await queuePersistence.loadAttachmentQueue())[0]!.state).toBe("queued");

    // Relaunch: fresh store (outbox rehydrated from the op log) + fresh queue over the same
    // durables, network back. Neither the ciphertext nor the released metadata was lost.
    now = 5_000_000;
    const relaunchedStore = makeStore(storePersistence);
    await relaunchedStore.hydrate();
    const putCalls: { sha: string; bytes: AttachmentCiphertext }[] = [];
    const events: AttachmentQueueEvent[] = [];
    const relaunched = new AttachmentQueue({
      transport: {
        put: async (sha, bytes) => {
          putCalls.push({ sha, bytes });
          return "stored";
        },
        get: async () => new Uint8Array(),
      },
      persistence: queuePersistence,
      keyring,
      store: relaunchedStore,
      now: () => now,
      newId: () => `att-${entrySeq++}`,
      random: () => 0.5,
      onStateChange: (e) => events.push(e),
    });

    const summary = await relaunched.drain();
    expect(summary.stored).toBe(1);
    // The persisted ciphertext — not the (long-gone) plaintext — is what got uploaded, under the
    // address computed at enqueue time.
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.sha).toBe(draft.blobSha);
    expect(putCalls[0]!.bytes).toEqual(draft.ciphertext);
    expect(await relaunched.entries()).toHaveLength(0);
    expect(events.map((e) => e.state)).toEqual(["uploading", "stored"]);
    // The metadata ops released before the relaunch are still the only ones in the (rehydrated)
    // outbox — the relaunch's successful re-PUT did not publish them again.
    expect(attachmentOps(relaunchedStore)).toHaveLength(8);
  });

  it("treats 413 as terminal: failed, no metadata, never retried", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValue(new ApiError(413, "over quota"));

    const summary = await h.queue.drain();
    expect(summary.failed).toBe(1);
    // A terminal failure must not publish an attachment whose blob can never exist.
    expect(attachmentOps(h.store)).toHaveLength(0);
    const row = (await h.queue.entries())[0]!;
    expect(row.state).toBe("failed");
    expect(row.lastError).toBe("over quota");
    expect(row.metaReleased).toBe(false);

    // Terminal entries are dead: the next drain neither retries nor defers them.
    expect(await h.queue.drain()).toEqual({
      stored: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      deferred: 0,
    });
    expect(h.transport.put).toHaveBeenCalledTimes(1);
  });

  it("answers a 403 with cancelled when the owning task is already tombstoned locally", async () => {
    const h = harness();
    h.store.set("task", "task-1", "title", "doomed");
    await h.queue.enqueue(DRAFT);
    h.store.remove("task", "task-1"); // deleted/revoked while the upload was pending
    h.transport.put.mockRejectedValue(new ApiError(403, "no live attachment references this blob"));

    const summary = await h.queue.drain();
    expect(summary.cancelled).toBe(1);
    expect((await h.queue.entries())[0]!.state).toBe("cancelled");
    expect(attachmentOps(h.store)).toHaveLength(0);
  });

  it("answers a 403 with failed when the owning task is still live", async () => {
    const h = harness();
    h.store.set("task", "task-1", "title", "still here"); // the task the attachment belongs to
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValue(new ApiError(403, "forbidden"));

    const summary = await h.queue.drain();
    expect(summary.failed).toBe(1);
    expect((await h.queue.entries())[0]!.state).toBe("failed");
  });

  it("coalesces concurrent drains into one loop (single-flight)", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    let resolvePut!: (v: "stored") => void;
    h.transport.put.mockImplementationOnce(
      () => new Promise<"stored">((resolve) => (resolvePut = resolve)),
    );

    const first = h.queue.drain();
    const second = h.queue.drain();
    expect(second).toBe(first); // the same in-flight loop, not a second uploader
    await vi.waitFor(() => expect(h.transport.put).toHaveBeenCalled());
    resolvePut("stored");
    expect(await first).toEqual({ stored: 1, retried: 0, failed: 0, cancelled: 0, deferred: 0 });
  });

  it("keeps ONE upload in flight, and entries enqueued mid-drain wait for the next drain", async () => {
    const h = harness();
    await h.queue.enqueue({ ...DRAFT, taskId: "task-a" });

    let inFlight = 0;
    let maxInFlight = 0;
    let firstCall = true;
    h.transport.put.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 0));
      inFlight--;
      if (firstCall) {
        firstCall = false;
        // A second file is enqueued while the first upload is still in flight…
        await h.queue.enqueue({ ...DRAFT, taskId: "task-b" });
      }
      return "stored" as const;
    });

    const summary = await h.queue.drain();
    expect(maxInFlight).toBe(1); // never two uploads in parallel
    expect(summary.stored).toBe(1); // …but only the first entry was drained this round
    expect(h.transport.put).toHaveBeenCalledTimes(1);
    expect(await h.queue.entries()).toHaveLength(1);

    // The next drain picks up what the in-flight round missed.
    expect((await h.queue.drain()).stored).toBe(1);
    expect(await h.queue.entries()).toHaveLength(0);
  });

  it("accepts an idempotent re-PUT ('exists') as a successful upload", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockResolvedValue("exists"); // the blob was already there (crash-retry case)
    const summary = await h.queue.drain();
    expect(summary.stored).toBe(1);
    expect(await h.queue.entries()).toHaveLength(0);
    expect(attachmentOps(h.store)).toHaveLength(8);
  });
});

describe("AttachmentQueue failure handling", () => {
  it.each([400, 404, 405, 409])(
    "treats %i as terminal: failed, no metadata, never retried",
    async (status) => {
      const h = harness();
      await h.queue.enqueue(DRAFT);
      // A server with attachments off answers 404 (or the web app's 405) to every upload.
      h.transport.put.mockRejectedValue(new ApiError(status, "no attachment service"));

      expect((await h.queue.drain()).failed).toBe(1);
      expect(attachmentOps(h.store)).toHaveLength(0);
      expect((await h.queue.entries())[0]!.state).toBe("failed");
      h.setNow(10_000_000_000);
      await h.queue.drain();
      expect(h.transport.put).toHaveBeenCalledTimes(1);
    },
  );

  it("gives up after repeated server failures, but never while merely offline", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    let now = 1_000_000;
    const drainLater = async () => {
      now += 60 * 60_000;
      h.setNow(now);
      await h.queue.drain();
    };
    h.transport.put.mockRejectedValue(new NetworkError("offline"));
    for (let i = 0; i < MAX_SERVER_ATTEMPTS + 2; i++) await drainLater();
    expect((await h.queue.entries())[0]!.state).toBe("queued");

    h.transport.put.mockRejectedValue(new ApiError(503, "unavailable"));
    const before = h.transport.put.mock.calls.length;
    for (let i = 0; i < MAX_SERVER_ATTEMPTS + 2; i++) await drainLater();
    expect((await h.queue.entries())[0]!.state).toBe("failed");
    // The count carried over from the offline attempts; it never exceeds the cap.
    expect(h.transport.put.mock.calls.length - before).toBeLessThanOrEqual(MAX_SERVER_ATTEMPTS);
  });

  it("waits at least as long as a 429 asks before retrying", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValue(new ApiError(429, "slow down", undefined, 120_000));
    await h.queue.drain();
    expect((await h.queue.entries())[0]!.nextAttemptAt).toBe(1_000_000 + 120_000);
  });

  it("lets a failed entry be retried", async () => {
    const h = harness();
    const entry = await h.queue.enqueue(DRAFT);
    h.transport.put.mockRejectedValueOnce(new ApiError(413, "over quota"));
    await h.queue.drain();
    await h.queue.retry(entry.id);
    expect((await h.queue.drain()).stored).toBe(1);
    expect(await h.queue.entries()).toHaveLength(0);
  });
});

describe("AttachmentQueue until the metadata is acknowledged", () => {
  /** The server acknowledged every attachment op in `store`'s outbox. */
  function ack(store: LocalStore): void {
    store.markSynced(attachmentOps(store).map((o) => o.id));
  }

  it("keeps a put entry until the server has acknowledged its metadata", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    await h.queue.drain();

    // Stored, not gone: its metadata still waits in the outbox. The UI has nothing to show for it.
    const [row] = await h.persistence.loadAttachmentQueue();
    expect(row).toMatchObject({ state: "stored", metaReleased: true, attempts: 0 });
    expect(row!.nextAttemptAt).toBe(1_000_000 + BLOB_REFRESH_MS);
    expect(await h.queue.entries()).toHaveLength(0);
    expect(await h.queue.drain()).toEqual({
      stored: 0,
      retried: 0,
      failed: 0,
      cancelled: 0,
      deferred: 0,
    });
    expect(await h.persistence.loadAttachmentQueue()).toHaveLength(1);

    // Acknowledged while the blob is fresh: the entry goes, with no second upload.
    ack(h.store);
    await h.queue.drain();
    expect(await h.persistence.loadAttachmentQueue()).toHaveLength(0);
    expect(h.transport.put).toHaveBeenCalledTimes(1);
    expect(attachmentOps(h.store)).toHaveLength(0);
  });

  it("puts a stale blob again before letting go, across a relaunch", async () => {
    // Put, then offline for longer than the server's GC grace before the metadata goes out.
    const queuePersistence = new MemoryPersistence();
    const storePersistence = new MemoryPersistence();
    const keyring = new Keyring({ dek: generateDek() });
    const put = vi.fn(async () => "stored" as const);
    let now = 1_000_000;
    const build = (store: LocalStore) =>
      new AttachmentQueue({
        transport: { put, get: async () => new Uint8Array() },
        persistence: queuePersistence,
        keyring,
        store,
        now: () => now,
        newId: () => "att-0",
        random: () => 0.5,
      });
    const firstStore = makeStore(storePersistence);
    const draft = await build(firstStore).enqueue(DRAFT);
    await build(firstStore).drain();
    await firstStore.flush();

    now += 40 * 24 * 60 * 60_000;
    const store = makeStore(storePersistence);
    await store.hydrate();
    const queue = build(store);
    await queue.drain();
    expect(put).toHaveBeenCalledTimes(1); // nothing to refresh while the metadata waits

    // The metadata reaches the server, whose GC may have freed the blob meanwhile: it goes up
    // again, and only then does the entry go.
    ack(store);
    const summary = await queue.drain();
    expect(summary.stored).toBe(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith(draft.blobSha, draft.ciphertext);
    expect(await queuePersistence.loadAttachmentQueue()).toHaveLength(0);
    expect(attachmentOps(store)).toHaveLength(0); // nothing released twice
  });

  it("re-queues a stale blob whose second put fails, without releasing the metadata again", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    await h.queue.drain();
    ack(h.store);
    h.setNow(1_000_000 + BLOB_REFRESH_MS);
    h.transport.put.mockRejectedValueOnce(new NetworkError("offline"));

    expect((await h.queue.drain()).retried).toBe(1);
    const [row] = await h.queue.entries();
    expect(row).toMatchObject({ state: "queued", metaReleased: true, attempts: 1 });
    expect(attachmentOps(h.store)).toHaveLength(0);

    // The retry succeeds; with the metadata already acknowledged, nothing is kept.
    h.setNow(1_000_000 + BLOB_REFRESH_MS + 1_000);
    expect((await h.queue.drain()).stored).toBe(1);
    expect(await h.persistence.loadAttachmentQueue()).toHaveLength(0);
    expect(h.transport.put).toHaveBeenCalledTimes(3);
  });
});

describe("AttachmentQueue memory and races", () => {
  it("rejects a file over the size cap before reading, encrypting or storing anything", async () => {
    const h = harness();
    const queue = new AttachmentQueue({
      transport: h.transport as unknown as BlobTransport,
      persistence: h.persistence,
      keyring: h.keyring,
      store: h.store,
      maxBlobBytes: () => sealedBlobSize(FILE.length) - 1,
    });
    const read = vi.fn(async () => FILE);
    await expect(
      queue.enqueue({ ...DRAFT, source: { size: FILE.length, read } }),
    ).rejects.toMatchObject({ name: "AttachmentTooLargeError", maxBytes: FILE.length - 1 });
    await expect(queue.enqueue(DRAFT)).rejects.toBeInstanceOf(AttachmentTooLargeError);
    expect(read).not.toHaveBeenCalled();
    expect(await h.persistence.loadAttachmentQueue()).toHaveLength(0);
  });

  it("queues a Blob of ciphertext when asked, and uploads that Blob", async () => {
    const h = harness();
    const queue = new AttachmentQueue({
      transport: h.transport as unknown as BlobTransport,
      persistence: h.persistence,
      keyring: h.keyring,
      store: h.store,
      ciphertextAsBlob: true,
    });
    const entry = await queue.enqueue({
      ...DRAFT,
      source: blobSource(new Blob([FILE as BlobPart])),
    });
    expect(entry.ciphertext).toBeInstanceOf(Blob);
    await queue.drain();
    const [sha, body] = h.transport.put.mock.calls[0]! as unknown as [string, Blob];
    expect(sha).toBe(entry.blobSha);
    expect(body).toBe(entry.ciphertext);
    const bytes = new Uint8Array(await body.arrayBuffer());
    expect(bytesToHex(sha256(bytes))).toBe(entry.blobSha);
  });

  it("loads only the uploading entry's ciphertext and never rewrites it", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    await h.queue.enqueue({ ...DRAFT, filename: "later.txt" });
    await h.queue.enqueue({ ...DRAFT, filename: "broken.txt" });
    const [, second, third] = await h.queue.entries();
    // One entry is backing off and one has failed for good; neither is due.
    await h.persistence.updateAttachmentUpload({ ...second!, nextAttemptAt: 9_000_000 });
    await h.persistence.updateAttachmentUpload({ ...third!, state: "failed" });
    const loads = vi.spyOn(h.persistence, "loadAttachmentCiphertext");
    const full = vi.spyOn(h.persistence, "loadAttachmentQueue");
    const puts = vi.spyOn(h.persistence, "putAttachmentUpload");
    h.transport.put.mockRejectedValue(new NetworkError("offline"));

    await h.queue.drain();
    await h.queue.drain();
    expect(full).not.toHaveBeenCalled();
    expect(puts).not.toHaveBeenCalled();
    // Two drains, one due entry: its ciphertext was read once per attempt, the others never.
    expect(loads.mock.calls.map(([id]) => id)).toEqual([(await h.queue.entries())[0]!.id]);
  });

  it("does not publish an entry removed while its upload was in flight", async () => {
    const h = harness();
    const entry = await h.queue.enqueue(DRAFT);
    let finish!: () => void;
    h.transport.put.mockImplementation(
      () => new Promise<"stored">((resolve) => (finish = () => resolve("stored"))),
    );
    const drained = h.queue.drain();
    await vi.waitFor(() => expect(h.transport.put).toHaveBeenCalled());
    await h.queue.remove(entry.id);
    finish();
    await drained;
    expect(attachmentOps(h.store)).toHaveLength(0);
    expect(await h.queue.entries()).toHaveLength(0);
  });

  it("uploads once when two queue instances over one persistence drain together", async () => {
    const h = harness();
    await h.queue.enqueue(DRAFT);
    // The provider rebuilds the queue whenever the keyring changes, possibly mid-drain.
    const rebuilt = new AttachmentQueue({
      transport: h.transport as unknown as BlobTransport,
      persistence: h.persistence,
      keyring: h.keyring,
      store: h.store,
      now: () => 1_000_000,
    });
    await Promise.all([h.queue.drain(), rebuilt.drain()]);
    expect(h.transport.put).toHaveBeenCalledTimes(1);
    expect(attachmentOps(h.store)).toHaveLength(8);
  });
});
