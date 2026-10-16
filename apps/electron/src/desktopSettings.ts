import * as fs from "node:fs";

/**
 * The desktop shell's own preferences: JSON in userData beside window-state.json. They belong
 * to this install, not the account. Reading is best-effort; a missing or corrupt file means defaults.
 */
export interface DesktopSettings {
  /** Windows/Linux: closing the window hides it to the tray instead of quitting the app (the default). */
  closeToTray: boolean;
  /** Whether to check for updates automatically in the background (ignored when updates are disabled). */
  autoCheckUpdates: boolean;
  /**
   * Whether the window may load plain-http content: on only while the chosen server is an
   * `http://` one, since `app://` is a secure origin and blocks it as mixed content.
   */
  allowInsecureServer: boolean;
}

/** What Settings' "Close to tray" row reads: whether there is a tray, and the choice. */
export interface CloseToTrayState {
  available: boolean;
  enabled: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  closeToTray: true,
  autoCheckUpdates: true,
  allowInsecureServer: false,
};

export function loadDesktopSettings(file: string): DesktopSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DesktopSettings> | null;
    return {
      // On unless explicitly turned off.
      closeToTray: raw?.closeToTray !== false,
      autoCheckUpdates: raw?.autoCheckUpdates !== false,
      // Off unless a plain-http server turned it on.
      allowInsecureServer: raw?.allowInsecureServer === true,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export function saveDesktopSettings(file: string, settings: DesktopSettings): void {
  fs.writeFileSync(file, JSON.stringify(settings));
}
