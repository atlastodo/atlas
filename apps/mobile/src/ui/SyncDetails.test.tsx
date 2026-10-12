import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { useState, type ReactNode } from "react";
import {
  Keyring,
  LocalStore,
  generateDek,
  generatePek,
  generateUserKeypair,
  type ApiClient,
  type SyncStatus,
} from "@atlas/client-core";
import { AuthContext } from "../auth/AuthContext";
import type { Session } from "../auth/session";
import { StoreContext, type StoreContextValue } from "../data/StoreProvider";
import { fakeAuth } from "../testutil";
import { SyncDetails } from "./SyncDetails";

let mockOnline = true;
jest.mock("../hooks/useOnline", () => ({ useOnline: () => mockOnline }));

/**
 * The Sync details panel. The store is stubbed through the real `StoreContext` with a genuine
 * in-memory `LocalStore` (so `useFormat` works). Asserts the panel surfaces pending changes and that
 * "Sync now" triggers a sync.
 */
function wrapper(
  kick: () => void = () => {},
  resync: StoreContextValue["resync"] = async () => {},
  status: SyncStatus = "idle",
) {
  const store = new LocalStore("test");
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreContext.Provider
        value={{
          store,
          status,
          version: 0,
          kick,
          resync,
          diagnostics: { lastError: null, lastSyncAt: null, quarantined: [], pending: 2 },
          attachments: null,
          initialSyncDone: true,
        }}
      >
        {children}
      </StoreContext.Provider>
    );
  };
}

function statefulWrapper(onKick?: () => void) {
  const store = new LocalStore("test");
  return function StatefulWrapper({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<"idle" | "syncing" | "offline">("idle");
    const kick = () => {
      onKick?.();
      setStatus("syncing");
      setTimeout(() => {
        setStatus("idle");
      }, 500);
    };
    return (
      <StoreContext.Provider
        value={{
          store,
          status,
          version: 0,
          kick,
          resync: async () => {},
          diagnostics: { lastError: null, lastSyncAt: null, quarantined: [], pending: 2 },
          attachments: null,
          initialSyncDone: true,
        }}
      >
        {children}
      </StoreContext.Provider>
    );
  };
}

describe("SyncDetails", () => {
  it("runs a sync when 'Sync now' is pressed", async () => {
    const kick = jest.fn();
    await render(<SyncDetails open onClose={() => {}} />, { wrapper: wrapper(kick) });
    await fireEvent.press(screen.getByLabelText("Sync now"));
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it("disables 'Sync now' button and shows syncing status for 500ms when pressed", async () => {
    jest.useFakeTimers();
    const kick = jest.fn();
    await render(<SyncDetails open onClose={() => {}} />, { wrapper: statefulWrapper(kick) });
    const button = screen.getByLabelText("Sync now");
    expect(button.props.accessibilityState?.disabled).toBeFalsy();
    await fireEvent.press(button);
    expect(button.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("Syncing")).toBeTruthy();

    await act(() => {
      jest.advanceTimersByTime(500);
    });
    const updatedButton = screen.getByLabelText("Sync now");
    expect(updatedButton.props.accessibilityState?.disabled).toBeFalsy();
    expect(screen.getByText("Synced")).toBeTruthy();
    jest.useRealTimers();
  });

  describe("Resync", () => {
    afterEach(() => {
      mockOnline = true;
    });

    /** Press Resync, then answer the confirm dialog (its confirm button is the second "Resync"). */
    async function confirmResync() {
      await fireEvent.press(screen.getByLabelText("Resync"));
      expect(screen.getByText("Resync this device?")).toBeTruthy();
      await fireEvent.press(screen.getAllByLabelText("Resync").at(-1)!);
    }

    it("asks first, explaining what it does, and does nothing when cancelled", async () => {
      const resync = jest.fn(async () => {});
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync),
      });

      await fireEvent.press(screen.getByLabelText("Resync"));
      expect(screen.getByText(/replaces this device's copy of your data/)).toBeTruthy();
      expect(screen.getByText(/Changes that have not synced yet are kept/)).toBeTruthy();
      await fireEvent.press(screen.getByLabelText("Cancel"));

      expect(screen.queryByText("Resync this device?")).toBeNull();
      expect(resync).not.toHaveBeenCalled();
    });

    it("rebuilds from the server once confirmed and says when it is done", async () => {
      const resync = jest.fn(async () => {});
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync),
      });

      await confirmResync();

      expect(resync).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Resync this device?")).toBeNull();
      expect(await screen.findByText(/Resync complete/)).toBeTruthy();
      expect(screen.getByLabelText("Resync").props.accessibilityState?.disabled).toBeFalsy();
    });

    it("shows why when the resync fails", async () => {
      const resync = jest.fn(async () => {
        throw new Error("Network request failed");
      });
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync),
      });

      await confirmResync();

      expect(await screen.findByText("Resync failed: Network request failed")).toBeTruthy();
    });

    it("says it will run later when sync is paused", async () => {
      const resync = jest.fn(async () => "postponed" as const);
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync),
      });

      await confirmResync();

      expect(await screen.findByText(/Sync is paused right now/)).toBeTruthy();
    });

    it("is disabled while it runs", async () => {
      let finish: () => void = () => {};
      const resync = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync),
      });

      await confirmResync();

      const running = screen.getByLabelText("Resync");
      expect(running.props.accessibilityState?.disabled).toBe(true);
      expect(screen.getByText("Resyncing")).toBeTruthy();
      await act(async () => finish());
      await waitFor(() =>
        expect(screen.getByLabelText("Resync").props.accessibilityState?.disabled).toBeFalsy(),
      );
    });

    it("does not start without a connection, and says so", async () => {
      mockOnline = false;
      const resync = jest.fn(async () => {});
      await render(<SyncDetails open onClose={() => {}} />, {
        wrapper: wrapper(undefined, resync, "offline"),
      });

      await confirmResync();

      expect(resync).not.toHaveBeenCalled();
      expect(screen.getByText(/You're offline/)).toBeTruthy();
    });
  });
});

describe("projects without a key", () => {
  const joined = "11111111-0000-4000-8000-000000000001";
  const owned = "22222222-0000-4000-8000-000000000002";
  const keyed = "33333333-0000-4000-8000-000000000003";
  const left = "44444444-0000-4000-8000-000000000004";

  function member(store: LocalStore, projectId: string, userId: string, role: string) {
    const id = `${projectId}:${userId}`;
    store.set("project_member", id, "project_id", projectId);
    store.set("project_member", id, "user_id", userId);
    store.set("project_member", id, "role", role);
    store.set("project_member", id, "state", "active");
  }

  function setup() {
    const store = new LocalStore("test");
    member(store, joined, "u-owner", "owner");
    member(store, joined, "me", "editor");
    member(store, owned, "me", "owner");
    member(store, keyed, "u-owner", "owner");
    member(store, keyed, "me", "editor");
    // Left: the user's own membership is gone, the owner's row stays in their data.
    member(store, left, "u-owner", "owner");
    member(store, left, "me", "editor");
    store.remove("project_member", `${left}:me`);
    const me = generateUserKeypair();
    const keyring = new Keyring({
      dek: generateDek(),
      userPrivateKey: me.secretKey,
      userPublicKey: me.publicKey,
    });
    keyring.setProjectKey(keyed, generatePek());
    // A task edited in the keyless project, and one in the keyed project.
    store.set("task", "t-joined", "project_id", joined);
    store.set("task", "t-joined", "title", "held back");
    store.set("task", "t-keyed", "project_id", keyed);
    const removeMember = jest.fn(async (_projectId: string, _userId: string) => {});
    const auth = fakeAuth({
      session: { user: { id: "me" } } as Session,
      keyring,
      api: { removeMember } as unknown as ApiClient,
    });
    const kick = jest.fn();
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <AuthContext.Provider value={auth}>
          <StoreContext.Provider
            value={{
              store,
              status: "idle",
              version: 0,
              kick,
              resync: async () => {},
              diagnostics: { lastError: null, lastSyncAt: null, quarantined: [], pending: 4 },
              attachments: null,
              initialSyncDone: true,
            }}
          >
            {children}
          </StoreContext.Provider>
        </AuthContext.Provider>
      );
    }
    return { store, removeMember, kick, Wrapper };
  }

  it("lists only joined projects this device has no key for", async () => {
    const { Wrapper } = setup();
    await render(<SyncDetails open onClose={() => {}} />, { wrapper: Wrapper });

    expect(screen.getByText("Projects without a key")).toBeTruthy();
    expect(screen.getByText("Project 11111111…")).toBeTruthy();
    // Owned (its maintenance keys it) and keyed projects are not offered.
    expect(screen.queryByText("Project 22222222…")).toBeNull();
    expect(screen.queryByText("Project 33333333…")).toBeNull();
    // A project the user left is gone from the list, whatever rows of others remain.
    expect(screen.queryByText("Project 44444444…")).toBeNull();
  });

  it("leaves after a confirm and discards the changes held back for it", async () => {
    const { store, removeMember, kick, Wrapper } = setup();
    await render(<SyncDetails open onClose={() => {}} />, { wrapper: Wrapper });

    await fireEvent.press(screen.getByLabelText("Leave Project 11111111…"));
    expect(screen.getByText("Leave this project?")).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getAllByLabelText("Leave").at(-1)!);
    });

    expect(removeMember).toHaveBeenCalledWith(joined, "me");
    expect(await screen.findByText("You left Project 11111111….")).toBeTruthy();
    const left = store.unsyncedOps().map((op) => op.entityId);
    expect(left).not.toContain("t-joined");
    expect(left).toContain("t-keyed");
    expect(kick).toHaveBeenCalled();
  });

  it("keeps the changes when leaving fails", async () => {
    const { store, removeMember, Wrapper } = setup();
    removeMember.mockRejectedValueOnce(new Error("offline"));
    await render(<SyncDetails open onClose={() => {}} />, { wrapper: Wrapper });

    await fireEvent.press(screen.getByLabelText("Leave Project 11111111…"));
    await act(async () => {
      await fireEvent.press(screen.getAllByLabelText("Leave").at(-1)!);
    });

    expect(await screen.findByText(/Couldn't leave Project 11111111…: offline/)).toBeTruthy();
    expect(store.unsyncedOps().map((op) => op.entityId)).toContain("t-joined");
  });
});

describe("changes to projects the user left", () => {});

describe("changes the server rejected", () => {
  const rejected = (opId: string, entityKind: string, entityId: string, at: number) => ({
    opId,
    entityKind,
    entityId,
    status: 403,
    message: "no edit access to this project",
    at,
  });

  function rejectedWrapper(store: LocalStore, dismissQuarantined: (opId?: string) => void) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <StoreContext.Provider
          value={{
            store,
            status: "idle",
            version: 0,
            kick: () => {},
            resync: async () => {},
            diagnostics: {
              lastError: null,
              lastSyncAt: null,
              quarantined: [
                rejected("op-1", "task", "t-kept", 2000),
                rejected("op-2", "task", "t-gone", 1000),
              ],
              pending: 0,
            },
            dismissQuarantined,
            attachments: null,
            initialSyncDone: true,
          }}
        >
          {children}
        </StoreContext.Provider>
      );
    };
  }

  it("names the task when this device still holds it, the id otherwise", async () => {
    const store = new LocalStore("test");
    store.set("task", "t-kept", "title", "Book the venue");
    await render(<SyncDetails open onClose={() => {}} />, {
      wrapper: rejectedWrapper(store, () => {}),
    });

    expect(screen.getByText("2 rejected changes")).toBeTruthy();
    expect(screen.getByText("Book the venue")).toBeTruthy();
    // A rejected create was taken back: only the generic description is left.
    expect(screen.getByText(/t-gone/)).toBeTruthy();
    expect(screen.queryByText(/t-kept/)).toBeNull();
  });

  it("dismisses one entry, or all of them", async () => {
    const dismiss = jest.fn();
    await render(<SyncDetails open onClose={() => {}} />, {
      wrapper: rejectedWrapper(new LocalStore("test"), dismiss),
    });

    await fireEvent.press(
      screen.getAllByLabelText("Remove this rejected change from the list")[1]!,
    );
    expect(dismiss).toHaveBeenLastCalledWith("op-2");
    await fireEvent.press(screen.getByText("Clear all"));
    expect(dismiss).toHaveBeenLastCalledWith();
  });
});
