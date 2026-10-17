import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { LocalStore, type AdminInviteView, type ApiClient } from "@atlastodo/client-core";
import { AdminSettingsScreen } from "./AdminSettingsScreen";
import { withApp, fakeAuth, lastCopiedText } from "../testutil";
import { setServerUrlOverride } from "../auth/serverUrl";

function invite(over: Partial<AdminInviteView> = {}): AdminInviteView {
  return {
    id: "i-1",
    code: "a".repeat(64),
    created_at_ms: 1_754_300_000_000,
    expires_at_ms: 1_754_900_000_000,
    used_at_ms: null,
    used_by_email: null,
    revoked_at_ms: null,
    ...over,
  };
}

async function setup(api: Partial<ApiClient>) {
  const store = new LocalStore("device-1");
  await render(<AdminSettingsScreen />, {
    wrapper: withApp(store, fakeAuth({ api: api as ApiClient })),
  });
}

describe("AdminSettingsScreen", () => {
  it("toggles the signup gate through the API", async () => {
    const updateAdminSettings = jest.fn(async (s: { signup_enabled: boolean }) => s);
    await setup({
      getAdminSettings: async () => ({ signup_enabled: true }),
      updateAdminSettings,
    });

    await screen.findByText("Allow new signups");
    await fireEvent.press(screen.getByLabelText("Allow new signups"));

    await waitFor(() =>
      expect(updateAdminSettings).toHaveBeenCalledWith({ signup_enabled: false }),
    );
  });

  it("lists pending invites with a revoke action, but no copy: the list never carries the code", async () => {
    const revokeSignupInvite = jest.fn(async () => {});
    await setup({
      getAdminSettings: async () => ({ signup_enabled: true }),
      listSignupInvites: async () => [invite({ code: null })],
      revokeSignupInvite,
    });

    await screen.findByText("New invite");
    expect(screen.queryByLabelText("Copy link")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Revoke"));
    await waitFor(() => expect(revokeSignupInvite).toHaveBeenCalledWith("i-1"));
  });

  it("mints an invite and surfaces the code for copying", async () => {
    const fresh = invite({ id: "i-2", code: "b".repeat(64) });
    await setup({
      getAdminSettings: async () => ({ signup_enabled: true }),
      listSignupInvites: async () => [],
      createSignupInvite: async () => fresh,
    });

    await screen.findByText("New invite");
    await fireEvent.press(screen.getByText("New invite"));

    // The dialog body carries the code itself; the toast also says "Invite created", so match on
    // the code-bearing body text.
    await screen.findByText(/bbbb/);
    // The dialog's copy button: the only place the code (and so the link) is ever available.
    const copyButtons = screen.getAllByText("Copy link");
    await fireEvent.press(copyButtons[copyButtons.length - 1]!);
    // Off the web the link is built on the server's address: a relative link opens nowhere.
    await waitFor(() =>
      expect(lastCopiedText()).toMatch(/^https?:\/\/[^/]+\/signup\?invite=b{64}$/),
    );
    // Copying keeps the dialog (and the link) up; "Done" closes it.
    await screen.findByText("Copied");
    expect(screen.getByText(/bbbb/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Done"));
    await waitFor(() => expect(screen.queryByText(/bbbb/)).toBeNull());
  });

  it("builds the invite link on the web app's root when the server URL ends in /api", async () => {
    // Distributed builds point at `https://host/api`; the signup page is at the root.
    await setServerUrlOverride("https://todo.example.com/api/");
    try {
      await setup({
        getAdminSettings: async () => ({ signup_enabled: true }),
        listSignupInvites: async () => [],
        createSignupInvite: async () => invite({ id: "i-3", code: "c".repeat(64) }),
      });
      await fireEvent.press(await screen.findByText("New invite"));
      await screen.findByText(/cccc/);
      const copyButtons = screen.getAllByText("Copy link");
      await fireEvent.press(copyButtons[copyButtons.length - 1]!);
      await waitFor(() =>
        expect(lastCopiedText()).toBe(`https://todo.example.com/signup?invite=${"c".repeat(64)}`),
      );
    } finally {
      await setServerUrlOverride("");
    }
  });

  it("names the system, not an anonymous user, for entries no admin made", async () => {
    await setup({
      getAdminSettings: async () => ({ signup_enabled: true }),
      listAudit: async () => [
        {
          id: 2,
          actor_id: null,
          actor_email: null,
          action: "user.promote",
          target_user_id: "u-1",
          target_email: "ada@example.com",
          details: { source: "cli" },
          created_at_ms: 1_754_300_000_000,
        },
      ],
    });

    await screen.findByText("Made admin");
    expect(screen.getByText(/System \(cli\) → ada@example.com/)).toBeTruthy();
    expect(screen.queryByText(/Not signed in/)).toBeNull();
  });
});
