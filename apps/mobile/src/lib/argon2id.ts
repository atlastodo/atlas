/**
 * Registers the platform's Argon2id for the password KDF (version 2, `crypto/kdf.ts` in
 * client-core). On Android that is the app's own native module (`modules/atlas-argon2`, Bouncy
 * Castle on a background thread). Hermes runs no WebAssembly, so where the module is absent (iOS,
 * Expo Go, Jest) nothing is registered and client-core's pure-JS Argon2id takes over: the same
 * bytes, but many seconds per derivation on a phone.
 *
 * The web build resolves `argon2id.web.ts` instead.
 */
import { bytesToHex, hexToBytes, setArgon2idProvider } from "@atlastodo/client-core";
import { Argon2 } from "../../modules/atlas-argon2";

export function registerArgon2id(): void {
  const native = Argon2;
  if (!native) return;
  setArgon2idProvider(async (password, salt, params, keyLength) =>
    hexToBytes(
      await native.argon2idAsync(
        bytesToHex(password),
        bytesToHex(salt),
        params.memoryKib,
        params.iterations,
        params.parallelism,
        keyLength,
      ),
    ),
  );
}

registerArgon2id();
