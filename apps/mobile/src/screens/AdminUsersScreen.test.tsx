import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { LocalStore, type AdminUserView, type ApiClient } from "@atlas/client-core";
import { AdminUsersScreen } from "./AdminUsersScreen";
import { withApp, fakeAuth } from "../testutil";

function user(over: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id: "u-1",
    email: "ada@example.com",
    display_name: "Ada",
    is_admin: false,
    disabled: false,
    deletion_scheduled: false,
    deletion_days_remaining: null,
    created_at_ms: 1_754_300_000_000,
    last_login_at_ms: 1_754_400_000_000,
    ...over,
  };
}

async function setup(api: Partial<ApiClient>, session = null) {
  const store = new LocalStore("device-1");
  await render(<AdminUsersScreen />, {
    wrapper: withApp(store, fakeAuth({ api: api as ApiClient, session })),
  });
}

/** Press the confirmation dialog's button (the last one carrying the action's label). */
async function confirm(label: string) {
  const buttons = screen.getAllByText(label);
  await fireEvent.press(buttons[buttons.length - 1]!);
}

describe("AdminUsersScreen", () => {
  it("shows how many days a pending deletion has left", async () => {
    await setup({
      listUsers: jest.fn(async () => [
        user({ deletion_scheduled: true, deletion_days_remaining: 12 }),
        user({ id: "u-2", email: "bob@example.com", display_name: "Bob" }),
      ]),
    });
    expect(await screen.findByText("Deletes in 12 days")).toBeTruthy();
    expect(screen.getAllByText(/Deletes in/)).toHaveLength(1);
  });

  it("searches server-side with the debounced term", async () => {
    const listUsers = jest.fn(async (_params: Parameters<ApiClient["listUsers"]>[0]) => [user()]);
    await setup({ listUsers });

    await fireEvent.changeText(screen.getByLabelText("Search users"), "ada");

    await waitFor(
      () => {
        const calls = listUsers.mock.calls.filter(
          (c) => (c[0] as { search?: string } | undefined)?.search === "ada",
        );
        expect(calls.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
  });

  it("marks an account disabled after the action is confirmed", async () => {
    const setUserDisabled = jest.fn(async () => user({ disabled: true }));
    await setup({
      listUsers: async () => [user()],
      setUserDisabled,
    });

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    // The detail sheet offers the action and asks first; the server guardrails are the real gate.
    await fireEvent.press(screen.getByText("Disable account"));
    expect(setUserDisabled).not.toHaveBeenCalled();
    await confirm("Disable account");

    await waitFor(() => expect(setUserDisabled).toHaveBeenCalledWith("u-1", true));
  });

  it("reloads the truth when an action is refused", async () => {
    const listUsers = jest.fn(async () => [user()]);
    const setUserDisabled = jest.fn(async () => {
      throw new Error("refused");
    });
    await setup({ listUsers, setUserDisabled });

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    await fireEvent.press(screen.getByText("Disable account"));
    await confirm("Disable account");

    // The optimistic state is rolled back by the reload.
    await waitFor(() => expect(listUsers).toHaveBeenCalledTimes(2));
  });

  it("asks before removing admin rights, and does nothing when cancelled", async () => {
    const setUserAdmin = jest.fn(async () => user());
    await setup({ listUsers: async () => [user({ is_admin: true })], setUserAdmin });

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    await fireEvent.press(screen.getByText("Remove admin"));

    expect(screen.getByText("Remove admin rights?")).toBeTruthy();
    expect(screen.getByText(/ada@example.com will lose access/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Cancel"));
    expect(setUserAdmin).not.toHaveBeenCalled();
  });

  it("asks before signing out every device", async () => {
    const logoutUserDevices = jest.fn(async () => {});
    await setup({ listUsers: async () => [user()], logoutUserDevices });

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    await fireEvent.press(screen.getByText("Sign out devices"));
    expect(logoutUserDevices).not.toHaveBeenCalled();
    await confirm("Sign out devices");

    await waitFor(() => expect(logoutUserDevices).toHaveBeenCalledWith("u-1"));
  });

  it("does not offer to sign out your own devices", async () => {
    const logoutUserDevices = jest.fn(async () => {});
    await setup({ listUsers: async () => [user()], logoutUserDevices }, {
      accessToken: "a",
      refreshToken: "r",
      deviceId: "d",
      user: { id: "u-1", email: "ada@example.com", display_name: "Ada" },
    } as never);

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    await fireEvent.press(screen.getByText("Sign out devices"));

    expect(screen.queryByText("Sign out every device?")).toBeNull();
    expect(logoutUserDevices).not.toHaveBeenCalled();
  });

  it("explains, and leaves alone, an admin the server configuration manages", async () => {
    const setUserAdmin = jest.fn(async () => user());
    await setup({
      listUsers: async () => [user({ is_admin: true, managed_by_env: true })],
      setUserAdmin,
    });

    await screen.findByText("Ada");
    await fireEvent.press(screen.getByText("Ada"));
    expect(screen.getByText(/set in the server configuration/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Remove admin"));
    expect(screen.queryByText("Remove admin rights?")).toBeNull();
  });
});
