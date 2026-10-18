import { bytesToHex, deriveAuthAndMekAsync, kdfFromWire } from "@atlastodo/client-core";
// Registers at import, as the app's entry does (over the double below).
import "./argon2id";

/**
 * The Android module's JS glue: bytes cross to the native side as hex and come back as hex. The
 * module itself (Bouncy Castle) only runs on a device; this double computes the same Argon2id, so a
 * mistake in the glue shows up as a wrong login derivation.
 */
const mockCalls: unknown[][] = [];
const mockFromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
jest.mock("../../modules/atlas-argon2", () => ({
  Argon2: {
    argon2idAsync: async (
      passwordHex: string,
      saltHex: string,
      memoryKib: number,
      iterations: number,
      parallelism: number,
      keyLength: number,
    ) => {
      mockCalls.push([passwordHex, saltHex, memoryKib, iterations, parallelism, keyLength]);
      const { argon2id } = jest.requireActual<typeof import("hash-wasm/dist/argon2.umd.min.js")>(
        "hash-wasm/dist/argon2.umd.min.js",
      );
      return argon2id({
        password: mockFromHex(passwordHex),
        salt: mockFromHex(saltHex),
        memorySize: memoryKib,
        iterations,
        parallelism,
        hashLength: keyLength,
        outputType: "hex",
      });
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vectors = require("@atlastodo/client-core/test-vectors/password_kdf_vectors.json") as {
  derivations: {
    name: string;
    password: string;
    salt: string;
    kdf_version: number;
    kdf_params: Record<string, number>;
    auth_hash: string;
  }[];
};

describe("the Android Argon2id module's registration", () => {
  it("hands the module the normalized password and salt as hex and reads its hex answer", async () => {
    const v = vectors.derivations.find((d) => d.name === "argon2id-decomposed-normalized")!;
    const derived = await deriveAuthAndMekAsync(
      v.password,
      v.salt,
      kdfFromWire(v.kdf_version, v.kdf_params)!,
    );
    expect(derived.authHash).toBe(v.auth_hash);
    expect(mockCalls).toEqual([
      [bytesToHex(new TextEncoder().encode(v.password.normalize("NFC"))), v.salt, 65536, 3, 1, 32],
    ]);
  });
});
