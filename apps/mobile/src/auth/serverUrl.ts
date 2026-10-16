import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { resolveServerUrl as pick } from "@atlas/shared";

const KEY = "atlas.serverUrl";

/** Whether this is the Electron app (the `app://` protocol or the `atlasDesktop` bridge). */
export function isElectron(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.location?.protocol === "app:" ||
      Boolean(
        (window as unknown as { atlasDesktop?: { isElectron?: boolean } }).atlasDesktop?.isElectron,
      ))
  );
}

/** Whether the app is accessed in a web browser (not Electron or native). */
export function isOnlineWeb(): boolean {
  return Platform.OS === "web" && !isElectron();
}

function isDev(): boolean {
  const isEl = isElectron();
  return (
    (typeof __DEV__ !== "undefined" && __DEV__) ||
    process.env.NODE_ENV === "development" ||
    (!isEl &&
      typeof window !== "undefined" &&
      typeof window.location !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
  );
}

/**
 * Default server URL:
 * - In a browser (not Electron): the page origin.
 * - Elsewhere, `EXPO_PUBLIC_API_URL` when set.
 * - In development (`__DEV__`, dev-mode Node, or a browser on localhost): `http://localhost:8080`.
 * - Otherwise none (empty string): the code ships no server address, and self-hosters type theirs
 *   on the sign-in screen.
 */
function getDefaultServerUrl(): string {
  if (isOnlineWeb() && typeof window !== "undefined" && window.location?.origin) {
    if (process.env.EXPO_PUBLIC_API_URL) {
      if (process.env.EXPO_PUBLIC_API_URL.startsWith("/")) {
        return new URL(process.env.EXPO_PUBLIC_API_URL, window.location.origin)
          .toString()
          .replace(/\/+$/, "");
      }
      if (isDev()) {
        return process.env.EXPO_PUBLIC_API_URL;
      }
    }
    return window.location.origin.replace(/\/+$/, "");
  }

  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  if (isDev()) {
    return "http://localhost:8080";
  }

  return "";
}

export const defaultServerUrl = getDefaultServerUrl();

/** Read the stored override (empty string when none is set), for the settings field. */
export async function getServerUrlOverride(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(KEY)) ?? "";
  } catch {
    // A storage failure must not stop the app booting; fall back to the default.
    return "";
  }
}

/** Store, or clear when blank, the server URL override. Reload the app to apply. */
export async function setServerUrlOverride(url: string): Promise<void> {
  const trimmed = url.trim();
  if (trimmed) await AsyncStorage.setItem(KEY, trimmed);
  else await AsyncStorage.removeItem(KEY);
}

/** Resolve the effective URL. Call once, before building the `ApiClient`. */
export async function loadServerUrl(): Promise<string> {
  if (isOnlineWeb() && typeof window !== "undefined" && window.location?.origin) {
    return getDefaultServerUrl();
  }
  const url = pick(await getServerUrlOverride(), getDefaultServerUrl());
  await reportToDesktop(url);
  return url;
}

/**
 * The desktop shell allows plain-http content only while the server is an http one, and rebuilds
 * its window when that changes; this window is then replaced and the call does not settle.
 */
async function reportToDesktop(url: string): Promise<void> {
  const bridge = (
    globalThis as { atlasDesktop?: { serverUrl?: { set?: (url: string) => Promise<unknown> } } }
  ).atlasDesktop?.serverUrl;
  try {
    await bridge?.set?.(url);
  } catch {
    // An older shell without the handler: nothing to switch.
  }
}
