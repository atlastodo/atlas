import { describe, expect, it } from "vitest";
import {
  checkUpdatesDisabled,
  DesktopUpdater,
  expectedChecksum,
  isNewerVersion,
  parseSemver,
} from "./updater";

describe("checkUpdatesDisabled", () => {
  it("allows updates under default standalone conditions", () => {
    const res = checkUpdatesDisabled({
      argv: ["/usr/bin/electron", "dist/main.js"],
      env: {},
      execPath: "/usr/bin/electron",
      dirname: "/home/user/apps/atlas-desktop/dist",
    });
    expect(res.disabled).toBe(false);
    expect(res.reason).toBeNull();
    expect(res.manager).toBeNull();
  });

  it("disables updates when --no-update CLI flag is passed", () => {
    const res = checkUpdatesDisabled({
      argv: ["electron", "dist/main.js", "--no-update"],
      env: {},
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("cli-flag");
  });

  it("disables updates when --disable-updates CLI flag is passed", () => {
    const res = checkUpdatesDisabled({
      argv: ["electron", "dist/main.js", "--disable-updates"],
      env: {},
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("cli-flag");
  });

  it("disables updates when ATLAS_DISABLE_UPDATE is set to 1", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: { ATLAS_DISABLE_UPDATE: "1" },
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("env");
  });

  it("disables updates when ELECTRON_NO_UPDATER is set to 1", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: { ELECTRON_NO_UPDATER: "1" },
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("env");
  });

  it("disables updates when running from the Nix store via execPath", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: {},
      execPath: "/nix/store/abcdef123-electron-43.1.0/bin/electron",
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("nixos");
    expect(res.manager).toBe("NixOS");
  });

  it("disables updates when running from the Nix store via dirname", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: {},
      dirname: "/nix/store/abcdef123-atlas-desktop-0.30.12/share/atlas-desktop/dist",
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("nixos");
    expect(res.manager).toBe("NixOS");
  });

  it("disables updates under Flatpak", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: { FLATPAK_ID: "io.github.Sejder.AtlasTodo" },
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("package-manager");
    expect(res.manager).toBe("Flatpak");
  });

  it("disables updates under Snap", () => {
    const res = checkUpdatesDisabled({
      argv: [],
      env: { SNAP: "/snap/atlas-todo/current" },
    });
    expect(res.disabled).toBe(true);
    expect(res.reason).toBe("package-manager");
    expect(res.manager).toBe("Snap");
  });
});

describe("semver parsing and comparison", () => {
  it("parses valid semver strings with or without v prefix", () => {
    expect(parseSemver("0.30.12")).toEqual({
      major: 0,
      minor: 30,
      patch: 12,
      prerelease: null,
    });
    expect(parseSemver("v1.2.3-beta.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.1",
    });
    expect(parseSemver("invalid")).toBeNull();
  });

  it("correctly identifies newer versions", () => {
    expect(isNewerVersion("0.30.12", "v0.30.13")).toBe(true);
    expect(isNewerVersion("0.30.12", "0.31.0")).toBe(true);
    expect(isNewerVersion("0.30.12", "1.0.0")).toBe(true);
    expect(isNewerVersion("0.30.12", "0.30.12")).toBe(false);
    expect(isNewerVersion("0.30.12", "0.30.11")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
    expect(isNewerVersion("0.30.12-beta.1", "0.30.12")).toBe(true);
    expect(isNewerVersion("0.30.12", "0.30.12-beta.1")).toBe(false);
  });
});

describe("DesktopUpdater lifecycle", () => {
  it("initializes in disabled state when launched with disable flag", () => {
    const updater = new DesktopUpdater("0.30.12", {
      argv: ["--no-update"],
      env: {},
    });
    const state = updater.getState();
    expect(state.status).toBe("disabled");
    expect(state.disabled).toBe(true);
    expect(state.disableReason).toBe("cli-flag");
  });

  it("initializes in idle state when updates are enabled", () => {
    const updater = new DesktopUpdater("0.30.12", {
      argv: [],
      env: {},
    });
    const state = updater.getState();
    expect(state.status).toBe("idle");
    expect(state.disabled).toBe(false);
    expect(state.currentVersion).toBe("0.30.12");
  });

  it("handles state change listeners", () => {
    const updater = new DesktopUpdater("0.30.12", {
      argv: [],
      env: {},
    });
    const received: string[] = [];
    const unsubscribe = updater.onStateChange((s) => {
      received.push(s.status);
    });

    updater.stopPeriodicCheck();
    unsubscribe();
    expect(received.length).toBe(0);
  });
});

describe("expectedChecksum", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = [
    `${a}  atlas-desktop-0.1.9.AppImage.zsync`,
    `${b} *atlas-desktop-0.1.9.AppImage`,
    "",
  ].join("\n");

  it("returns the lowercase hash for the exact file name, in text or binary mode", () => {
    expect(expectedChecksum(sums, "atlas-desktop-0.1.9.AppImage")).toBe("b".repeat(64));
    expect(expectedChecksum(sums, "atlas-desktop-0.1.9.AppImage.zsync")).toBe(a);
  });

  it("does not match on a substring of another file name", () => {
    expect(
      expectedChecksum(`${a}  atlas-desktop-0.1.9.AppImage.zsync`, "atlas-desktop-0.1.9.AppImage"),
    ).toBeNull();
    expect(expectedChecksum(sums, "0.1.9.AppImage")).toBeNull();
  });

  it("ignores malformed lines", () => {
    expect(expectedChecksum("deadbeef  file.AppImage\nnot a line", "file.AppImage")).toBeNull();
  });
});
