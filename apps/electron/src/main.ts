import {
  app,
  BrowserWindow,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  saveDesktopSettings,
  type CloseToTrayState,
  type DesktopSettings,
} from "./desktopSettings";
import { decryptBytes, encryptBytes } from "./keyWrap";
import { isQuitShortcut } from "./shortcuts";
import { DesktopUpdater } from "./updater";
import {
  APP_ORIGIN,
  APP_SCHEME,
  CSP,
  deepLinkFromArgv,
  devServerUrl as devServerUrlFor,
  isAllowedExternalUrl,
  isInsecureServerUrl,
  isInternalUrl,
  parseReleaseMarker,
  resolveAppPath,
  routeFromDeepLink,
} from "./security";

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

app.name = "Atlas Todo";
if (process.platform === "linux") {
  app.setDesktopName("atlas-desktop.desktop");
}

// scripts/package-desktop.sh drops dist/release.json into packaged builds; `app.isPackaged` cannot
// tell them apart (the Nix package and tarball run the stock electron binary).
function readReleaseMarker(): string | null {
  try {
    return fs.readFileSync(path.join(__dirname, "release.json"), "utf8");
  } catch {
    return null;
  }
}

const RELEASE = parseReleaseMarker(readReleaseMarker());
const LAUNCH = { isRelease: RELEASE.isRelease, argv: process.argv, env: process.env };
const devServerUrl = devServerUrlFor(LAUNCH);

// Directory holding the exported web bundle from apps/mobile
function resolveDistDir(): string {
  // Dev-only override: in a release it would let the environment swap what runs as the app origin.
  if (!RELEASE.isRelease && process.env.ATLAS_DESKTOP_WEB_DIR) {
    return process.env.ATLAS_DESKTOP_WEB_DIR;
  }
  const candidates = [
    path.resolve(__dirname, "../web-dist"),
    path.resolve(__dirname, "./web-dist"),
    path.resolve(__dirname, "../../mobile/dist"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(__dirname, "../../mobile/dist");
}

function resolveIconPath(): string {
  if (process.env.ATLAS_DESKTOP_ICON_PATH) {
    return process.env.ATLAS_DESKTOP_ICON_PATH;
  }
  const candidates = [
    path.resolve(__dirname, "../assets/icon.png"),
    path.resolve(__dirname, "./assets/icon.png"),
    path.resolve(__dirname, "../../mobile/assets/icon.png"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(__dirname, "../../mobile/assets/icon.png");
}

const DIST_DIR = resolveDistDir();
const ICON_PATH = resolveIconPath();

let mainWindow: BrowserWindow | null = null;
let updater: DesktopUpdater | null = null;

// Window state: size and position persist as JSON in userData, written on close and clamped on
// boot. Best-effort; a corrupt or unwritable file means defaults.

const MIN_WIDTH = 480;
const MIN_HEIGHT = 600;

const DEFAULT_WINDOW_STATE = {
  width: 1280,
  height: 850,
  x: null,
  y: null,
  isMaximized: false,
};

interface WindowState {
  width: number;
  height: number;
  x: number | null;
  y: number | null;
  isMaximized: boolean;
}

function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
  const finite = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  try {
    const raw = JSON.parse(fs.readFileSync(windowStatePath(), "utf8")) as Partial<WindowState>;
    return {
      width: Math.max(MIN_WIDTH, finite(raw.width) ?? DEFAULT_WINDOW_STATE.width),
      height: Math.max(MIN_HEIGHT, finite(raw.height) ?? DEFAULT_WINDOW_STATE.height),
      x: finite(raw.x),
      y: finite(raw.y),
      isMaximized: raw.isMaximized === true,
    };
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    // Normal bounds, so a maximized close remembers a sane frame underneath.
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized(),
    };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state));
  } catch (err) {
    // Persistence must not stop the app closing.
    console.error("[Atlas Todo Desktop] Failed to save window state:", err);
  }
}

/**
 * Pull a saved state back onto a visible display (an off-screen window would be unreachable):
 * the position clamps into the closest display's work area; a first launch centers on the primary.
 */
function clampToDisplays(state: WindowState): WindowState {
  if (state.x === null || state.y === null) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      ...state,
      x: Math.round(area.x + (area.width - state.width) / 2),
      y: Math.round(area.y + (area.height - state.height) / 2),
    };
  }
  const display = screen.getDisplayMatching({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  });
  const area = display.workArea;
  const minVisible = 40;
  return {
    ...state,
    x: Math.min(
      Math.max(state.x, area.x - state.width + minVisible),
      area.x + area.width - minVisible,
    ),
    y: Math.min(Math.max(state.y, area.y - minVisible), area.y + area.height - minVisible),
  };
}

// atlastodo:// deep links (scheme declared in apps/mobile/app.json). Windows/Linux deliver the
// URL in argv (cold start, or `second-instance`); macOS fires `open-url` on the first instance.
const DEEP_LINK_SCHEME = "atlastodo";

// Claim the scheme. On Linux this only works when an installed .desktop file advertises the
// handler (the packaged flake ships one); macOS needs a packaged bundle, so dev skips it.
if (process.platform === "win32" && !app.isPackaged) {
  // Dev on Windows runs electron.exe; pass the script path as a packaged Exec would.
  const script = process.argv[1];
  app.setAsDefaultProtocolClient(
    DEEP_LINK_SCHEME,
    process.execPath,
    script ? [path.resolve(script)] : [],
  );
} else if (process.platform !== "darwin" || app.isPackaged) {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// A route from a deep link that arrived before a window could take it; the next window opens on it.
let pendingDeepLink: string | null = null;

/** Raise an existing window: un-hide, unminimize, focus. */
function focusMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Point a window at a route with a full load: the renderer is a static expo-router bundle, so
 * loading the route path (index.html via the app:// SPA fallback) is how it re-routes.
 */
function loadRoute(win: BrowserWindow, route: string): void {
  const target = `${devServerUrl ?? APP_ORIGIN}${route}`;
  win.webContents.loadURL(target).catch((err: Error) => {
    console.error(`[Atlas Todo Desktop] Failed to load ${target}:`, err.message);
  });
}

// Set once the protocol handler is registered; an earlier window would load nothing.
let started = false;

function openRoute(route: string): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    // The next window opens on it.
    pendingDeepLink = route;
    if (started) mainWindow = createMainWindow();
    return;
  }
  focusMainWindow();
  loadRoute(win, route);
}

function openDeepLink(raw: string): void {
  const route = routeFromDeepLink(raw, DEEP_LINK_SCHEME);
  if (route) openRoute(route);
  else focusMainWindow();
}

// macOS: fires on the first instance whether running or cold-launching.
app.on("open-url", (event, url) => {
  event.preventDefault();
  openDeepLink(url);
});

// Tray (Windows/Linux): the menu restores or quits. Closing the window quits unless "Close to
// tray" is on, which hides it so sync and reminders keep running. macOS keeps the Dock model.
// Only created when a tray icon asset exists.
let tray: Tray | null = null;
let isQuitting = false;

// Read in onReady (userData), before the first window can close.
let desktopSettings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };

function desktopSettingsPath(): string {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

/** Close to tray is only offered where a tray icon exists. */
function closeToTrayState(): CloseToTrayState {
  return { available: tray !== null, enabled: desktopSettings.closeToTray };
}

function resolveTrayIconPath(): string | null {
  for (const candidate of [
    path.resolve(__dirname, "../assets/tray.png"),
    path.resolve(__dirname, "./assets/tray.png"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // The full-colour app icon stands in when the dedicated asset is absent.
  return fs.existsSync(ICON_PATH) ? ICON_PATH : null;
}

function createTray(): void {
  if (process.platform === "darwin") return;
  const iconPath = resolveTrayIconPath();
  if (!iconPath) return;
  try {
    tray = new Tray(iconPath);
  } catch (err) {
    // Some Linux sessions have no tray host; live without one.
    console.error("[Atlas Todo Desktop] Failed to create tray icon:", err);
    tray = null;
    return;
  }
  tray.setToolTip("Atlas Todo");
  tray.on("click", () => {
    focusMainWindow();
  });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Atlas Todo", click: () => focusMainWindow() },
      { type: "separator" },
      { label: "Quit", accelerator: "Ctrl+Q", click: () => quitApp() },
    ]),
  );
}

/** Quit for real: the tray's Quit and Ctrl+Q, which bypass "Close to tray". */
function quitApp(): void {
  isQuitting = true;
  app.quit();
}

/** IPC is only honoured from the main window's top frame while it shows the app. */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const win = mainWindow;
  const frame = event.senderFrame;
  if (!win || win.isDestroyed() || !frame || event.sender !== win.webContents) return false;
  return frame.parent === null && isInternalUrl(frame.url, devServerUrl);
}

// Clicking a renderer web Notification raises the window (the OS does not), via the preload's
// `focusWindow`.
ipcMain.on("atlas:focus-window", (event) => {
  if (isTrustedSender(event)) focusMainWindow();
});

ipcMain.handle("atlas:get-device-name", (event) => {
  if (!isTrustedSender(event)) return null;
  return os.hostname() || null;
});

// The session key set wrapped with the OS key store (webKeyStore.ts). Both answer null when the
// key store is unusable or the sender is not the app; the renderer then keeps its WebCrypto wrap.
ipcMain.handle("atlas:safe-storage:encrypt", (event, plain: unknown) =>
  isTrustedSender(event) ? encryptBytes(safeStorage, process.platform, plain) : null,
);
ipcMain.handle("atlas:safe-storage:decrypt", (event, sealed: unknown) =>
  isTrustedSender(event) ? decryptBytes(safeStorage, process.platform, sealed) : null,
);

// Settings' "Close to tray" row. `set` keeps the choice for this run even if the file cannot be written.
ipcMain.handle("atlas:close-to-tray:get", (event) =>
  isTrustedSender(event) ? closeToTrayState() : null,
);
ipcMain.handle("atlas:close-to-tray:set", (event, enabled: unknown) => {
  if (!isTrustedSender(event)) return null;
  if (typeof enabled === "boolean" && enabled !== desktopSettings.closeToTray) {
    desktopSettings = { ...desktopSettings, closeToTray: enabled };
    try {
      saveDesktopSettings(desktopSettingsPath(), desktopSettings);
    } catch (err) {
      console.error("[Atlas Todo Desktop] Failed to save desktop settings:", err);
    }
  }
  return closeToTrayState();
});

// The renderer reports the server it resolved at boot and after each change. A switch between an
// http and an https server flips `allowRunningInsecureContent`, which a window fixes at creation,
// so the window is rebuilt; the new one reads the same stored URL and reports it again, matching.
ipcMain.handle("atlas:server-url:set", (event, url: unknown) => {
  if (!isTrustedSender(event)) return null;
  const insecure = isInsecureServerUrl(url);
  if (insecure === desktopSettings.allowInsecureServer) return false;
  desktopSettings = { ...desktopSettings, allowInsecureServer: insecure };
  try {
    saveDesktopSettings(desktopSettingsPath(), desktopSettings);
  } catch (err) {
    console.error("[Atlas Todo Desktop] Failed to save desktop settings:", err);
  }
  const previous = BrowserWindow.fromWebContents(event.sender);
  mainWindow = createMainWindow();
  // destroy(), not close(): close-to-tray would only hide it.
  previous?.destroy();
  return true;
});

// Desktop auto-updates.
ipcMain.handle("atlas:updates:get-state", (event) =>
  isTrustedSender(event) ? (updater?.getState() ?? null) : null,
);
ipcMain.handle("atlas:updates:check", async (event) => {
  if (!isTrustedSender(event) || !updater) return null;
  return await updater.checkForUpdates();
});
ipcMain.handle("atlas:updates:download", async (event) => {
  if (!isTrustedSender(event) || !updater) return;
  await updater.downloadUpdate();
});
ipcMain.on("atlas:updates:install", (event) => {
  if (isTrustedSender(event) && updater) {
    updater.installUpdate();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
});

function themeBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff";
}

/** Hand a URL to the OS only when it is a web or mail link. */
function openExternalIfAllowed(url: string): void {
  if (!isAllowedExternalUrl(url)) return;
  shell.openExternal(url).catch((err: Error) => {
    console.error(`[Atlas Todo Desktop] Failed to open ${url}:`, err.message);
  });
}

function createMainWindow(): BrowserWindow {
  // Restore the previous bounds, clamped onto a display that still exists.
  const state = clampToDisplays(loadWindowState());
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x ?? undefined,
    y: state.y ?? undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: "Atlas Todo",
    // Follow the OS scheme so boot does not flash the wrong colour.
    backgroundColor: themeBackground(),
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // app:// is a secure origin, so a plain-http LAN API would be blocked as mixed content.
      // Allowed only while the chosen server is http (`atlas:server-url:set`), with the CSP
      // bounding what the page loads.
      allowRunningInsecureContent: desktopSettings.allowInsecureServer,
    },
    show: false, // Show once ready-to-show for a seamless first paint
  });

  if (process.platform !== "darwin") {
    win.removeMenu();
  }

  win.webContents.on("before-input-event", (event, input) => {
    // Windows/Linux have no menu bar to carry it, so Ctrl+Q is caught here (focused window only).
    if (isQuitShortcut(input, process.platform)) {
      event.preventDefault();
      quitApp();
      return;
    }
    if (input.type === "keyDown") {
      if (
        input.key === "F12" ||
        (input.control && input.shift && input.key.toLowerCase() === "i")
      ) {
        win.webContents.toggleDevTools();
        event.preventDefault();
      }
      if (input.control && input.key.toLowerCase() === "r") {
        win.webContents.reload();
        event.preventDefault();
      }
    }
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // A maximized session comes back maximized.
  if (state.isMaximized) win.maximize();

  // Remember the bounds on the way out. A close only hides the window on macOS and with "Close
  // to tray" on; otherwise it closes and window-all-closed quits.
  win.on("close", (event) => {
    saveWindowState(win);
    const hide = process.platform === "darwin" || (tray !== null && desktopSettings.closeToTray);
    if (!isQuitting && hide) {
      event.preventDefault();
      win.hide();
    }
  });

  if (process.argv.includes("--test-exit")) {
    win.webContents.once("did-finish-load", () => {
      console.log("[Atlas Todo Desktop] Window and page loaded successfully.");
      setTimeout(() => {
        app.quit();
      }, 500);
    });
  }

  // No child windows: they would inherit the preload bridge. Such links go to the OS.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url);
    return { action: "deny" };
  });

  // The window only shows the app; other destinations are cancelled and web/mail links go to the OS.
  const guardNavigation = (event: Electron.Event<{ url: string }>) => {
    if (isInternalUrl(event.url, devServerUrl)) return;
    event.preventDefault();
    openExternalIfAllowed(event.url);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());

  // A deep link that arrived before this window opens here.
  const route = pendingDeepLink ?? "/";
  pendingDeepLink = null;
  loadRoute(win, route);

  return win;
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              {
                label: "Check for Updates...",
                click: () => {
                  void updater?.checkForUpdates();
                },
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ] as MenuItemConstructorOptions[],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [isMac ? { role: "close" } : { role: "quit" }] as MenuItemConstructorOptions[],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ] as MenuItemConstructorOptions[],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ] as MenuItemConstructorOptions[],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }]
          : [{ role: "close" }]),
      ] as MenuItemConstructorOptions[],
    },
    {
      role: "help",
      submenu: [
        {
          role: "about",
        },
        {
          label: "Check for Updates...",
          click: () => {
            void updater?.checkForUpdates();
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function withSecurityHeaders(headers: Headers): Headers {
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The app:// protocol: files from the web bundle, never from outside it. */
async function serveAppRequest(request: Request): Promise<Response> {
  const target = resolveAppPath(DIST_DIR, request.url);
  if (!target) {
    return new Response("Not Found", {
      status: 404,
      headers: withSecurityHeaders(new Headers({ "Content-Type": "text/plain" })),
    });
  }
  // Anything not on disk is an SPA route.
  const file = isFile(target) ? target : path.join(DIST_DIR, "index.html");
  const upstream = await net.fetch(pathToFileURL(file).toString());
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: withSecurityHeaders(new Headers(upstream.headers)),
  });
}

function onReady(): void {
  protocol.handle(APP_SCHEME, serveAppRequest);

  // Routes to an OS protocol handler ask this permission; only web and mail links get it.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      if (permission === "openExternal") {
        const url = "externalURL" in details ? details.externalURL : undefined;
        callback(url !== undefined && isAllowedExternalUrl(url));
        return;
      }
      callback(true);
    },
  );

  nativeTheme.on("updated", () => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) win.setBackgroundColor(themeBackground());
  });

  desktopSettings = loadDesktopSettings(desktopSettingsPath());
  const currentVersion = RELEASE.version ?? app.getVersion();
  updater = new DesktopUpdater(currentVersion, {
    argv: process.argv,
    env: process.env,
    execPath: process.execPath,
    dirname: __dirname,
  });
  updater.onStateChange((state) => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send("atlas:updates:state-changed", state);
    }
  });
  if (desktopSettings.autoCheckUpdates) {
    updater.startPeriodicCheck();
  }

  buildMenu();
  started = true;
  mainWindow = createMainWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
    else focusMainWindow();
  });
}

// Single-instance lock: a second launch hands its argv to the running instance and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows/Linux cold start: a deep link is in our own argv (macOS uses open-url).
  const coldStartLink = deepLinkFromArgv(process.argv, DEEP_LINK_SCHEME);
  if (coldStartLink) pendingDeepLink = routeFromDeepLink(coldStartLink, DEEP_LINK_SCHEME);

  app.on("second-instance", (_event, argv) => {
    // Windows/Linux hand a deep link to the second process in argv.
    const link = deepLinkFromArgv(argv, DEEP_LINK_SCHEME);
    if (link) openDeepLink(link);
    else focusMainWindow();
  });

  app.whenReady().then(onReady);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
