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

/** The server does not offer passkeys (no `WEBAUTHN_RP_ID`, or a release predating them). */
export class PasskeysUnavailableError extends Error {
  constructor() {
    super("this server does not offer passkeys");
    this.name = "PasskeysUnavailableError";
  }
}

/** Throws `PasskeysUnavailableError` unless the server lists the `passkeys` capability. */
export async function ensurePasskeysOffered(client: ApiClient): Promise<void> {
  const discovery = await client.getDiscovery();
  if (!discovery.capabilities.includes("passkeys")) throw new PasskeysUnavailableError();
}

/** Whether the server offers passkeys; false when it cannot be asked. */
export async function serverOffersPasskeys(client: ApiClient): Promise<boolean> {
  try {
    return (await client.getDiscovery()).capabilities.includes("passkeys");
  } catch {
    return false;
  }
}
