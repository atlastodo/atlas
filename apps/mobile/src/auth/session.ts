import * as SecureStore from "expo-secure-store";
import { type Session, type TokenStore, sessionFromAuth } from "@atlastodo/client-core";

/**
 * Session persistence: tokens live in the device keychain (iOS Keychain / Android Keystore) via
 * expo-secure-store. There is no non-secret fallback: unencrypted token storage is worse than
 * signing in again, so a failed read means "no session" and a failed write is surfaced to the
 * caller. The {@link Session} shape comes from `@atlastodo/client-core`.
 */

const KEY = "atlas.session";

export { type Session, sessionFromAuth };

/** Load the persisted session, or null when there is none (or the keychain is unreadable). */
export async function readSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    // Unreadable or corrupt (e.g. a shape change across versions): sign in again rather than crash.
    return null;
  }
}

/** Persist the session to the keychain. Throws if the keychain refuses -- the caller must know. */
export async function writeSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session));
}

/** Remove the persisted session (sign-out). Safe to call when nothing is stored. */
export async function dropSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

/** One `ApiClient` per process with single-flight rotation: no sibling to lock against or hear from (unlike `session.web.ts`). */
export const withRefreshLock: TokenStore["withRefreshLock"] = undefined;

/** One client per process: a reuse of a rotated token is never a sibling's race here. */
export function refreshGrace(): boolean {
  return false;
}

export function subscribeSession(
  _onChange: (session: Session | null) => void,
  _target?: Pick<EventTarget, "addEventListener" | "removeEventListener">,
): () => void {
  return () => {};
}
