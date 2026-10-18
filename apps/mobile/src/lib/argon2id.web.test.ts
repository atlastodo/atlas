/**
 * The web build's Argon2id (hash-wasm's WebAssembly) against the shared vectors: the reference
 * implementation's own, and whole login derivations. A mismatch with the other platforms would lock
 * an account made on one out of the others. Jest resolves the base `.ts`, so this names the web
 * file directly; importing it registers it, as the app's entry does.
 */
import { argon2id } from "hash-wasm/dist/argon2.umd.min.js";
import { bytesToHex, deriveAuthAndMekAsync, kdfFromWire } from "@atlastodo/client-core";
import "./argon2id.web";

interface Vectors {
  argon2id: {
    name: string;
    password: string;
    salt: string;
    iterations: number;
    memory_kib: number;
    parallelism: number;
    hash: string;
  }[];
  derivations: {
    name: string;
    password: string;
    salt: string;
    kdf_version: number;
    kdf_params: Record<string, number>;
    auth_hash: string;
    mek: string;
  }[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vectors = require("@atlastodo/client-core/test-vectors/password_kdf_vectors.json") as Vectors;

describe("Argon2id on the web", () => {
  it.each(vectors.argon2id.map((v) => [v.name, v] as const))("reproduces %s", async (_, v) => {
    const out = await argon2id({
      password: v.password,
      salt: v.salt,
      iterations: v.iterations,
      memorySize: v.memory_kib,
      parallelism: v.parallelism,
      hashLength: 32,
      outputType: "hex",
    });
    expect(out).toBe(v.hash);
  });

  it.each(vectors.derivations.filter((v) => v.kdf_version === 2).map((v) => [v.name, v] as const))(
    "derives the login keys of %s through the registered provider",
    async (_, v) => {
      const derived = await deriveAuthAndMekAsync(
        v.password,
        v.salt,
        kdfFromWire(v.kdf_version, v.kdf_params)!,
      );
      expect(derived.authHash).toBe(v.auth_hash);
      expect(bytesToHex(derived.mek)).toBe(v.mek);
    },
  );
});
