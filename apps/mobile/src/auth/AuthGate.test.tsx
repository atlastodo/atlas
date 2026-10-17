import type { ReactNode } from "react";
import { Text } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Keyring, generateDek, type Session } from "@atlastodo/client-core";
import { fakeAuth, fakeLocalMode } from "../testutil";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { AuthGate, type GateState } from "./AuthGate";
import { LocalModeContext, type LocalModeValue } from "./localMode";

// Signing out counts the unsynced changes in the on-device SQLite database, which does not exist in
// a node process (and its failure would only log); this device holds none.
jest.mock("../data/localData", () => ({
  ...jest.requireActual<typeof import("../data/localData")>("../data/localData"),
  countUnsyncedChanges: jest.fn(async () => 0),
}));

// No local-only data to move into an account in these tests.
jest.mock("../data/localUpgrade", () => ({
  ...jest.requireActual<typeof import("../data/localUpgrade")>("../data/localUpgrade"),
  readLocalData: jest.fn(async () => null),
}));

function withAuth(value: Partial<AuthContextValue>, local: LocalModeValue | null = null) {
  const full = fakeAuth(value);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={full}>
        <LocalModeContext.Provider value={local}>{children}</LocalModeContext.Provider>
      </AuthContext.Provider>
    );
  };
}

/** A session restored without its unwrapped keys, but with the blobs an unlock needs. */
const LOCKED: Session = {
  accessToken: "a",
  refreshToken: "r",
  deviceId: "d",
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" },
  salt: "00ff",
  encryptedDek: { iv: "iv", ct: "dek" },
  encryptedPrivateKey: { iv: "iv", ct: "priv" },
  isE2ee: true,
};

const app = () => <Text>APP CONTENT</Text>;

describe("AuthGate", () => {
  it("shows the sign-in screen without a session", async () => {
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({}) });
    expect(screen.getByText("Sign in")).toBeTruthy();
    expect(screen.queryByText("APP CONTENT")).toBeNull();
  });

  it("shows the unlock screen, not the app, for a session without keys", async () => {
    // The app (and its store, and sync) must never mount locked: it would push plaintext and render ciphertext as empty titles.
    await render(<AuthGate>{app}</AuthGate>, {
      wrapper: withAuth({ session: LOCKED, keyring: null }),
    });
    expect(screen.getByText("Unlock your data")).toBeTruthy();
    expect(screen.getByText("Signed in as ada@example.com")).toBeTruthy();
    expect(screen.queryByText("APP CONTENT")).toBeNull();
  });

  it("renders the app once the keyring is unlocked", async () => {
    const keyring = new Keyring({ dek: generateDek() });
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({ session: LOCKED, keyring }) });
    expect(await screen.findByText("APP CONTENT")).toBeTruthy();
  });

  it("runs the app in local-only mode without a session", async () => {
    const seen: GateState[] = [];
    const local = fakeLocalMode();
    await render(
      <AuthGate>
        {(state) => {
          seen.push(state);
          return <Text>APP CONTENT</Text>;
        }}
      </AuthGate>,
      { wrapper: withAuth({}, local) },
    );
    expect(screen.getByText("APP CONTENT")).toBeTruthy();
    expect(screen.queryByText("Sign in")).toBeNull();
    expect(seen.at(-1)).toEqual({ mode: "local", deviceId: local.deviceId });
  });

  it("shows the asked-for sign-in form, with the way back to this device", async () => {
    const local = fakeLocalMode({ authScreen: "signup" });
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({}, local) });
    expect(screen.getByText("Create account")).toBeTruthy();
    expect(screen.queryByText("APP CONTENT")).toBeNull();

    await fireEvent.press(screen.getByText("Continue without an account"));
    expect(local.closeAuth).toHaveBeenCalled();
  });

  it("says a wrong password inline, and unlocks with the right one", async () => {
    const unlock = jest.fn(async (password: string) => password === "right");
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({ session: LOCKED, unlock }) });

    await fireEvent.changeText(screen.getByLabelText("Password"), "wrong");
    await fireEvent.press(screen.getByText("Unlock"));
    expect(await screen.findByText("Wrong password. Try again.")).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText("Password"), "right");
    await fireEvent.press(screen.getByText("Unlock"));
    await waitFor(() => expect(unlock).toHaveBeenLastCalledWith("right"));
    await waitFor(() => expect(screen.queryByText("Wrong password. Try again.")).toBeNull());
  });

  it("offers a sign-out from the unlock screen", async () => {
    const logout = jest.fn(async () => {});
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({ session: LOCKED, logout }) });
    await fireEvent.press(screen.getByText("Sign out"));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it("falls back to a full sign-in, email prefilled, when there are no blobs to unlock", async () => {
    const bare: Session = { ...LOCKED, salt: undefined, encryptedDek: undefined };
    await render(<AuthGate>{app}</AuthGate>, { wrapper: withAuth({ session: bare }) });
    expect(
      screen.getByText("Sign in again to restore the encryption keys on this device."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Email").props.value).toBe("ada@example.com");
    expect(screen.getByText("Sign in")).toBeTruthy();
  });
});
