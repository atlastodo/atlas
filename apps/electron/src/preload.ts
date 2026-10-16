import { contextBridge, ipcRenderer } from "electron";
// Type-only: a sandboxed preload can require nothing of ours at runtime.
import type { CloseToTrayState } from "./desktopSettings";
import type { UpdateState } from "./updater";

/**
 * The renderer-facing desktop bridge: only what a plain browser tab cannot do and the renderer reads.
 * `isElectron` distinguishes the shell from a tab; `focusWindow` raises the window on a
 * Notification click (the OS does not for renderer-created ones); `safeStorage` encrypts one byte
 * string with the OS key store (null when unusable); `closeToTray` backs Settings' toggle;
 * `updates` provides release check, download and install status; `serverUrl.set` reports the
 * server the renderer resolved, so the window allows plain-http content only for an http server
 * (true when the window is being rebuilt for it).
 */
contextBridge.exposeInMainWorld("atlasDesktop", {
  isElectron: true,
  getDeviceName: (): Promise<string | null> => ipcRenderer.invoke("atlas:get-device-name"),
  focusWindow: (): void => {
    ipcRenderer.send("atlas:focus-window");
  },
  safeStorage: {
    encrypt: (plain: Uint8Array): Promise<Uint8Array | null> =>
      ipcRenderer.invoke("atlas:safe-storage:encrypt", plain),
    decrypt: (sealed: Uint8Array): Promise<Uint8Array | null> =>
      ipcRenderer.invoke("atlas:safe-storage:decrypt", sealed),
  },
  closeToTray: {
    get: (): Promise<CloseToTrayState | null> => ipcRenderer.invoke("atlas:close-to-tray:get"),
    set: (enabled: boolean): Promise<CloseToTrayState | null> =>
      ipcRenderer.invoke("atlas:close-to-tray:set", enabled),
  },
  serverUrl: {
    set: (url: string): Promise<boolean | null> => ipcRenderer.invoke("atlas:server-url:set", url),
  },
  updates: {
    getState: (): Promise<UpdateState | null> => ipcRenderer.invoke("atlas:updates:get-state"),
    checkForUpdates: (): Promise<UpdateState | null> => ipcRenderer.invoke("atlas:updates:check"),
    downloadUpdate: (): Promise<void> => ipcRenderer.invoke("atlas:updates:download"),
    installUpdate: (): void => {
      ipcRenderer.send("atlas:updates:install");
    },
    onStateChange: (callback: (state: UpdateState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
      ipcRenderer.on("atlas:updates:state-changed", handler);
      return () => {
        ipcRenderer.removeListener("atlas:updates:state-changed", handler);
      };
    },
  },
});
