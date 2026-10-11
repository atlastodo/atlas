import { app, net, shell } from "electron";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type DisableReason = "cli-flag" | "env" | "nixos" | "package-manager" | null;

export interface DisableCheckResult {
  disabled: boolean;
  reason: DisableReason;
  manager: string | null;
}

export interface LaunchEnvironment {
  argv: string[];
  env: NodeJS.ProcessEnv;
  execPath?: string;
  dirname?: string;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "disabled"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadProgress: number; // 0 to 100
  error: string | null;
  disabled: boolean;
  disableReason: DisableReason;
  manager: string | null;
  canSelfUpdate: boolean;
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  assets: GitHubAsset[];
}

/** Whether auto-updates must be disabled by CLI argument, environment variable or packaging (NixOS / Flatpak / Snap). */
export function checkUpdatesDisabled(launch: LaunchEnvironment): DisableCheckResult {
  const argv = launch.argv;
  const env = launch.env;
  const execPath = launch.execPath ?? "";
  const dirname = launch.dirname ?? "";

  // 1. Explicit CLI flag: --no-update or --disable-updates
  if (argv.includes("--no-update") || argv.includes("--disable-updates")) {
    return { disabled: true, reason: "cli-flag", manager: null };
  }

  // 2. Environment variables: ATLAS_DISABLE_UPDATE=1 or ELECTRON_NO_UPDATER=1
  if (env.ATLAS_DISABLE_UPDATE === "1" || env.ELECTRON_NO_UPDATER === "1") {
    return { disabled: true, reason: "env", manager: null };
  }

  // 3. NixOS store path: /nix/store is strictly read-only
  if (execPath.includes("/nix/store/") || dirname.includes("/nix/store/")) {
    return { disabled: true, reason: "nixos", manager: "NixOS" };
  }

  // 4. Flatpak or Snap sandbox environments
  if (env.FLATPAK_ID) {
    return { disabled: true, reason: "package-manager", manager: "Flatpak" };
  }
  if (env.SNAP) {
    return { disabled: true, reason: "package-manager", manager: "Snap" };
  }

  return { disabled: false, reason: null, manager: null };
}

export function parseSemver(
  version: string,
): { major: number; minor: number; patch: number; prerelease: string | null } | null {
  const clean = version.trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(clean);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] ?? null,
  };
}

export function isNewerVersion(current: string, candidate: string): boolean {
  const cur = parseSemver(current);
  const cand = parseSemver(candidate);
  if (!cur || !cand) return false;

  if (cand.major > cur.major) return true;
  if (cand.major < cur.major) return false;

  if (cand.minor > cur.minor) return true;
  if (cand.minor < cur.minor) return false;

  if (cand.patch > cur.patch) return true;
  if (cand.patch < cur.patch) return false;

  if (cur.prerelease && !cand.prerelease) return true;
  if (!cur.prerelease && cand.prerelease) return false;

  return false;
}

/**
 * The lowercase SHA-256 that a `sha256sum`-format listing gives for exactly `fileName`
 * (`<hash>  <name>`, or `<hash> *<name>` in binary mode), or null when it has none.
 */
export function expectedChecksum(sums: string, fileName: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === fileName) return match[1].toLowerCase();
  }
  return null;
}

const DEFAULT_REPO = "atlastodo/atlas-todo";

export class DesktopUpdater {
  private state: UpdateState;
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private readonly repo: string;
  private latestRelease: GitHubRelease | null = null;
  private downloadedFilePath: string | null = null;
  private checkIntervalTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly currentVersion: string,
    launch: LaunchEnvironment,
    repo: string = DEFAULT_REPO,
  ) {
    this.repo = repo;
    const disabledInfo = checkUpdatesDisabled(launch);

    // In-place self-update on Linux needs an AppImage; elsewhere fall back to the release page.
    const isAppImage = process.platform === "linux" && Boolean(launch.env.APPIMAGE);
    const canSelfUpdate = !disabledInfo.disabled && isAppImage;

    this.state = {
      status: disabledInfo.disabled ? "disabled" : "idle",
      currentVersion,
      availableVersion: null,
      releaseNotes: null,
      releaseUrl: null,
      downloadProgress: 0,
      error: null,
      disabled: disabledInfo.disabled,
      disableReason: disabledInfo.reason,
      manager: disabledInfo.manager,
      canSelfUpdate,
    };
  }

  public getState(): UpdateState {
    return { ...this.state };
  }

  public onStateChange(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (err) {
        console.error("[DesktopUpdater] Error in state listener:", err);
      }
    }
  }

  public startPeriodicCheck(initialDelayMs = 30_000, intervalMs = 24 * 60 * 60 * 1000): void {
    if (this.state.disabled) return;
    if (this.checkIntervalTimer) clearInterval(this.checkIntervalTimer);

    setTimeout(() => {
      if (!this.state.disabled) {
        void this.checkForUpdates();
      }
    }, initialDelayMs);

    this.checkIntervalTimer = setInterval(() => {
      if (!this.state.disabled) {
        void this.checkForUpdates();
      }
    }, intervalMs);
  }

  public stopPeriodicCheck(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
    }
  }

  public async checkForUpdates(): Promise<UpdateState> {
    if (this.state.disabled) {
      return this.getState();
    }

    this.setState({ status: "checking", error: null });

    try {
      const url = `https://api.github.com/repos/${this.repo}/releases/latest`;
      const response = await net.fetch(url, {
        headers: {
          "User-Agent": "Atlas-Todo-Desktop",
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API returned HTTP ${response.status}: ${response.statusText}`);
      }

      const release = (await response.json()) as GitHubRelease;
      this.latestRelease = release;

      const newer = isNewerVersion(this.currentVersion, release.tag_name);

      if (newer) {
        this.setState({
          status: "available",
          availableVersion: release.tag_name.replace(/^v/, ""),
          releaseNotes: release.body ?? "",
          releaseUrl: release.html_url,
          downloadProgress: 0,
        });
      } else {
        this.setState({
          status: "up-to-date",
          availableVersion: null,
          releaseNotes: null,
          releaseUrl: null,
          downloadProgress: 0,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[DesktopUpdater] Failed to check for updates:", message);
      this.setState({
        status: "error",
        error: message,
      });
    }

    return this.getState();
  }

  public async downloadUpdate(): Promise<void> {
    if (this.state.disabled || !this.latestRelease) return;

    // On Linux prefer the .AppImage, else the first binary asset
    const assets = this.latestRelease.assets || [];
    let targetAsset: GitHubAsset | undefined;

    if (process.platform === "linux") {
      targetAsset = assets.find((a) => a.name.endsWith(".AppImage"));
    }

    // No in-place asset: open the external download page
    if (!targetAsset || !this.state.canSelfUpdate) {
      if (this.state.releaseUrl) {
        void shell.openExternal(this.state.releaseUrl);
      }
      return;
    }

    this.setState({ status: "downloading", downloadProgress: 0, error: null });

    try {
      const updateDir = path.join(app.getPath("userData"), "updates");
      fs.mkdirSync(updateDir, { recursive: true });

      const destPath = path.join(updateDir, targetAsset.name);
      const tempPath = `${destPath}.tmp-${Date.now()}`;

      const res = await net.fetch(targetAsset.browser_download_url, {
        headers: { "User-Agent": "Atlas-Todo-Desktop" },
      });

      if (!res.ok || !res.body) {
        throw new Error(`Failed to download asset: HTTP ${res.status}`);
      }

      const totalBytes = targetAsset.size || parseInt(res.headers.get("content-length") || "0", 10);
      let downloadedBytes = 0;

      const fileStream = fs.createWriteStream(tempPath);
      const hasher = crypto.createHash("sha256");

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          fileStream.write(Buffer.from(value));
          hasher.update(value);
          downloadedBytes += value.length;
          if (totalBytes > 0) {
            const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            this.setState({ downloadProgress: percent });
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      // Verify against the release's SHA256SUMS.txt. Fail closed: an update that cannot be
      // verified is never installed.
      try {
        const checksumsAsset = assets.find((a) => a.name === "SHA256SUMS.txt");
        if (!checksumsAsset) {
          throw new Error("The release has no SHA256SUMS.txt; refusing an unverified update.");
        }
        const sumsRes = await net.fetch(checksumsAsset.browser_download_url, {
          headers: { "User-Agent": "Atlas-Todo-Desktop" },
        });
        if (!sumsRes.ok) {
          throw new Error(`Failed to download SHA256SUMS.txt: HTTP ${sumsRes.status}`);
        }
        const expectedHash = expectedChecksum(await sumsRes.text(), targetAsset.name);
        if (!expectedHash) {
          throw new Error(`SHA256SUMS.txt has no entry for ${targetAsset.name}.`);
        }
        if (expectedHash !== hasher.digest("hex")) {
          throw new Error("Checksum verification failed for the downloaded update.");
        }
      } catch (err) {
        fs.rmSync(tempPath, { force: true });
        throw err;
      }

      fs.chmodSync(tempPath, 0o755);

      fs.renameSync(tempPath, destPath);
      this.downloadedFilePath = destPath;

      this.setState({
        status: "downloaded",
        downloadProgress: 100,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DesktopUpdater] Download failed:", message);
      this.setState({
        status: "error",
        error: message,
      });
    }
  }

  public installUpdate(): void {
    if (this.state.status !== "downloaded" || !this.downloadedFilePath) return;

    if (process.platform === "linux" && process.env.APPIMAGE) {
      try {
        const currentAppImage = process.env.APPIMAGE;
        fs.copyFileSync(this.downloadedFilePath, currentAppImage);
        fs.chmodSync(currentAppImage, 0o755);

        fs.rmSync(this.downloadedFilePath, { force: true });

        app.relaunch({ execPath: currentAppImage });
        app.quit();
      } catch (err) {
        console.error("[DesktopUpdater] Failed to apply update in-place:", err);
        this.setState({
          status: "error",
          error: "Failed to replace current executable with update.",
        });
      }
    } else {
      app.relaunch();
      app.quit();
    }
  }
}
