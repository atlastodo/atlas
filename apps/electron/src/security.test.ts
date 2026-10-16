import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isInsecureServerUrl,
  APP_ORIGIN,
  CSP,
  deepLinkFromArgv,
  devServerUrl,
  isAllowedExternalUrl,
  isAppUrl,
  isDevMode,
  isInternalUrl,
  parseReleaseMarker,
  resolveAppPath,
  routeFromDeepLink,
} from "./security";

const DIST = "/opt/atlas/web-dist";
const WIN_DIST = "C:\\Program Files\\Atlas\\web-dist";

describe("resolveAppPath", () => {
  it.each([
    ["app://atlas-todo/", "index.html"],
    ["app://atlas-todo/index.html", "index.html"],
    ["app://atlas-todo/favicon.svg", "favicon.svg"],
    ["app://atlas-todo/_expo/static/js/web/entry-abc.js", "_expo/static/js/web/entry-abc.js"],
    ["app://atlas-todo/assets/sounds/chime.m4a?v=1#t", "assets/sounds/chime.m4a"],
    ["app://atlas-todo/assets/my%20file.png", "assets/my file.png"],
    // SPA routes (no extension) serve index.html.
    ["app://atlas-todo/today", "index.html"],
    ["app://atlas-todo/task/42", "index.html"],
    ["app://atlas-todo/project/abc/board?x=1", "index.html"],
    // Dot segments the URL parser collapses itself (%2e%2e counts as one) clamp at the root.
    ["app://atlas-todo/_expo/../favicon.svg", "favicon.svg"],
    ["app://atlas-todo/%2e%2e/%2e%2e/etc/passwd.txt", "etc/passwd.txt"],
    // Double-encoded: decoded once, the %2e/%2f are literal filename characters, still inside.
    ["app://atlas-todo/%252e%252e%252fevil.html", "%2e%2e%2fevil.html"],
    // Host matching is case-insensitive, as Chromium lower-cases standard-scheme hosts.
    ["app://ATLAS-TODO/favicon.svg", "favicon.svg"],
  ])("serves %s from the bundle", (url, rel) => {
    expect(resolveAppPath(DIST, url, path.posix)).toBe(path.posix.join(DIST, rel));
  });

  it.each([
    // Encoded separators and dot segments survive URL parsing and only appear after decoding.
    "app://atlas-todo/..%2f..%2fDownloads%2fevil.html",
    "app://atlas-todo/%2e%2e%2f%2e%2e%2fetc%2fpasswd.txt",
    "app://atlas-todo/assets/..%2f..%2f..%2fsecret.json",
    "app://atlas-todo/%2F..%2F..%2Fsecret.json",
    // NUL and undecodable input.
    "app://atlas-todo/index.html%00.png",
    "app://atlas-todo/%E0%A4%A.png",
    "app://atlas-todo/%zz.png",
    // Wrong scheme, wrong host, a port, or not a URL at all.
    "app://evil/index.html",
    "app://atlas-todo.evil/index.html",
    "app://atlas-todo:8080/index.html",
    "file:///opt/atlas/web-dist/index.html",
    "https://atlas-todo/index.html",
    "not a url",
  ])("refuses %s", (url) => {
    expect(resolveAppPath(DIST, url, path.posix)).toBeNull();
  });

  it("keeps a bare `..` prefix inside the bundle when it is part of a filename", () => {
    expect(resolveAppPath(DIST, "app://atlas-todo/..hidden.png", path.posix)).toBe(
      path.posix.join(DIST, "..hidden.png"),
    );
  });

  describe("win32 paths", () => {
    it.each([
      ["app://atlas-todo/favicon.svg", "favicon.svg"],
      ["app://atlas-todo/_expo/static/js/web/entry.js", "_expo\\static\\js\\web\\entry.js"],
      ["app://atlas-todo/task/42", "index.html"],
    ])("serves %s", (url, rel) => {
      expect(resolveAppPath(WIN_DIST, url, path.win32)).toBe(path.win32.join(WIN_DIST, rel));
    });

    it.each([
      "app://atlas-todo/..%5c..%5cUsers%5cme%5cDownloads%5cevil.html",
      "app://atlas-todo/%2e%2e%5c%2e%2e%5cevil.html",
      "app://atlas-todo/..%2f..%2fevil.html",
      // Drive-absolute and UNC paths resolve outside (or onto another drive: relative() is absolute).
      "app://atlas-todo/C:%5cWindows%5cwin.ini",
      "app://atlas-todo/C:/Windows/win.ini",
      "app://atlas-todo/D:%5cevil.html",
      "app://atlas-todo/%5c%5cattacker%5cshare%5cevil.html",
    ])("refuses %s", (url) => {
      expect(resolveAppPath(WIN_DIST, url, path.win32)).toBeNull();
    });
  });

  it("treats a backslash as a filename character on posix", () => {
    const resolved = resolveAppPath(DIST, "app://atlas-todo/..%5c..%5cevil.html", path.posix);
    expect(resolved).toBe(path.posix.join(DIST, "..\\..\\evil.html"));
  });
});

describe("routeFromDeepLink", () => {
  const scheme = "atlastodo";

  it.each([
    ["atlastodo://task/42", "/task/42"],
    ["atlastodo:///task/42", "/task/42"],
    ["atlastodo:task/42", "/task/42"],
    ["atlastodo://today", "/today"],
    ["atlastodo://", "/"],
    ["atlastodo://task/42?focus=1#notes", "/task/42?focus=1#notes"],
    ["atlastodo://task//42/", "/task/42"],
    ["ATLASTODO://task/42", "/task/42"],
    // Segments are re-encoded, so decoding downstream yields the same segment and nothing more.
    ["atlastodo://project/My%20List", "/project/My%20List"],
    ["atlastodo://project/caf%C3%A9", "/project/caf%C3%A9"],
    ["atlastodo://search/a%25b", "/search/a%25b"],
    ["atlastodo://search/%3Fnot-a-query", "/search/%3Fnot-a-query"],
  ])("maps %s to %s", (raw, route) => {
    expect(routeFromDeepLink(raw, scheme)).toBe(route);
  });

  it.each([
    "atlastodo://..%2f..%2fDownloads%2fevil.html",
    "atlastodo://..%2f..%2fx.html",
    "atlastodo://%2e%2e/%2e%2e/x.html",
    "atlastodo://task/%2e%2e",
    "atlastodo://task/..",
    "atlastodo://./task",
    "atlastodo://..%5c..%5cx.html",
    "atlastodo://..\\..\\x.html",
    "atlastodo://task/42%00.html",
    "atlastodo://task/%E0%A4%A",
    "atlastodo://task/4 2",
    "atlastodo://task/42\n",
    "https://example.com/task/42",
    "atlastodox://task/42",
  ])("refuses %s", (raw) => {
    expect(routeFromDeepLink(raw, scheme)).toBeNull();
  });

  it("never yields a route the protocol handler resolves outside the bundle", () => {
    for (const raw of [
      "atlastodo://..%2f..%2fx.html",
      "atlastodo://%252e%252e%252fx.html",
      "atlastodo://a/%252e%252e/%252e%252e/x.html",
    ]) {
      const route = routeFromDeepLink(raw, scheme);
      if (route === null) continue;
      const resolved = resolveAppPath(DIST, `${APP_ORIGIN}${route}`, path.posix);
      expect(resolved === null || resolved.startsWith(`${DIST}/`)).toBe(true);
    }
  });
});

describe("deepLinkFromArgv", () => {
  it("finds the link among Electron's own arguments", () => {
    expect(
      deepLinkFromArgv(
        [
          "/usr/bin/electron",
          "/opt/atlas/dist/main.js",
          "--class=atlas-desktop",
          "atlastodo://task/42",
        ],
        "atlastodo",
      ),
    ).toBe("atlastodo://task/42");
  });

  it("returns null without a link", () => {
    expect(
      deepLinkFromArgv(["/usr/bin/electron", "dist/main.js", "--dev"], "atlastodo"),
    ).toBeNull();
    expect(deepLinkFromArgv(["electron", "https://example.com"], "atlastodo")).toBeNull();
  });
});

describe("isAllowedExternalUrl", () => {
  it.each([
    "https://example.com/docs",
    "http://192.168.1.10:8080/",
    "HTTPS://Example.com",
    "mailto:support@example.com",
    "mailto:support@example.com?subject=Hi",
  ])("allows %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    " javascript:alert(1)",
    "file:///etc/passwd",
    "file://attacker/share/evil.exe",
    "smb://attacker/share",
    "app://atlas-todo/index.html",
    "ms-settings:privacy",
    "ms-msdt:/id PCWDiagnostic",
    "search-ms:query=evil",
    "vscode://file/etc/passwd",
    "data:text/html,<script>alert(1)</script>",
    "blob:app://atlas-todo/1234",
    "atlastodo://task/42",
    "http://",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

describe("isInsecureServerUrl", () => {
  it("is true only for a plain-http server", () => {
    expect(isInsecureServerUrl("http://192.168.1.10:8080")).toBe(true);
    expect(isInsecureServerUrl("HTTP://atlas.lan")).toBe(true);
    expect(isInsecureServerUrl("https://app.atlastodo.dev")).toBe(false);
    expect(isInsecureServerUrl("")).toBe(false);
    expect(isInsecureServerUrl("not a url")).toBe(false);
    expect(isInsecureServerUrl("ws://atlas.lan")).toBe(false);
    expect(isInsecureServerUrl(undefined)).toBe(false);
    expect(isInsecureServerUrl(42)).toBe(false);
  });
});

describe("isAppUrl / isInternalUrl", () => {
  it("accepts only the bundled app origin", () => {
    expect(isAppUrl("app://atlas-todo/")).toBe(true);
    expect(isAppUrl("app://atlas-todo/task/42?x#y")).toBe(true);
    expect(isAppUrl("app://evil/")).toBe(false);
    expect(isAppUrl("app://atlas-todo.evil/")).toBe(false);
    expect(isAppUrl("https://atlas-todo/")).toBe(false);
    expect(isAppUrl("file:///index.html")).toBe(false);
  });

  it("adds the dev server origin only when one is given", () => {
    expect(isInternalUrl("http://localhost:8081/today", null)).toBe(false);
    expect(isInternalUrl("http://localhost:8081/today", "http://localhost:8081")).toBe(true);
    expect(isInternalUrl("http://localhost:8082/", "http://localhost:8081")).toBe(false);
    expect(isInternalUrl("http://127.0.0.1:8081/", "http://localhost:8081")).toBe(false);
    expect(isInternalUrl("https://example.com/", "http://localhost:8081")).toBe(false);
    expect(isInternalUrl("app://atlas-todo/", "http://localhost:8081")).toBe(true);
  });
});

describe("isDevMode / devServerUrl", () => {
  const argv = ["/usr/bin/electron", "dist/main.js"];

  it.each([
    { isRelease: false, argv: [...argv, "--dev"], env: {}, dev: true },
    { isRelease: false, argv, env: {}, dev: false },
    // The environment never enables dev mode.
    { isRelease: false, argv, env: { NODE_ENV: "development" }, dev: false },
    { isRelease: false, argv, env: { ELECTRON_START_URL: "http://localhost:9999" }, dev: false },
    // A release build ignores --dev and the environment alike.
    { isRelease: true, argv: [...argv, "--dev"], env: {}, dev: false },
    {
      isRelease: true,
      argv: [...argv, "--dev"],
      env: { NODE_ENV: "development", ELECTRON_START_URL: "http://localhost:9999" },
      dev: false,
    },
  ])("isRelease=$isRelease argv=$argv env=$env -> dev=$dev", ({ dev, ...ctx }) => {
    expect(isDevMode(ctx)).toBe(dev);
    expect(devServerUrl(ctx) !== null).toBe(dev);
  });

  it("uses ELECTRON_START_URL in dev mode, falling back on a bad value", () => {
    const dev = { isRelease: false, argv: ["electron", "--dev"] };
    expect(devServerUrl({ ...dev, env: {} })).toBe("http://localhost:8081");
    expect(devServerUrl({ ...dev, env: { ELECTRON_START_URL: "http://127.0.0.1:19006/" } })).toBe(
      "http://127.0.0.1:19006",
    );
    expect(devServerUrl({ ...dev, env: { ELECTRON_START_URL: "file:///tmp/x.html" } })).toBe(
      "http://localhost:8081",
    );
    expect(devServerUrl({ ...dev, env: { ELECTRON_START_URL: "nope" } })).toBe(
      "http://localhost:8081",
    );
  });
});

describe("parseReleaseMarker", () => {
  it("is a release exactly when the marker exists", () => {
    expect(parseReleaseMarker(null)).toEqual({ isRelease: false, version: null });
    expect(parseReleaseMarker('{"release":true,"version":"1.2.3"}')).toEqual({
      isRelease: true,
      version: "1.2.3",
    });
    expect(parseReleaseMarker("garbage")).toEqual({ isRelease: true, version: null });
    expect(parseReleaseMarker("null")).toEqual({ isRelease: true, version: null });
  });
});

describe("CSP", () => {
  it("allows no inline or eval'd script and no plugins, framing, or form posts", () => {
    // 'wasm-unsafe-eval' compiles WebAssembly only (the password KDF); it evaluates no script.
    const directives = new Map(
      CSP.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(CSP).not.toMatch(/'unsafe-eval'/);
  });
});
