import { describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  BLOB_CHUNK_SIZE,
  BLOB_FORMAT_VERSION,
  BLOB_HEADER_LENGTH,
  BLOB_TAG_LENGTH,
  BlobIntegrityError,
  BlobOpener,
  BlobSealer,
  maxPlainSize,
  sealedBlobSize,
} from "./blob";
import { randomBytes, utf8ToBytes } from "./utils";

// Pure-JS AES-GCM over multi-megabyte blobs: on a loaded CI runner (all test jobs share it) this
// crossed the 5s default timeout, so give the ciphers room to breathe.
setDefaultTimeout(30_000);

/** `n` bytes of noise; `randomBytes` draws at most 64 KiB at once. */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) out.set(randomBytes(Math.min(65536, n - at)), at);
  return out;
}

const KEY = new Uint8Array(32).fill(7);

/** Seal `file` with `chunkSize`-byte chunks into one buffer. */
function seal(file: Uint8Array, chunkSize = BLOB_CHUNK_SIZE, key = KEY): Uint8Array {
  const sealer = new BlobSealer(key, { chunkSize });
  const parts = [sealer.header];
  for (let at = 0; ; at += chunkSize) {
    const end = Math.min(at + chunkSize, file.length);
    parts.push(sealer.seal(file.subarray(at, end), end === file.length));
    if (end === file.length) break;
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Open `blob`, fed in pieces of `piece` bytes. */
function open(blob: Uint8Array, piece = blob.length, key = KEY): Uint8Array {
  const opener = new BlobOpener(key);
  const out: Uint8Array[] = [];
  for (let at = 0; at < blob.length; at += piece)
    out.push(...opener.push(blob.slice(at, at + piece)));
  out.push(...opener.finish());
  return concat(out);
}

/** The sealed chunks of a blob with `chunkSize`-byte chunks, split apart. */
function chunksOf(blob: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = BLOB_HEADER_LENGTH; at < blob.length; at += chunkSize + BLOB_TAG_LENGTH) {
    out.push(blob.slice(at, at + chunkSize + BLOB_TAG_LENGTH));
  }
  return out;
}

describe("chunked blob format", () => {
  it("writes the documented header", () => {
    const prefix = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sealer = new BlobSealer(KEY, { noncePrefix: prefix });
    const header = sealer.header;
    expect(header.length).toBe(21);
    expect(new TextDecoder().decode(header.subarray(0, 8))).toBe("ATLSBLOB");
    expect(header[8]).toBe(BLOB_FORMAT_VERSION);
    expect(new DataView(header.buffer).getUint32(9, false)).toBe(64 * 1024);
    expect(header.subarray(13)).toEqual(prefix);
  });

  it.each([0, 1, 100, 99, 200, 1000])("round-trips a %i-byte file in 100-byte chunks", (n) => {
    const file = randomBytes(n);
    const blob = seal(file, 100);
    expect(blob.length).toBe(sealedBlobSize(n, 100));
    for (const piece of [1, 3, 116, 117, blob.length]) expect(open(blob, piece)).toEqual(file);
  });

  it("round-trips with the default chunk size", () => {
    const file = noise(2 * BLOB_CHUNK_SIZE + 17);
    expect(open(seal(file), 4096)).toEqual(file);
  });

  it("refuses a reordered chunk", () => {
    const blob = seal(randomBytes(350), 100);
    const [a, b, ...rest] = chunksOf(blob, 100);
    const swapped = concat([blob.subarray(0, BLOB_HEADER_LENGTH), b!, a!, ...rest]);
    expect(() => open(swapped)).toThrow(BlobIntegrityError);
  });

  it("refuses a blob cut short at a chunk boundary, or inside a chunk", () => {
    const blob = seal(randomBytes(350), 100);
    const chunks = chunksOf(blob, 100);
    const withoutLast = concat([blob.subarray(0, BLOB_HEADER_LENGTH), ...chunks.slice(0, -1)]);
    expect(() => open(withoutLast)).toThrow(BlobIntegrityError);
    expect(() => open(blob.subarray(0, blob.length - 1))).toThrow(BlobIntegrityError);
    expect(() => open(blob.subarray(0, BLOB_HEADER_LENGTH))).toThrow(BlobIntegrityError);
    expect(() => open(blob.subarray(0, 12))).toThrow(BlobIntegrityError);
  });

  it("refuses a chunk appended after the last one", () => {
    const blob = seal(randomBytes(300), 100);
    const chunks = chunksOf(blob, 100);
    const extended = concat([blob, chunks[0]!]);
    expect(() => open(extended)).toThrow(BlobIntegrityError);
  });

  it("refuses a changed header, a chunk from another blob, and the wrong key", () => {
    const file = randomBytes(250);
    const blob = seal(file, 100);
    const header = blob.slice();
    header[20]! ^= 1; // the nonce prefix
    expect(() => open(header)).toThrow(BlobIntegrityError);
    const version = blob.slice();
    version[8] = 3;
    expect(() => open(version)).toThrow(/version 3/);

    const other = seal(file, 100);
    const [first] = chunksOf(other, 100);
    const spliced = concat([
      blob.subarray(0, BLOB_HEADER_LENGTH),
      first!,
      ...chunksOf(blob, 100).slice(1),
    ]);
    expect(() => open(spliced)).toThrow(BlobIntegrityError);
    expect(() => open(blob, blob.length, new Uint8Array(32).fill(8))).toThrow(BlobIntegrityError);
  });

  it("refuses a header naming absurdly large chunks rather than buffering them", () => {
    const blob = seal(utf8ToBytes("x"), 100);
    new DataView(blob.buffer).setUint32(9, 0xffffffff, false);
    expect(() => open(blob)).toThrow(/out of range/);
  });

  it("returns a chunk only once the next bytes show it is not the last", () => {
    const blob = seal(randomBytes(200), 100);
    const opener = new BlobOpener(KEY);
    // Header plus the first chunk exactly: it could still be the last one.
    expect(opener.push(blob.subarray(0, BLOB_HEADER_LENGTH + 116))).toEqual([]);
    expect(
      opener.push(blob.subarray(BLOB_HEADER_LENGTH + 116, BLOB_HEADER_LENGTH + 117)),
    ).toHaveLength(1);
    opener.push(blob.subarray(BLOB_HEADER_LENGTH + 117));
    expect(opener.finish()).toHaveLength(1);
  });

  it("will not seal a short chunk before the last, or anything after it", () => {
    const sealer = new BlobSealer(KEY, { chunkSize: 100 });
    expect(() => sealer.seal(new Uint8Array(99), false)).toThrow();
    sealer.seal(new Uint8Array(10), true);
    expect(() => sealer.seal(new Uint8Array(10), true)).toThrow();
  });

  it("sizes blobs and the largest file a cap allows", () => {
    expect(sealedBlobSize(0)).toBe(21 + 16);
    expect(sealedBlobSize(BLOB_CHUNK_SIZE)).toBe(21 + BLOB_CHUNK_SIZE + 16);
    expect(sealedBlobSize(BLOB_CHUNK_SIZE + 1)).toBe(21 + BLOB_CHUNK_SIZE + 1 + 32);
    for (const cap of [0, 36, 37, 38, 21 + BLOB_CHUNK_SIZE + 16, 21 + BLOB_CHUNK_SIZE + 17]) {
      const max = maxPlainSize(cap);
      if (max > 0) expect(sealedBlobSize(max)).toBeLessThanOrEqual(cap);
      expect(sealedBlobSize(max + 1)).toBeGreaterThan(cap);
    }
  });
});
