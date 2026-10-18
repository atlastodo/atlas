/**
 * Registers `react-native-quick-crypto`'s native PBKDF2 as the fast path for the shared KDF.
 *
 * A version-1 account's login keys take 600k iterations of PBKDF2-SHA256 (see `argon2id.ts` for
 * version 2); in pure JS on the Hermes thread that is seconds on a phone. OpenSSL in quick-crypto
 * computes the identical derivation on a native worker thread in under a second.
 *
 * Registration is best-effort: where the native module is unavailable (Expo Go, Jest, web) this is
 * a no-op and `deriveAuthAndMekAsync` falls back to WebCrypto or pure JS (same output, slower).
 */
import { TurboModuleRegistry } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { setPbkdf2Provider } from "@atlastodo/client-core";

export function registerNativePbkdf2(): void {
  // Expo Go (or any build without the QuickBase64 TurboModule) cannot load react-native-quick-crypto,
  // and a dynamic import would throw a TurboModule getEnforcing invariant violation.
  const isExpoGo =
    Constants.appOwnership === "expo" ||
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  const hasQuickBase64 =
    typeof TurboModuleRegistry?.get === "function" &&
    TurboModuleRegistry.get("QuickBase64") != null;

  if (isExpoGo || !hasQuickBase64) {
    return;
  }

  void (async () => {
    try {
      const quickCrypto = await import("react-native-quick-crypto");
      setPbkdf2Provider(async (password, salt, iterations, keyLength) => {
        // The callback form runs on a native worker; `pbkdf2Sync` would block the JS thread.
        return new Promise<Uint8Array>((resolve, reject) => {
          quickCrypto.pbkdf2(password, salt, iterations, keyLength, "sha256", (err, key) => {
            if (err || !key) reject(err ?? new Error("pbkdf2 returned no key"));
            else resolve(new Uint8Array(key));
          });
        });
      });
    } catch {
      // No native module in this build: the WebCrypto / pure-JS derivation takes over.
    }
  })();
}

registerNativePbkdf2();
