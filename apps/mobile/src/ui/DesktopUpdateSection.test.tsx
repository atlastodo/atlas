/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { DesktopUpdateSection } from "./DesktopUpdateSection";
import type { DesktopUpdatesBridge, UpdateState } from "../hooks/useDesktopUpdates";

function installUpdatesBridge(state: Partial<UpdateState>) {
  const current: UpdateState = {
    status: "up-to-date",
    currentVersion: "0.30.12",
    availableVersion: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadProgress: 0,
    error: null,
    disabled: false,
    disableReason: null,
    manager: null,
    canSelfUpdate: true,
    ...state,
  };

  const bridge: DesktopUpdatesBridge = {
    getState: jest.fn(async () => current),
    checkForUpdates: jest.fn(async () => current),
    downloadUpdate: jest.fn(async () => {}),
    installUpdate: jest.fn(() => {}),
    onStateChange: jest.fn(() => () => {}),
  };

  (window as unknown as { atlasDesktop?: unknown }).atlasDesktop = { updates: bridge };
  return bridge;
}

describe("DesktopUpdateSection", () => {
  const wrapper = withApp(new LocalStore("test"));

  afterEach(() => {
    delete (window as unknown as { atlasDesktop?: unknown }).atlasDesktop;
  });

  it("renders nothing outside desktop", async () => {
    await render(<DesktopUpdateSection />, { wrapper });
    expect(screen.queryByText("Desktop Updates")).toBeNull();
  });

  it("shows one package-manager message whatever the manager", async () => {
    const bridge = installUpdatesBridge({
      disabled: true,
      disableReason: "nixos",
      manager: "NixOS",
    });
    await render(<DesktopUpdateSection />, { wrapper });
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());

    expect(screen.getByText("Desktop Updates")).toBeTruthy();
    expect(screen.getByText("NixOS")).toBeTruthy();
    expect(
      screen.getByText(
        "Automatic updates are off because your package manager handles updates. Update Atlas Todo through it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });

  it("shows up-to-date status and allows checking for updates", async () => {
    const bridge = installUpdatesBridge({
      status: "up-to-date",
      currentVersion: "0.30.12",
    });
    await render(<DesktopUpdateSection />, { wrapper });

    const checkBtn = await screen.findByRole("button", { name: "Check for updates" });
    expect(screen.getByText("Atlas Todo is up to date (v0.30.12)")).toBeTruthy();

    await fireEvent.press(checkBtn);
    await waitFor(() => expect(bridge.checkForUpdates).toHaveBeenCalled());
  });

  it("shows available update and allows downloading", async () => {
    const bridge = installUpdatesBridge({
      status: "available",
      availableVersion: "0.30.13",
      releaseUrl: "https://github.com/atlastodo/atlas-todo/releases/tag/v0.30.13",
    });
    await render(<DesktopUpdateSection />, { wrapper });

    const downloadBtn = await screen.findByRole("button", { name: "Download & Install" });
    expect(screen.getByText("Atlas Todo v0.30.13 is available")).toBeTruthy();
    expect(screen.getByText("Release notes")).toBeTruthy();

    await fireEvent.press(downloadBtn);
    expect(bridge.downloadUpdate).toHaveBeenCalled();
  });
});
