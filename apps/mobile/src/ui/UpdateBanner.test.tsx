/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { UpdateBanner } from "./UpdateBanner";
import type { DesktopUpdatesBridge, UpdateState } from "../hooks/useDesktopUpdates";

function installUpdatesBridge(state: Partial<UpdateState>) {
  const current: UpdateState = {
    status: "idle",
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

  let listener: ((s: UpdateState) => void) | null = null;

  const bridge: DesktopUpdatesBridge = {
    getState: jest.fn(async () => current),
    checkForUpdates: jest.fn(async () => current),
    downloadUpdate: jest.fn(async () => {}),
    installUpdate: jest.fn(() => {}),
    onStateChange: jest.fn((cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };

  (window as unknown as { atlasDesktop?: unknown }).atlasDesktop = { updates: bridge };
  return { bridge, emit: (next: UpdateState) => listener?.(next) };
}

describe("UpdateBanner", () => {
  const wrapper = withApp(new LocalStore("test"));

  afterEach(() => {
    delete (window as unknown as { atlasDesktop?: unknown }).atlasDesktop;
  });

  it("renders nothing outside desktop environment", async () => {
    await render(<UpdateBanner />, { wrapper });
    expect(screen.queryByLabelText("Desktop Updates")).toBeNull();
  });

  it("renders nothing when updates are disabled (e.g. NixOS)", async () => {
    const { bridge } = installUpdatesBridge({
      disabled: true,
      disableReason: "nixos",
      manager: "NixOS",
    });
    await render(<UpdateBanner />, { wrapper });
    await waitFor(() => expect(bridge.getState).toHaveBeenCalled());
    expect(screen.queryByLabelText("Desktop Updates")).toBeNull();
  });

  it("renders update available banner and allows downloading", async () => {
    const { bridge } = installUpdatesBridge({
      status: "available",
      availableVersion: "0.30.13",
      releaseUrl: "https://github.com/atlastodo/atlas-todo/releases/tag/v0.30.13",
    });
    await render(<UpdateBanner />, { wrapper });

    const downloadBtn = await screen.findByRole("button", { name: "Download & Install" });
    expect(screen.getByText("Atlas Todo v0.30.13 is available")).toBeTruthy();
    expect(downloadBtn).toBeTruthy();

    await fireEvent.press(downloadBtn);
    expect(bridge.downloadUpdate).toHaveBeenCalled();
  });

  it("renders downloaded banner and allows restarting to apply", async () => {
    const { bridge } = installUpdatesBridge({
      status: "downloaded",
      availableVersion: "0.30.13",
    });
    await render(<UpdateBanner />, { wrapper });

    const restartBtn = await screen.findByRole("button", { name: "Restart to Apply" });
    expect(screen.getByText("Update v0.30.13 downloaded and ready to install")).toBeTruthy();
    expect(restartBtn).toBeTruthy();

    await fireEvent.press(restartBtn);
    expect(bridge.installUpdate).toHaveBeenCalled();
  });

  it("dismisses the banner when dismiss button is clicked", async () => {
    installUpdatesBridge({
      status: "available",
      availableVersion: "0.30.13",
    });
    await render(<UpdateBanner />, { wrapper });

    const dismissBtn = await screen.findByRole("button", { name: "Dismiss" });
    await fireEvent.press(dismissBtn);

    await waitFor(() => {
      expect(screen.queryByLabelText("Desktop Updates")).toBeNull();
    });
  });
});
