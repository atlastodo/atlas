/**
 * The browser's (and the desktop app's) Argon2id for the password KDF: hash-wasm's WebAssembly
 * build, several times faster than client-core's pure-JS fallback. Metro resolves this file in place
 * of `argon2id.ts` for the web build. Compiling the module needs `'wasm-unsafe-eval'` in the page's
 * CSP (the server's and the Electron shell's both allow it); where it cannot compile, the provider
 * throws and client-core falls back to pure JS.
 *
 * Only the Argon2 build of hash-wasm is imported: its package entry carries every algorithm.
 */
import { setArgon2idProvider } from "@atlastodo/client-core";
import { argon2id } from "hash-wasm/dist/argon2.umd.min.js";

export function registerArgon2id(): void {
  setArgon2idProvider((password, salt, params, keyLength) =>
    argon2id({
      password,
      salt,
      memorySize: params.memoryKib,
      iterations: params.iterations,
      parallelism: params.parallelism,
      hashLength: keyLength,
      outputType: "binary",
    }),
  );
}

registerArgon2id();
