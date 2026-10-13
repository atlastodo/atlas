/**
 * `GET /discovery`: what an Atlas server is and offers, read before signing in, and the check a
 * client runs against it. A server that predates the endpoint answers 404 (or, serving the web
 * app, its `index.html`); it counts as {@link LEGACY_DISCOVERY}: sync protocol 1, no
 * capabilities, todo only.
 */

export interface DiscoveryApp {
  id: string;
  name: string;
  /** The app manifest version the server enforces. */
  version: number;
}

export interface ServerDiscovery {
  /** True when the server predates `/discovery`; the other fields are then assumed. */
  legacy: boolean;
  /** The server's release version; null on a legacy server. */
  version: string | null;
  /** The newest sync protocol the server speaks. */
  protocolVersion: number;
  /** The oldest client protocol it accepts; null when it does not say. */
  minProtocolVersion: number | null;
  capabilities: readonly string[];
  /** The apps the instance offers. */
  apps: readonly DiscoveryApp[];
}

/** What a server without `/discovery` is taken to be. */
export const LEGACY_DISCOVERY: ServerDiscovery = Object.freeze({
  legacy: true,
  version: null,
  protocolVersion: 1,
  minProtocolVersion: null,
  capabilities: Object.freeze([]),
  apps: Object.freeze([{ id: "todo", name: "Atlas Todo", version: 1 }]),
});

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Read a `/discovery` body; anything that is not one (an HTML page, say) is a legacy server. */
export function parseDiscovery(body: unknown): ServerDiscovery {
  if (typeof body !== "object" || body === null) return LEGACY_DISCOVERY;
  const d = body as Record<string, unknown>;
  if (!isInt(d.protocol_version) || d.protocol_version < 1) return LEGACY_DISCOVERY;
  const capabilities = Array.isArray(d.capabilities)
    ? d.capabilities.filter((c): c is string => typeof c === "string")
    : [];
  const apps = Array.isArray(d.apps)
    ? d.apps.flatMap((a: unknown): DiscoveryApp[] => {
        const app = a as Record<string, unknown> | null;
        if (typeof app?.id !== "string" || !isInt(app.version)) return [];
        return [
          {
            id: app.id,
            name: typeof app.name === "string" ? app.name : app.id,
            version: app.version,
          },
        ];
      })
    : [];
  return {
    legacy: false,
    version: typeof d.version === "string" ? d.version : null,
    protocolVersion: d.protocol_version,
    minProtocolVersion: isInt(d.min_protocol_version) ? d.min_protocol_version : null,
    capabilities,
    apps,
  };
}

/** What a client needs from a server. */
export interface ServerRequirements {
  /** The oldest sync protocol the client works with. */
  minProtocol?: number;
  /** Capabilities the client relies on. */
  capabilities?: readonly string[];
  /** Apps the server must offer. */
  apps?: readonly string[];
}

export type ServerIncompatibility =
  | { reason: "protocol"; required: number; actual: number }
  | { reason: "capabilities"; missing: readonly string[] }
  | { reason: "apps"; missing: readonly string[] };

/** The server is too old for this client, or does not offer what it needs: update the server. */
export class ServerIncompatibleError extends Error {
  constructor(
    public readonly incompatibility: ServerIncompatibility,
    public readonly discovery: ServerDiscovery,
  ) {
    super(describeIncompatibility(incompatibility, discovery));
    this.name = "ServerIncompatibleError";
  }
}

function describeIncompatibility(i: ServerIncompatibility, d: ServerDiscovery): string {
  const server = d.version ? `Atlas server ${d.version}` : "This Atlas server";
  switch (i.reason) {
    case "protocol":
      return `${server} speaks sync protocol ${i.actual}, but this app needs ${i.required} or newer. Update your server.`;
    case "capabilities":
      return `${server} lacks ${i.missing.join(", ")}, which this app needs. Update your server.`;
    case "apps":
      return `${server} does not offer ${i.missing.join(", ")}. Ask its operator to enable it.`;
  }
}

/** Why `discovery` does not meet `required`, or null when it does. */
export function serverIncompatibility(
  discovery: ServerDiscovery,
  required: ServerRequirements,
): ServerIncompatibility | null {
  const minProtocol = required.minProtocol ?? 1;
  if (discovery.protocolVersion < minProtocol) {
    return { reason: "protocol", required: minProtocol, actual: discovery.protocolVersion };
  }
  const missingCaps = (required.capabilities ?? []).filter(
    (c) => !discovery.capabilities.includes(c),
  );
  if (missingCaps.length) return { reason: "capabilities", missing: missingCaps };
  const missingApps = (required.apps ?? []).filter(
    (a) => !discovery.apps.some((app) => app.id === a),
  );
  if (missingApps.length) return { reason: "apps", missing: missingApps };
  return null;
}

/** Throw {@link ServerIncompatibleError} unless `discovery` meets `required`. */
export function assertServerCompatible(
  discovery: ServerDiscovery,
  required: ServerRequirements,
): void {
  const problem = serverIncompatibility(discovery, required);
  if (problem) throw new ServerIncompatibleError(problem, discovery);
}
