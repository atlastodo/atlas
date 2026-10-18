/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { CloseToTrayRow } from "./CloseToTrayRow";

/**
 * The Settings → Features row's contract with the Electron preload's `atlasDesktop.closeToTray`:
 * shown only where the main process reports a tray, reflecting and flipping the choice it holds.
 * jsdom so `window` (where the bridge lives) exists.
 */

type State = { available: boolean; enabled: boolean };

function installBridge(initial: State, set?: (enabled: boolean) => Promise<State | null>) {
  let state = initial;
  const bridge = {
    get: jest.fn(async () => state),
    set: jest.fn(
      set ??
        (async (enabled: boolean) => {
          state = { ...state, enabled };
          return state;
        }),
    ),
  };
  (window as unknown as { atlasDesktop?: unknown }).atlasDesktop = { closeToTray: bridge };
  return bridge;
}

describe("CloseToTrayRow", () => {
  const wrapper = withApp(new LocalStore("test"));

  afterEach(() => {
    delete (window as unknown as { atlasDesktop?: unknown }).atlasDesktop;
  });

  it("renders nothing outside the desktop app", async () => {
    await render(<CloseToTrayRow />, { wrapper });
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("renders nothing where there is no tray to close to", async () => {
    const bridge = installBridge({ available: false, enabled: false });
    await render(<CloseToTrayRow />, { wrapper });
    await waitFor(() => expect(bridge.get).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("shows the saved choice and flips it through the bridge", async () => {
    const bridge = installBridge({ available: true, enabled: false });
    await render(<CloseToTrayRow />, { wrapper });

    const toggle = await screen.findByRole("switch");
    expect(screen.getByText("Close to tray")).toBeTruthy();
    expect(toggle.props.accessibilityState).toEqual({ checked: false });

    await fireEvent.press(toggle);
    expect(bridge.set).toHaveBeenCalledWith(true);
    await waitFor(() =>
      expect(screen.getByRole("switch").props.accessibilityState).toEqual({ checked: true }),
    );
  });

  it("puts the switch back when the main process refuses", async () => {
    installBridge({ available: true, enabled: false }, async () => null);
    await render(<CloseToTrayRow />, { wrapper });

    await fireEvent.press(await screen.findByRole("switch"));
    await waitFor(() =>
      expect(screen.getByRole("switch").props.accessibilityState).toEqual({ checked: false }),
    );
  });
});
