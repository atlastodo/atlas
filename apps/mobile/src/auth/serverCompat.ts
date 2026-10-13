import {
  assertServerCompatible,
  type ApiClient,
  type ServerRequirements,
} from "@atlas/client-core";

/**
 * What this app needs from a server, checked against `GET /discovery` before signing in or up.
 * A server that predates discovery counts as sync protocol 1 with todo, so it still passes; raise
 * `minProtocol` or list a capability here when the app starts to rely on something newer.
 */
export const SERVER_REQUIREMENTS: ServerRequirements = {
  minProtocol: 1,
  capabilities: [],
  apps: ["todo"],
};

/** Throws `ServerIncompatibleError` when the server cannot serve this app. */
export async function ensureServerCompatible(client: ApiClient): Promise<void> {
  assertServerCompatible(await client.getDiscovery(), SERVER_REQUIREMENTS);
}
