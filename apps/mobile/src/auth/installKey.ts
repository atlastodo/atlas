import { Platform } from "react-native";
import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

/** iOS only: the keychain outlives an uninstall, unlike the app's own storage. */
const IOS_KEY = "atlas.installKey";

/**
 * An identifier for this app on this device that survives uninstalling and reinstalling it, sent
 * at sign-in so the server replaces the old install's session in Devices & sessions instead of
 * listing it until it expires. Android: the Android ID (per signing key, user and device; reset by
 * a factory reset). iOS: a random value kept in the keychain. Hashed before it leaves the device,
 * so the server never sees the raw Android ID. `undefined` when there is none to be had; the
 * sign-in goes ahead without it.
 */
export async function getInstallKey(): Promise<string | undefined> {
  try {
    const raw = await rawInstallKey();
    if (!raw) return undefined;
    return await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `atlas-install-key:${raw}`,
    );
  } catch {
    return undefined;
  }
}

async function rawInstallKey(): Promise<string | null> {
  if (Platform.OS === "android") return Application.getAndroidId();
  if (Platform.OS !== "ios") return null;
  const stored = await SecureStore.getItemAsync(IOS_KEY);
  if (stored) return stored;
  const minted = Crypto.randomUUID();
  await SecureStore.setItemAsync(IOS_KEY, minted);
  return minted;
}
