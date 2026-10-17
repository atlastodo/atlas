import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import type { SyncStatus } from "@atlastodo/client-core";
import { StoreContext, type SyncErrorInfo } from "../data/StoreProvider";
import { SyncStatusBadge } from "./SyncStatusBadge";
import { LocalModeContext } from "../auth/localMode";
import { fakeLocalMode } from "../testutil";

/**
 * `useOnline` defaults to online under jest, so a store-"offline" with an HTTP error renders "sync error" and a network
 * error renders "unreachable". The pure split is tested in `../lib/syncStatus.test.ts`.
 */
function withStatus(
  status: SyncStatus,
  lastError: SyncErrorInfo | null = null,
  localOnly?: boolean,
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreContext.Provider
        value={{
          store: {} as never,
          status,
          version: 0,
          kick: () => {},
          resync: async () => {},
          diagnostics: { lastError, lastSyncAt: null, quarantined: [], pending: 0 },
          attachments: null,
          initialSyncDone: true,
          localOnly,
        }}
      >
        {children}
      </StoreContext.Provider>
    );
  };
}

describe("SyncStatusBadge", () => {
  it("reads a short 'Local' in local-only mode, with the details and an account a tap away", async () => {
    const local = fakeLocalMode();
    const Store = withStatus("idle", null, true);
    await render(
      <LocalModeContext.Provider value={local}>
        <SyncStatusBadge />
      </LocalModeContext.Provider>,
      { wrapper: Store },
    );
    expect(screen.getByText("Local")).toBeTruthy();
    expect(screen.queryByText("Synced")).toBeNull();

    await fireEvent.press(screen.getByText("Local"));
    expect(screen.getByText("On this device only")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Create an account"));
    expect(local.openAuth).toHaveBeenCalledWith("signup");
  });

  it("reads 'Synced' when idle", async () => {
    await render(<SyncStatusBadge />, { wrapper: withStatus("idle") });
    expect(screen.getByText("Synced")).toBeTruthy();
  });

  it("reads 'Syncing' while syncing", async () => {
    await render(<SyncStatusBadge />, { wrapper: withStatus("syncing") });
    expect(screen.getByText("Syncing")).toBeTruthy();
  });

  it("reads 'Live' while the realtime WebSocket is connected", async () => {
    await render(<SyncStatusBadge />, { wrapper: withStatus("live-ws") });
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("reads 'Sync error' when the server responded with an HTTP error", async () => {
    const err: SyncErrorInfo = { kind: "http", status: 500, message: "boom", at: 0 };
    await render(<SyncStatusBadge />, { wrapper: withStatus("offline", err) });
    expect(screen.getByText("Sync error")).toBeTruthy();
  });

  it("reads 'Server unreachable' when the request never reached the server", async () => {
    const err: SyncErrorInfo = { kind: "network", message: "Network request failed", at: 0 };
    await render(<SyncStatusBadge />, { wrapper: withStatus("offline", err) });
    const textEl = screen.getByText("Server unreachable");
    expect(textEl).toBeTruthy();
    expect(textEl.props.numberOfLines).toBe(1);
    expect(textEl.props.ellipsizeMode).toBe("tail");
  });
});
