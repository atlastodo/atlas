import type { ReactNode } from "react";
import { Text } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Keyring, generateDek, type Session } from "@atlastodo/client-core";
import { fakeAuth } from "../testutil";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { AuthGate } from "./AuthGate";
import { reloadBypassingCache, UpdateRequiredScreen } from "./UpdateRequiredScreen";

// Signing out counts the unsynced changes in the on-device SQLite database, which does not exist in
// a node process (and its failure would only log); this device holds none.
jest.mock("../data/localData", () => ({
  ...jest.requireActual<typeof import("../data/localData")>("../data/localData"),
  countUnsyncedChanges: jest.fn(async () => 0),
}));

function withAuth(value: Partial<AuthContextValue>) {
  const full = fakeAuth(value);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthContext.Provider value={full}>{children}</AuthContext.Provider>;
  };
}

const SESSION: Session = {
  accessToken: "a",
  refreshToken: "r",
  deviceId: "d",
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" },
};

describe("UpdateRequiredScreen", () => {
  it("on the web, offers a reload that fetches the new version", async () => {
    const reload = jest.fn();
    await render(<UpdateRequiredScreen isWeb reload={reload} />, { wrapper: withAuth({}) });

    expect(screen.getByText("A new version is available")).toBeTruthy();
    await fireEvent.press(screen.getByText("Reload"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("on a phone, asks for an app update and offers a retry", async () => {
    const retryAfterUpgrade = jest.fn();
    await render(<UpdateRequiredScreen isWeb={false} />, {
      wrapper: withAuth({ retryAfterUpgrade }),
    });

    expect(screen.getByText("Please update the app to keep syncing")).toBeTruthy();
    expect(screen.queryByText("Reload")).toBeNull();
    await fireEvent.press(screen.getByText("Retry"));
    expect(retryAfterUpgrade).toHaveBeenCalledTimes(1);
  });

  it("lets a signed-in user sign out without updating", async () => {
    const logout = jest.fn(async () => {});
    await render(<UpdateRequiredScreen isWeb={false} />, {
      wrapper: withAuth({ session: SESSION, logout }),
    });

    await fireEvent.press(screen.getByText("Sign out"));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it("offers no sign-out when nobody is signed in", async () => {
    await render(<UpdateRequiredScreen isWeb />, { wrapper: withAuth({ session: null }) });
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("replaces the app in the gate when the server refuses this build", async () => {
    const keyring = new Keyring({ dek: generateDek() });
    await render(<AuthGate>{() => <Text>APP CONTENT</Text>}</AuthGate>, {
      wrapper: withAuth({ session: { ...SESSION, dek: "00" }, keyring, upgradeRequired: true }),
    });
    expect(screen.queryByText("APP CONTENT")).toBeNull();
    expect(
      screen.queryByText("A new version is available") ??
        screen.queryByText("Please update the app to keep syncing"),
    ).toBeTruthy();
  });
});

describe("reloadBypassingCache", () => {
  it("refreshes the cached page before reloading", async () => {
    const calls: string[] = [];
    const location = { href: "https://atlas.example/today", reload: () => calls.push("reload") };
    const fetchPage = jest.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(`fetch:${init?.cache}`);
      return new Response("");
    }) as unknown as typeof fetch;
    await reloadBypassingCache(location, fetchPage);
    expect(fetchPage).toHaveBeenCalledWith("https://atlas.example/today", { cache: "reload" });
    expect(calls).toEqual(["fetch:reload", "reload"]);
  });

  it("still reloads when the refetch fails", async () => {
    const reload = jest.fn();
    const fetchPage = jest.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    await reloadBypassingCache({ href: "https://atlas.example/", reload }, fetchPage);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
