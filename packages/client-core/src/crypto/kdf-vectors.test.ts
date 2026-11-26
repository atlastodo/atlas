import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argon2id } from "@noble/hashes/argon2.js";
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  CURRENT_KDF,
  LEGACY_KDF,
  UnsupportedKdfError,
  argon2idPortable,
  deriveAuthAndMekAsync,
  kdfForNewCredential,
  kdfFromWire,
  kdfToWire,
  setArgon2idProvider,
  type PasswordKdf,
} from "./kdf";
import { bytesToHex, hexToBytes, utf8ToBytes } from "./utils";

// The pure-JS Argon2id takes seconds per vector: on a loaded CI runner (all test jobs share it)
// this crossed the 5s default timeout, so give the KDF room to breathe.
setDefaultTimeout(30_000);

/**
 * The password KDF must give every client the same master key for the same password, or an account
 * made on one platform cannot sign in on another. `test-vectors/password_kdf_vectors.json` pins the
 * raw Argon2id against the reference implementation's vectors and the whole login derivation of
 * both versions; the app's platform implementations (WebAssembly, the Android module) are checked
 * against the same file.
 */

interface Argon2Vector {
  name: string;
  password: string;
  salt: string;
  iterations: number;
  memory_kib: number;
  parallelism: number;
  hash: string;
}

interface Derivation {
  name: string;
  password: string;
  salt: string;
  kdf_version: number;
  kdf_params: Record<string, number>;
  master_key: string;
  auth_hash: string;
  mek: string;
}

const fixturePath = fileURLToPath(
  new URL("../../../../test-vectors/password_kdf_vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  argon2id: Argon2Vector[];
  rfc9106_argon2id: {
    password_hex: string;
    salt_hex: string;
    secret_hex: string;
    associated_data_hex: string;
    iterations: number;
    memory_kib: number;
    parallelism: number;
    hash: string;
  };
  derivations: Derivation[];
};

describe("Argon2id vectors", () => {
  for (const v of fixture.argon2id) {
    it(`the portable implementation reproduces ${v.name}`, async () => {
      const out = await argon2idPortable(
        utf8ToBytes(v.password),
        utf8ToBytes(v.salt),
        { memoryKib: v.memory_kib, iterations: v.iterations, parallelism: v.parallelism },
        32,
      );
      expect(bytesToHex(out)).toBe(v.hash);
    });
  }

  it("the portable implementation reproduces RFC 9106 section 5.3", () => {
    // The async wrapper takes no secret or associated data; the same library's sync form does.
    const v = fixture.rfc9106_argon2id;
    const out = argon2id(hexToBytes(v.password_hex), hexToBytes(v.salt_hex), {
      t: v.iterations,
      m: v.memory_kib,
      p: v.parallelism,
      key: hexToBytes(v.secret_hex),
      personalization: hexToBytes(v.associated_data_hex),
      dkLen: 32,
    });
    expect(bytesToHex(out)).toBe(v.hash);
  });
});

describe("login derivation vectors", () => {
  for (const v of fixture.derivations) {
    it(`derives ${v.name}`, async () => {
      const kdf = kdfFromWire(v.kdf_version, v.kdf_params);
      expect(kdf).not.toBeNull();
      const derived = await deriveAuthAndMekAsync(v.password, v.salt, kdf!);
      expect(derived.authHash).toBe(v.auth_hash);
      expect(bytesToHex(derived.mek)).toBe(v.mek);
    }, 60_000);
  }

  it("normalizes the password to NFC for version 2 and not for version 1", () => {
    const byName = new Map(fixture.derivations.map((v) => [v.name, v]));
    const same = (a: string, b: string) => byName.get(a)!.auth_hash === byName.get(b)!.auth_hash;
    expect(byName.get("argon2id-decomposed-normalized")!.password).not.toBe(
      byName.get("argon2id-composed")!.password,
    );
    expect(same("argon2id-decomposed-normalized", "argon2id-composed")).toBe(true);
    expect(same("pbkdf2-decomposed-not-normalized", "pbkdf2-composed")).toBe(false);
  });
});

describe("the Argon2id provider seam", () => {
  afterEach(() => setArgon2idProvider(null));
  const v = fixture.derivations.find((d) => d.kdf_version === 2)!;
  const kdf = kdfFromWire(v.kdf_version, v.kdf_params)!;

  it("runs version 2 through a registered provider, with the normalized password", async () => {
    const seen: string[] = [];
    setArgon2idProvider(async (password, salt, params, keyLength) => {
      seen.push(new TextDecoder().decode(password));
      return argon2idPortable(password, salt, params, keyLength);
    });
    const derived = await deriveAuthAndMekAsync(v.password, v.salt, kdf);
    expect(seen).toEqual([v.password.normalize("NFC")]);
    expect(derived.authHash).toBe(v.auth_hash);
  }, 60_000);

  it("falls back to the portable implementation when the provider fails or answers short", async () => {
    for (const provider of [
      async () => {
        throw new Error("no native module");
      },
      async () => new Uint8Array(16),
    ]) {
      setArgon2idProvider(provider);
      const derived = await deriveAuthAndMekAsync(v.password, v.salt, kdf);
      expect(derived.authHash).toBe(v.auth_hash);
    }
  }, 60_000);

  it("never consults it for version 1", async () => {
    let calls = 0;
    setArgon2idProvider(async () => {
      calls++;
      return new Uint8Array(32);
    });
    await deriveAuthAndMekAsync("pw", "000102030405060708090a0b0c0d0e0f", {
      version: 1,
      iterations: 1000,
    });
    expect(calls).toBe(0);
  });
});

describe("kdfFromWire", () => {
  it("reads the server's two versions and round-trips kdfToWire", () => {
    for (const kdf of [LEGACY_KDF, CURRENT_KDF] as PasswordKdf[]) {
      const wire = kdfToWire(kdf);
      expect(kdfFromWire(wire.kdf_version, wire.kdf_params)).toEqual(kdf);
    }
    expect(kdfToWire(CURRENT_KDF)).toEqual({
      kdf_version: 2,
      kdf_params: { iterations: 3, memory_kib: 65536, parallelism: 1 },
    });
    expect(kdfFromWire(2, { iterations: 10, memory_kib: 262144, parallelism: 4 })).toEqual({
      version: 2,
      memoryKib: 262144,
      iterations: 10,
      parallelism: 4,
    });
  });

  it("reads a server that names no KDF as one that predates them", () => {
    expect(kdfFromWire(undefined, undefined)).toBeNull();
    expect(kdfFromWire(null, null)).toBeNull();
    expect(kdfForNewCredential({})).toEqual(LEGACY_KDF);
    expect(kdfForNewCredential({ kdf_version: null })).toEqual(LEGACY_KDF);
    // A server that names any version stores the one a request names.
    expect(kdfForNewCredential({ kdf_version: 1 })).toEqual(CURRENT_KDF);
    expect(kdfForNewCredential({ kdf_version: 2 })).toEqual(CURRENT_KDF);
  });

  it("refuses parameters weaker or costlier than it runs, and anything unknown", () => {
    const refused: [unknown, unknown][] = [
      [2, { iterations: 3, memory_kib: 1024, parallelism: 1 }],
      [2, { iterations: 2, memory_kib: 65536, parallelism: 1 }],
      [2, { iterations: 3, memory_kib: 262145, parallelism: 1 }],
      [2, { iterations: 11, memory_kib: 65536, parallelism: 1 }],
      [2, { iterations: 3, memory_kib: 65536, parallelism: 5 }],
      [2, { iterations: 3, memory_kib: 65536, parallelism: 0 }],
      [2, { iterations: 3, memory_kib: 65536 }],
      [2, { iterations: 3, memory_kib: 65536, parallelism: 1, secret: 1 }],
      [2, { iterations: 3.5, memory_kib: 65536, parallelism: 1 }],
      [2, { iterations: "3", memory_kib: 65536, parallelism: 1 }],
      [2, [3, 65536, 1]],
      [2, undefined],
      [1, { iterations: 1000 }],
      [1, { iterations: 600000, extra: 1 }],
      [3, { iterations: 3, memory_kib: 65536, parallelism: 1 }],
      [undefined, { iterations: 600000 }],
    ];
    for (const [version, params] of refused) {
      expect(() => kdfFromWire(version, params), JSON.stringify([version, params])).toThrow(
        UnsupportedKdfError,
      );
    }
  });
});
