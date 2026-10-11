import { Platform } from "react-native";
import { fireEvent, render as render, screen, waitFor } from "@testing-library/react-native";
import { ApiError, LocalStore, type ApiClient } from "@atlas/client-core";
import { PREFERENCES_ID } from "@atlas/shared";
import { fakeAuth, withApp } from "../testutil";
import { settingsSections, type SettingsSectionId } from "../nav/settingsNav";
import { relativeLabel, SettingsScreen } from "./SettingsScreen";

jest.mock("../../modules/atlas-exact-alarm", () => ({
  ExactAlarm: {
    canScheduleExactAlarms: () => false,
    openExactAlarmSettingsAsync: jest.fn(async () => true),
  },
}));

const SESSION = {
  accessToken: "a",
  refreshToken: "r",
  deviceId: "d",
  user: { id: "u1", email: "mikkel@example.com", display_name: "Mikkel" },
};

/** Over a real `LocalStore`: asserts the screen shows the stored value and writes the choice back. Opens one section per test. */
async function mountAuth(
  section: SettingsSectionId,
  store: LocalStore,
  auth: Parameters<typeof fakeAuth>[0] = {},
) {
  await render(
    <SettingsScreen section={section} onSelectSection={() => {}} onSelectAdminTab={() => {}} />,
    { wrapper: withApp(store, fakeAuth({ session: SESSION, ...auth })) },
  );
}

async function mount(section: SettingsSectionId, seed: Record<string, unknown> = {}) {
  const store = new LocalStore("test");
  for (const [field, value] of Object.entries(seed)) {
    store.set("preference", PREFERENCES_ID, field, value);
  }
  await mountAuth(section, store);
  return store;
}

const read = (store: LocalStore, field: string) =>
  (store.get("preference", PREFERENCES_ID) ?? {})[field];

describe("SettingsScreen", () => {
  it("gathers reminders and exact alarms under Notifications", async () => {
    const store = await mount("notifications");
    expect(screen.getByText(/up to 10 minutes late/)).toBeTruthy();
    const { ExactAlarm } = jest.requireMock("../../modules/atlas-exact-alarm");
    const buttons = screen.getAllByLabelText("Open settings");
    await fireEvent.press(buttons[buttons.length - 1]!);
    expect(ExactAlarm.openExactAlarmSettingsAsync).toHaveBeenCalled();

    await fireEvent(screen.getByLabelText("Reminders"), "valueChange", false);
    expect(read(store, "reminders_enabled")).toBe(false);
    expect(screen.queryByText(/up to 10 minutes late/)).toBeNull();
  });

  it("writes a feature toggle to the store", async () => {
    const store = await mount("features");
    // Habits default on, so this switches them off.
    await fireEvent(screen.getByLabelText("Habits & streaks"), "valueChange", false);
    expect(read(store, "habits_enabled")).toBe(false);
  });

  it("shows a toggle in the position the stored value implies", async () => {
    const store = await mount("features", { stats_enabled: false });
    expect(screen.getByLabelText("Productivity stats").props.value).toBe(false);
    expect(screen.getByLabelText("Focus timer & time tracking").props.value).toBe(true);
    expect(read(store, "stats_enabled")).toBe(false);
  });

  it("picks an accent, and marks the current one selected", async () => {
    const store = await mount("appearance", { accent: "indigo" });
    expect(screen.getByLabelText("Indigo").props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText("Rose").props.accessibilityState.selected).toBe(false);

    await fireEvent.press(screen.getByLabelText("Rose"));
    expect(read(store, "accent")).toBe("rose");
  });

  it("hides the pomodoro section when the focus feature is off", async () => {
    // A disabled feature must hide *everywhere*, its configuration included -- otherwise Settings
    // offers you knobs for something the app no longer has.
    await mount("features", { focus_enabled: false });
    expect(screen.queryByLabelText("Focus length (min)")).toBeNull();
  });

  it("shows the pomodoro section when focus is on, and writes a length", async () => {
    const store = await mount("features");
    const field = screen.getByLabelText("Focus length (min)");
    await fireEvent.changeText(field, "30");
    await fireEvent(field, "blur");
    expect(read(store, "pomodoro_work_min")).toBe(30);
  });

  it("refuses a pomodoro length below one minute, restoring the stored value", async () => {
    // A zero-length phase would never run.
    const store = await mount("features");
    const field = screen.getByLabelText("Focus length (min)");
    await fireEvent.changeText(field, "0");
    await fireEvent(field, "blur");
    expect(read(store, "pomodoro_work_min")).toBeUndefined();
    expect(field.props.value).toBe("25");
  });

  it("opens a picker and stores the choice", async () => {
    const store = await mount("tasks");
    await fireEvent.press(screen.getByLabelText("Default home view"));
    await fireEvent.press(screen.getByLabelText("Upcoming"));
    expect(read(store, "default_view")).toBe("upcoming");
  });

  it("does not offer Completed as a landing view", async () => {
    // It is history: landing there would open the app on a list of things already done.
    await mount("tasks");
    await fireEvent.press(screen.getByLabelText("Default home view"));
    expect(screen.queryByLabelText("Completed")).toBeNull();
  });

  it("finds a timezone by search and stores it", async () => {
    // The zone list runs to hundreds of entries, so the FlatList only renders a window of it and
    // search is the only way to reach most zones -- which is why the picker has a search box at all.
    const store = await mount("calendar");
    await fireEvent.press(screen.getByLabelText("Timezone"));
    await fireEvent.changeText(screen.getByLabelText("Search"), "copenhagen");
    await fireEvent.press(screen.getByLabelText("Europe/Copenhagen"));
    expect(read(store, "timezone")).toBe("Europe/Copenhagen");
  });

  it("offers a device default that clears the timezone override", async () => {
    // "" means follow the device; it must be reachable, or a chosen zone could never be undone.
    const store = await mount("calendar", { timezone: "Asia/Tokyo" });
    await fireEvent.press(screen.getByLabelText("Timezone"));
    await fireEvent.press(screen.getByLabelText(/^Device default/));
    expect(read(store, "timezone")).toBe("");
  });

  it("shows who is signed in and can sign out", async () => {
    const logout = jest.fn();
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      logout,
    });

    expect(screen.getByText("Mikkel")).toBeTruthy();
    expect(screen.getByText("mikkel@example.com")).toBeTruthy();
    await fireEvent.press(screen.getByText("Sign out"));
    await waitFor(() => expect(logout).toHaveBeenCalled());
  });

  it("warns before signing out deletes changes that have not synced, and lets the user cancel", async () => {
    const logout = jest.fn();
    const store = new LocalStore("test");
    store.set("task", "t1", "title", "not pushed yet");
    await mountAuth("account", store, {
      logout,
    });

    await fireEvent.press(screen.getByText("Sign out"));
    expect(await screen.findByText("Sign out and delete unsynced changes?")).toBeTruthy();
    expect(screen.getByText(/1 change on this device has not reached the server/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Cancel"));
    expect(logout).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("Sign out"));
    await fireEvent.press(await screen.findByText("Sign out anyway"));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("confirms and calls deleteAccount with the password when Delete account is clicked", async () => {
    const deleteAccount = jest.fn(async () => {});
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      deleteAccount,
    });

    await fireEvent.press(screen.getByRole("button", { name: "Delete account" }));
    expect(
      screen.getByText(
        "Your account and all associated data will be scheduled for deletion. You can cancel this within 30 days by signing back in. After 30 days, your account will be permanently deleted.",
      ),
    ).toBeTruthy();

    // The confirmation asks for the account's password; the empty form does not reach the auth
    // context, and a wrong password stays in the dialog with an inline error.
    const confirmButtons = () => screen.getAllByRole("button", { name: "Delete account" });
    await fireEvent.press(confirmButtons()[confirmButtons().length - 1]!);
    expect(deleteAccount).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(confirmButtons()[confirmButtons().length - 1]!);
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith("hunter2hunter"));
    // The dialog closes only after the deletion resolves, a tick later than the call.
    await waitFor(() =>
      expect(
        screen.queryByText(
          "Your account and all associated data will be scheduled for deletion. You can cancel this within 30 days by signing back in. After 30 days, your account will be permanently deleted.",
        ),
      ).toBeNull(),
    );
  });

  it("changes the password from the account section", async () => {
    const changePassword = jest.fn(async () => {});
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      changePassword,
    });

    await fireEvent.changeText(screen.getByLabelText("Current password"), "hunter2hunter");
    await fireEvent.changeText(screen.getByLabelText("New password"), "newhunter2new");
    await fireEvent.changeText(screen.getByLabelText("Confirm new password"), "newhunter2new");
    await fireEvent.press(screen.getByLabelText("Update password"));

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith("hunter2hunter", "newhunter2new"),
    );
  });

  it("refuses a change-password submit whose confirmation does not match", async () => {
    const changePassword = jest.fn(async () => {});
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      changePassword,
    });

    await fireEvent.changeText(screen.getByLabelText("Current password"), "hunter2hunter");
    await fireEvent.changeText(screen.getByLabelText("New password"), "newhunter2new");
    await fireEvent.changeText(screen.getByLabelText("Confirm new password"), "different");
    await fireEvent.press(screen.getByLabelText("Update password"));

    expect(await screen.findByText("Passwords do not match")).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("shows an inline error when the current password is wrong", async () => {
    // The server answers a wrong current password with 403 `invalid_credentials`; a 401 would be
    // the session, not the password.
    const changePassword = jest.fn(async () => {
      throw new ApiError(403, "invalid credentials", { code: "invalid_credentials" });
    });
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      changePassword,
    });

    await fireEvent.changeText(screen.getByLabelText("Current password"), "wrong-password");
    await fireEvent.changeText(screen.getByLabelText("New password"), "newhunter2new");
    await fireEvent.changeText(screen.getByLabelText("Confirm new password"), "newhunter2new");
    await fireEvent.press(screen.getByLabelText("Update password"));

    expect(await screen.findByText("Password is incorrect")).toBeTruthy();
  });

  it("refuses a new password below the length floor before any request", async () => {
    const changePassword = jest.fn(async () => {});
    const store = new LocalStore("test");
    await mountAuth("account", store, {
      changePassword,
    });

    await fireEvent.changeText(screen.getByLabelText("Current password"), "hunter2hunter");
    await fireEvent.changeText(screen.getByLabelText("New password"), "short");
    await fireEvent.changeText(screen.getByLabelText("Confirm new password"), "short");
    await fireEvent.press(screen.getByLabelText("Update password"));

    expect(await screen.findByText("Password must be at least 8 characters")).toBeTruthy();
    expect(changePassword).not.toHaveBeenCalled();
  });

  describe("a new recovery phrase", () => {
    const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(" ");

    async function mountAccount(replaceRecoveryPhrase: (password: string) => Promise<string>) {
      await mountAuth("account", new LocalStore("test"), { replaceRecoveryPhrase });
    }

    it("says the old phrase stops working, then shows the new one once", async () => {
      const replaceRecoveryPhrase = jest.fn(async () => PHRASE);
      await mountAccount(replaceRecoveryPhrase);
      expect(screen.getByText(/Your current phrase stops working/)).toBeTruthy();

      await fireEvent.changeText(screen.getByLabelText("Your password"), "hunter2hunter");
      await fireEvent.press(screen.getByLabelText("Create new recovery phrase"));

      await waitFor(() => expect(replaceRecoveryPhrase).toHaveBeenCalledWith("hunter2hunter"));
      expect(await screen.findByText("Emergency recovery phrase")).toBeTruthy();
      expect(screen.getByText("word24")).toBeTruthy();
      expect(screen.getByText(/previous recovery phrase no longer works/)).toBeTruthy();
      // The password field does not keep the password.
      expect(screen.getByLabelText("Your password").props.value).toBe("");

      await fireEvent.press(screen.getByText("I have saved my recovery phrase"));
      await waitFor(() => expect(screen.queryByText("Emergency recovery phrase")).toBeNull());
    });

    it("asks for the password before any request", async () => {
      const replaceRecoveryPhrase = jest.fn(async () => PHRASE);
      await mountAccount(replaceRecoveryPhrase);

      await fireEvent.press(screen.getByLabelText("Create new recovery phrase"));

      expect(await screen.findByText("Enter your password to confirm")).toBeTruthy();
      expect(replaceRecoveryPhrase).not.toHaveBeenCalled();
    });

    it("shows a wrong password inline and no phrase", async () => {
      const replaceRecoveryPhrase = jest.fn(async (): Promise<string> => {
        throw new ApiError(403, "invalid credentials", { code: "invalid_credentials" });
      });
      await mountAccount(replaceRecoveryPhrase);

      await fireEvent.changeText(screen.getByLabelText("Your password"), "wrong-password");
      await fireEvent.press(screen.getByLabelText("Create new recovery phrase"));

      expect(await screen.findByText("Password is incorrect")).toBeTruthy();
      expect(screen.queryByText("Emergency recovery phrase")).toBeNull();
    });

    it("says so when the phrase could not be created", async () => {
      const replaceRecoveryPhrase = jest.fn(async (): Promise<string> => {
        throw new Error("offline");
      });
      await mountAccount(replaceRecoveryPhrase);

      await fireEvent.changeText(screen.getByLabelText("Your password"), "hunter2hunter");
      await fireEvent.press(screen.getByLabelText("Create new recovery phrase"));

      expect(await screen.findByText(/Could not create a new recovery phrase/)).toBeTruthy();
    });
  });

  it("toggles smart view visibility in menu", async () => {
    const store = await mount("sidebar");
    await fireEvent(screen.getByLabelText("Today in menu"), "valueChange", false);
    expect(read(store, "menu_smart_views")).toEqual({ today: false });
  });

  it("toggles project visibility in menu", async () => {
    const store = new LocalStore("test");
    store.set("project", "p1", "id", "p1");
    store.set("project", "p1", "name", "Work Project");
    await mountAuth("sidebar", store);
    await fireEvent.press(screen.getByLabelText("Projects in menu"));
    await fireEvent(screen.getByLabelText("Work Project in menu"), "valueChange", false);
    expect(read(store, "project_pinned")).toEqual({ p1: false });
  });

  const sessionList = () => {
    const now = Date.now();
    return [
      {
        device_id: "aaaaaaaa-1111-2222-3333-444444444444",
        created_at: now - 60_000,
        last_used_at: now,
        expires_at: now + 30 * 86_400_000,
        current: true,
      },
      {
        device_id: "bbbbbbbb-1111-2222-3333-444444444444",
        created_at: now - 90 * 86_400_000,
        last_used_at: now - 30 * 86_400_000,
        expires_at: now + 10 * 86_400_000,
        current: false,
      },
    ];
  };

  it("lists the signed-in devices and marks the current one", async () => {
    const api = { listSessions: jest.fn(async () => sessionList()) };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });

    // Both families render; the caller's own carries the marker (and no sign-out button, while
    // the other device's does)...
    expect(await screen.findByText("This device")).toBeTruthy();
    expect(screen.getByLabelText("Sign out Device bbbbbbbb")).toBeTruthy();
    // ...and the relative dates are spoken, not printed as clocks.
    expect(screen.getByText(/Signed in 1 minute ago/)).toBeTruthy();
    expect(screen.getByText(/Signed in 3 months ago/)).toBeTruthy();
  });

  it("has no sign-out button on this device's own row", async () => {
    // The server answers 400 for a self-revoke, so the row must not offer one.
    const api = { listSessions: jest.fn(async () => sessionList()) };
    await mountAuth("devices", new LocalStore("test"), { api: api as unknown as ApiClient });
    await screen.findByText("This device");
    expect(screen.queryByLabelText(/^Sign out Device aaaaaaaa/)).toBeNull();
  });

  it("revokes another device from its row and reloads the list", async () => {
    const api = {
      listSessions: jest
        .fn()
        .mockResolvedValueOnce(sessionList())
        .mockResolvedValueOnce(sessionList().filter((s) => s.current)),
      revokeSession: jest.fn(async () => {}),
    };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });

    await fireEvent.press(await screen.findByLabelText("Sign out Device bbbbbbbb"));
    await waitFor(() =>
      expect(api.revokeSession).toHaveBeenCalledWith("bbbbbbbb-1111-2222-3333-444444444444"),
    );
    await waitFor(() => expect(screen.queryByText("This device")).toBeTruthy());
    expect(await screen.findByText("Device signed out")).toBeTruthy();
  });

  it("signs the other devices out only after a confirm dialog", async () => {
    const api = {
      listSessions: jest.fn(async () => sessionList()),
      revokeOtherSessions: jest.fn(async () => {}),
    };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });
    await screen.findByText("This device");

    await fireEvent.press(screen.getByLabelText("Sign out other devices"));
    expect(api.revokeOtherSessions).not.toHaveBeenCalled();

    // The dialog confirms; its own confirm button is the last "Sign out other devices" affordance.
    expect(
      screen.getByText(
        "Every other device signed in to your account will be signed out. This device stays signed in.",
      ),
    ).toBeTruthy();
    const confirmButtons = () => screen.getAllByRole("button", { name: "Sign out other devices" });
    await fireEvent.press(confirmButtons()[confirmButtons().length - 1]!);
    await waitFor(() => expect(api.revokeOtherSessions).toHaveBeenCalled());
    await screen.findByText("Other devices signed out");
  });

  it("shows a retry row when the session list fails to load", async () => {
    const api = {
      listSessions: jest.fn(async () => {
        throw new ApiError(500, "boom");
      }),
    };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });

    expect(await screen.findByText("Could not load your devices.")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Try again"));
    await screen.findByText("Could not load your devices.");
    expect(api.listSessions.mock.calls.length).toBe(2);
  });

  it("displays device_name when present and falls back to Device <prefix>", async () => {
    const now = Date.now();
    const sessions = [
      {
        device_id: "aaaaaaaa-1111-2222-3333-444444444444",
        device_name: "MacBook Pro",
        created_at: now,
        last_used_at: now,
        expires_at: now + 30 * 86_400_000,
        current: true,
      },
      {
        device_id: "bbbbbbbb-1111-2222-3333-444444444444",
        device_name: null,
        created_at: now - 3600_000,
        last_used_at: now - 3600_000,
        expires_at: now + 10 * 86_400_000,
        current: false,
      },
    ];
    const api = { listSessions: jest.fn(async () => sessions) };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });

    expect(await screen.findByText("MacBook Pro")).toBeTruthy();
    expect(screen.getByText("Device bbbbbbbb")).toBeTruthy();
    // Fresh session within current minute shows "just now"
    expect(screen.getByText(/Signed in just now · Last used just now/)).toBeTruthy();
  });

  it("renames a device and reloads the session list", async () => {
    const now = Date.now();
    const initialSessions = [
      {
        device_id: "aaaaaaaa-1111-2222-3333-444444444444",
        device_name: "Old Name",
        created_at: now,
        last_used_at: now,
        expires_at: now + 30 * 86_400_000,
        current: true,
      },
    ];
    const updatedSessions = [
      {
        ...initialSessions[0],
        device_name: "Work Laptop",
      },
    ];
    const api = {
      listSessions: jest
        .fn()
        .mockResolvedValueOnce(initialSessions)
        .mockResolvedValueOnce(updatedSessions),
      renameSession: jest.fn(async () => {}),
    };
    const store = new LocalStore("test");
    await mountAuth("devices", store, { api: api as unknown as ApiClient });

    expect(await screen.findByText("Old Name")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Rename Old Name"));

    const input = screen.getByLabelText("Device name");
    await fireEvent.changeText(input, "Work Laptop");
    await fireEvent.press(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.renameSession).toHaveBeenCalledWith(
        "aaaaaaaa-1111-2222-3333-444444444444",
        "Work Laptop",
      ),
    );
    expect(await screen.findByText("Device renamed")).toBeTruthy();
    expect(await screen.findByText("Work Laptop")).toBeTruthy();
  });
});

describe("relativeLabel", () => {
  // Regression: Hermes on Android can ship without the Intl.RelativeTimeFormat ICU feature. The
  // old implementation "fell back" by re-running the same missing constructor in its catch block,
  // so `undefined cannot be used as a constructor` escaped and crashed the whole Settings screen
  // (DevicesSection render via the session rows). These pin the missing-Intl path: no throw, same
  // coarse-unit shape, translated output.
  it("degrades gracefully without Intl.RelativeTimeFormat", async () => {
    const Original = Intl.RelativeTimeFormat;
    Object.defineProperty(Intl, "RelativeTimeFormat", { value: undefined, configurable: true });
    try {
      const now = Date.UTC(2026, 8, 22, 12, 0, 0);
      expect(relativeLabel(now - 3 * 60 * 24 * 60_000, now)).toBe("3 days ago");
      expect(relativeLabel(now - 2 * 60 * 60_000, now)).toBe("2 hours ago");
      expect(relativeLabel(now + 2 * 60_000, now)).toBe("in 2 minutes");
      expect(relativeLabel(now, now)).toBe("just now");
      expect(relativeLabel(now - 1 * 60 * 24 * 60_000, now)).toBe("1 day ago");
      expect(relativeLabel(now - 14 * 60 * 24 * 365 * 60_000, now)).toBe("14 years ago");
    } finally {
      Object.defineProperty(Intl, "RelativeTimeFormat", { value: Original, configurable: true });
    }
  });

  it("translates the fallback into the app language", async () => {
    const Original = Intl.RelativeTimeFormat;
    Object.defineProperty(Intl, "RelativeTimeFormat", { value: undefined, configurable: true });
    try {
      const now = Date.UTC(2026, 8, 22, 12, 0, 0);
      expect(relativeLabel(now - 2 * 60 * 60_000, now, "da")).toBe("for 2 timer siden");
      expect(relativeLabel(now + 1 * 60 * 24 * 60_000, now, "da")).toBe("om 1 dag");
      expect(relativeLabel(now, now, "da")).toBe("lige nu");
    } finally {
      Object.defineProperty(Intl, "RelativeTimeFormat", { value: Original, configurable: true });
    }
  });

  it("formats in the given app language with Intl", async () => {
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);
    expect(relativeLabel(now - 2 * 60 * 60_000, now, "da")).not.toContain("ago");
  });

  it("hides the server section from settingsSections on online web", async () => {
    const origPlatform = Platform.OS;
    Platform.OS = "web";
    try {
      expect(settingsSections(false).some((s) => s.id === "server")).toBe(false);
      expect(settingsSections(true).some((s) => s.id === "server")).toBe(false);
    } finally {
      Platform.OS = origPlatform;
    }
  });
});
