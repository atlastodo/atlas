import type { SyncStatus } from "@atlastodo/client-core";

/** How the last sync error is classified, for distinguishing "server down" from "server said no". */
/** `"storage"`: the server answered, but this device could not save what it received. */
export type SyncErrorKind = "network" | "http" | "storage";

/**
 * The UI badge state: the raw sync status plus two derived failure states. The store reports
 * `"offline"` whenever a cycle throws, whether the device has no connection or the server failed;
 * {@link effectiveSyncStatus} splits those:
 *
 * - `"offline"`: the device has no connection.
 * - `"unreachable"`: online, but the request never reached the server (a `NetworkError`).
 * - `"error"`: online, and the server responded with an error (an HTTP status).
 *
 * `"live-ws"` (the realtime socket is connected) passes through like `"idle"`/`"syncing"`.
 */
export type SyncBadgeState = SyncStatus | "unreachable" | "error";

/** Resolve the badge state from the raw status, device connectivity and the last error's kind. */
export function effectiveSyncStatus(
  status: SyncStatus,
  online: boolean,
  errorKind?: SyncErrorKind,
): SyncBadgeState {
  if (status !== "offline") return status;
  if (!online) return "offline";
  // Online but a cycle threw: a network failure is unreachable, an HTTP status a server error.
  return errorKind === "network" ? "unreachable" : "error";
}
