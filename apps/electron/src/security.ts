import * as path from "node:path";

/** The desktop shell's security decisions, free of `electron` imports so they unit-test under Node. */

/** The privileged scheme + host the exported web bundle is served from. */
export const APP_SCHEME = "app";
const APP_HOST = "atlas-todo";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Sent on every app:// response. Scripts only from the bundle (no inline, no eval);
 * 'wasm-unsafe-eval' lets it compile the Argon2id WebAssembly. Inline styles stay for
 * react-native-web. The API server is user-chosen and may be plain http on a LAN, so connect-src
 * takes any http(s)/ws(s) host. Images and audio take blob:/data: for attachments and sounds.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Map an app:// request onto a file inside `distDir`, or null when it must be refused (wrong
 * host, undecodable, NUL, or a path outside the bundle). Extensionless paths are SPA routes
 * mapping to index.html.
 */
export function resolveAppPath(
  distDir: string,
  requestUrl: string,
  pathImpl: typeof path = path,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host.toLowerCase() !== APP_HOST) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  let rel = decoded.replace(/^\/+/, "");
  if (!rel || !pathImpl.extname(rel)) rel = "index.html";

  const root = pathImpl.resolve(distDir);
  const target = pathImpl.resolve(root, rel);
  // Check containment on the resolved path: decoding can produce separators and dot segments the
  // URL parser never saw. On win32 a different drive comes back absolute.
  const relative = pathImpl.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${pathImpl.sep}`) ||
    pathImpl.isAbsolute(relative)
  ) {
    return null;
  }
  return target;
}

/**
 * Map a deep-link URL onto a route path the web export understands (e.g. /task/42). Both
 * `atlastodo://task/42` and `atlastodo:///task/42` occur; query/hash ride along. A segment that
 * decodes to `.`/`..` or carries a separator or NUL is refused, since the route ends up in an
 * app:// URL.
 */
export function routeFromDeepLink(raw: string, scheme: string): string | null {
  const prefix = `${scheme.toLowerCase()}:`;
  if (!raw.toLowerCase().startsWith(prefix)) return null;
  const rest = raw.slice(prefix.length).replace(/^\/+/, "");
  if (/[\s\0]/.test(rest)) return null;

  const queryStart = rest.search(/[?#]/);
  const pathPart = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const tail = queryStart === -1 ? "" : rest.slice(queryStart);

  const segments: string[] = [];
  for (const segment of pathPart.split("/")) {
    if (segment === "") continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[/\\\0]/.test(decoded)) return null;
    segments.push(encodeURIComponent(decoded));
  }
  return `/${segments.join("/")}${tail}`;
}

/** The deep link in a launch's argv, if any (cold start or `second-instance`). */
export function deepLinkFromArgv(argv: readonly string[], scheme: string): string | null {
  const prefix = `${scheme.toLowerCase()}:`;
  return argv.find((arg) => arg.toLowerCase().startsWith(prefix)) ?? null;
}

const EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

/**
 * Whether a URL may be handed to the OS (`shell.openExternal`): only web links and mail, since
 * file:, smb: or custom handlers would let page content launch local programs.
 */
export function isAllowedExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return false;
  return url.protocol === "mailto:" || url.hostname !== "";
}

export function isAppUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === `${APP_SCHEME}:` && url.host.toLowerCase() === APP_HOST;
  } catch {
    return false;
  }
}

/** Whether the window may navigate to (or trust IPC from) this URL: the bundled app, plus the dev server in dev mode. */
export function isInternalUrl(raw: string, devServerUrl: string | null): boolean {
  if (isAppUrl(raw)) return true;
  if (!devServerUrl) return false;
  try {
    return new URL(raw).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

export interface LaunchContext {
  isRelease: boolean;
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * Dev mode needs an explicit `--dev` and a non-release build. The environment is not consulted:
 * an exported NODE_ENV=development must not turn an installed app into a page that loads
 * whatever listens on localhost.
 */
export function isDevMode({ isRelease, argv }: LaunchContext): boolean {
  return !isRelease && argv.includes("--dev");
}

const DEFAULT_DEV_SERVER_URL = "http://localhost:8081";

/** The dev server to load in dev mode (ELECTRON_START_URL overrides), or null outside it. */
export function devServerUrl(ctx: LaunchContext): string | null {
  if (!isDevMode(ctx)) return null;
  const override = ctx.env.ELECTRON_START_URL;
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {}
  }
  return DEFAULT_DEV_SERVER_URL;
}

/** Read the packaging script's release marker; its presence alone makes a release (even if garbled). */
export function parseReleaseMarker(raw: string | null): {
  isRelease: boolean;
  version: string | null;
} {
  if (raw === null) return { isRelease: false, version: null };
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return { isRelease: true, version: typeof parsed.version === "string" ? parsed.version : null };
  } catch {
    return { isRelease: true, version: null };
  }
}
