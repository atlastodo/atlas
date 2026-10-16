import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_SETTINGS,
  loadDesktopSettings,
  saveDesktopSettings,
} from "./desktopSettings";

describe("desktop settings", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-desktop-settings-"));
    file = path.join(dir, "desktop-settings.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to closing to the tray when nothing is saved", () => {
    expect(loadDesktopSettings(file)).toEqual({
      closeToTray: true,
      autoCheckUpdates: true,
      allowInsecureServer: false,
    });
    expect(DEFAULT_DESKTOP_SETTINGS.closeToTray).toBe(true);
    expect(DEFAULT_DESKTOP_SETTINGS.autoCheckUpdates).toBe(true);
  });

  it("round-trips the close-to-tray choice", () => {
    saveDesktopSettings(file, {
      closeToTray: true,
      autoCheckUpdates: true,
      allowInsecureServer: false,
    });
    expect(loadDesktopSettings(file)).toEqual({
      closeToTray: true,
      autoCheckUpdates: true,
      allowInsecureServer: false,
    });
    saveDesktopSettings(file, {
      closeToTray: false,
      autoCheckUpdates: false,
      allowInsecureServer: true,
    });
    expect(loadDesktopSettings(file)).toEqual({
      closeToTray: false,
      autoCheckUpdates: false,
      allowInsecureServer: true,
    });
  });

  it("keeps insecure content off unless a file turned it on", () => {
    expect(DEFAULT_DESKTOP_SETTINGS.allowInsecureServer).toBe(false);
    fs.writeFileSync(file, '{"closeToTray":true,"autoCheckUpdates":true}');
    expect(loadDesktopSettings(file).allowInsecureServer).toBe(false);
    fs.writeFileSync(file, '{"allowInsecureServer":"yes"}');
    expect(loadDesktopSettings(file).allowInsecureServer).toBe(false);
  });

  it("reads a corrupt or foreign file as the defaults", () => {
    for (const body of ["{not json", "null", "42", '{"closeToTray":"yes"}']) {
      fs.writeFileSync(file, body);
      expect(loadDesktopSettings(file)).toEqual({
        closeToTray: true,
        autoCheckUpdates: true,
        allowInsecureServer: false,
      });
    }
  });

  it("throws when the file cannot be written", () => {
    expect(() =>
      saveDesktopSettings(path.join(dir, "missing", "x.json"), {
        closeToTray: true,
        autoCheckUpdates: true,
        allowInsecureServer: false,
      }),
    ).toThrow();
  });
});
