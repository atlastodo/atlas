import { useEffect, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { fakeAuth, fakeLocalMode, withApp } from "../testutil";
import { LocalModeContext, type LocalModeValue } from "../auth/localMode";
import { StoreContext } from "../data/StoreProvider";
import { OnboardingProvider, useOnboarding } from "../data/OnboardingContext";
import { OnboardingModal } from "./OnboardingModal";

async function mount(seed: Record<string, unknown> = {}, onFinish?: () => void) {
  const store = new LocalStore("test");
  for (const [field, value] of Object.entries(seed)) {
    store.set("preference", PREFERENCES_ID, field, value);
  }
  const auth = fakeAuth();
  const BaseWrapper = withApp(store, auth);

  await render(
    <BaseWrapper>
      <OnboardingProvider>
        <OnboardingModal onFinish={onFinish} />
      </OnboardingProvider>
    </BaseWrapper>,
  );
  return store;
}

async function mountLocalMode(local: LocalModeValue, localOnly: boolean, auth = fakeAuth()) {
  const store = new LocalStore("test");
  const BaseWrapper = withApp(store, auth, null, { localOnly });
  await render(
    <BaseWrapper>
      <LocalModeContext.Provider value={local}>
        <OnboardingProvider>
          <OnboardingModal />
        </OnboardingProvider>
      </LocalModeContext.Provider>
    </BaseWrapper>,
  );
  return store;
}

const readPref = (store: LocalStore, field: string) =>
  (store.get("preference", PREFERENCES_ID) ?? {})[field];

describe("OnboardingModal in local-only mode", () => {
  it("offers an account right after Welcome", async () => {
    const local = fakeLocalMode();
    await mountLocalMode(local, true);
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Continue"));

    expect(screen.getByText("Sync and collaborate?")).toBeTruthy();
    // The choices move on; there is no plain Continue on this step.
    expect(screen.queryByLabelText("Continue")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Continue on this device"));
    expect(screen.getByText("Make it yours")).toBeTruthy();
    // Back skips the form step: it is only reached by choosing an account.
    await fireEvent.press(screen.getByLabelText("Back"));
    expect(screen.getByText("Sync and collaborate?")).toBeTruthy();
  });

  it("signs in and signs up on a form step inside the wizard, keeping what was typed", async () => {
    const local = fakeLocalMode();
    await mountLocalMode(local, true);
    await fireEvent.press(screen.getByLabelText("Continue"));

    await fireEvent.press(screen.getByLabelText("Create an account"));
    // The wizard's own form: its header and Back, not the standalone sign-in screen.
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText("Back")).toBeTruthy();
    expect(local.openAuth).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");

    await fireEvent.press(screen.getByLabelText("Back"));
    expect(screen.getByText("Sync and collaborate?")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Sign in"));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByLabelText("Email").props.value).toBe("ada@example.com");
  });

  it("records a new account's intent to carry on in the wizard", async () => {
    const local = fakeLocalMode();
    const signup = jest.fn(async () => {});
    await mountLocalMode(local, true, fakeAuth({ signup }));
    await fireEvent.press(screen.getByLabelText("Continue"));
    await fireEvent.press(screen.getByLabelText("Create an account"));

    await fireEvent.changeText(screen.getByLabelText("Name"), "Ada");
    await fireEvent.changeText(screen.getByLabelText("Email"), "ada@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "hunter2hunter");
    await fireEvent.press(screen.getByText("Create account"));

    await waitFor(() =>
      expect(signup).toHaveBeenCalledWith("ada@example.com", "hunter2hunter", "Ada", undefined),
    );
    expect(local.setUpgradeIntent).toHaveBeenCalledWith("signup", { resumeOnboarding: true });
  });

  describe("with an admin's invite link (web)", () => {
    const os = Platform.OS;
    const g = globalThis as { window?: { location?: { search: string } } };
    const hadWindow = "window" in g;
    const previous = g.window;
    beforeEach(() => {
      (Platform as { OS: string }).OS = "web";
      g.window = {
        ...(previous ?? {}),
        location: { search: "?invite=link-code" },
        addEventListener: () => {},
        removeEventListener: () => {},
      } as never;
    });
    // Restored after all: the render's cleanup (after each test) still removes its listeners.
    afterAll(() => {
      (Platform as { OS: string }).OS = os;
      if (hadWindow) g.window = previous;
      else delete g.window;
    });

    it("opens the wizard's signup form with the code filled in", async () => {
      await mountLocalMode(fakeLocalMode(), true);
      expect(screen.getByLabelText("Name")).toBeTruthy();
      expect(screen.getByLabelText("Invite code").props.value).toBe("link-code");
      // Back still reaches the account choices.
      await fireEvent.press(screen.getByLabelText("Back"));
      expect(screen.getByText("Sync and collaborate?")).toBeTruthy();
    });
  });

  it("has no account step once signed in", async () => {
    await mountLocalMode(fakeLocalMode(), false);
    await fireEvent.press(screen.getByLabelText("Continue"));
    expect(screen.getByText("Make it yours")).toBeTruthy();
  });

  it("waits for the new account's recovery phrase before resuming", async () => {
    const local = fakeLocalMode({ resumeOnboarding: true });
    await mountLocalMode(local, false, fakeAuth({ recoveryPhrase: "a b c" }));
    expect(screen.queryByText("Make it yours")).toBeNull();
    expect(local.clearResumeOnboarding).not.toHaveBeenCalled();
  });

  it("resumes after the account step for an account just created from it", async () => {
    const local = fakeLocalMode({ resumeOnboarding: true });
    await mountLocalMode(local, false);
    expect(screen.getByText("Make it yours")).toBeTruthy();
    expect(local.clearResumeOnboarding).toHaveBeenCalled();
  });
});

describe("OnboardingModal", () => {
  it("does not render when onboarding is already completed", async () => {
    await mount({ onboarding_completed: true });
    expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();
  });

  it("can step through all 5 screens and customize settings", async () => {
    const finishMock = jest.fn();
    const store = await mount({}, finishMock);

    // Step 1: Welcome
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Continue"));

    // Step 2: Appearance
    expect(screen.getByText("Make it yours")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Dark"));
    expect(readPref(store, "theme")).toBe("dark");

    await fireEvent.press(screen.getByLabelText("Emerald"));
    expect(readPref(store, "accent")).toBe("emerald");

    await fireEvent.press(screen.getByLabelText("Continue"));

    // Step 3: Preferences
    expect(screen.getByText("Time & Default View")).toBeTruthy();
    expect(screen.getByText("Timezone")).toBeTruthy();
    expect(screen.getByText("Region format")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Inbox"));
    expect(readPref(store, "default_view")).toBe("inbox");

    await fireEvent.press(screen.getByLabelText("Continue"));

    // Step 4: Features
    expect(screen.getByText("Customize your tools")).toBeTruthy();
    await fireEvent(screen.getByLabelText("Habits & Streaks"), "valueChange", false);
    expect(readPref(store, "habits_enabled")).toBe(false);

    await fireEvent.press(screen.getByLabelText("Continue"));

    // Step 5: Ready -- the summary names the choices, never their raw ids.
    expect(screen.getByText("You're all set!")).toBeTruthy();
    expect(screen.getByText(/with Dark theme, Emerald accent, and Inbox/)).toBeTruthy();

    const taskInput = screen.getByLabelText("Add your first task (optional)");
    await fireEvent.changeText(taskInput, "My initial task");

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Start using Atlas Todo"));
    });

    expect(readPref(store, "onboarding_completed")).toBe(true);
    expect(finishMock).toHaveBeenCalled();

    const tasks = store.list("task");
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.fields.title).toBe("My initial task");
  });

  it("allows user to navigate back and forth using Back button", async () => {
    await mount();
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Continue"));
    expect(screen.getByText("Make it yours")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Back"));
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
  });

  it("completes onboarding immediately when user clicks Skip setup", async () => {
    const finishMock = jest.fn();
    const store = await mount({}, finishMock);

    const skipButton = screen.getByLabelText("Skip setup");
    await act(async () => {
      await fireEvent.press(skipButton);
    });

    expect(readPref(store, "onboarding_completed")).toBe(true);
    expect(finishMock).toHaveBeenCalled();
  });

  it("resets to step 1 when replayed", async () => {
    let openFn: () => void = () => {};
    function Harness() {
      const { openOnboarding } = useOnboarding();
      openFn = openOnboarding;
      return <OnboardingModal />;
    }
    const store = new LocalStore("test");
    const auth = fakeAuth();
    const BaseWrapper = withApp(store, auth);
    await render(
      <BaseWrapper>
        <OnboardingProvider>
          <Harness />
        </OnboardingProvider>
      </BaseWrapper>,
    );

    // Initial step 1
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Continue"));
    expect(screen.getByText("Make it yours")).toBeTruthy();

    // User closes onboarding
    await fireEvent.press(screen.getByLabelText("Skip setup"));

    // User triggers replay
    await act(async () => {
      openFn();
    });

    // Must be back at step 1 from the beginning
    expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
  });

  it("does not render when store has existing tasks, and marks onboarding as completed", async () => {
    const store = new LocalStore("test");
    store.set("task", "task-1", "title", "Existing Task");
    const auth = fakeAuth();
    const BaseWrapper = withApp(store, auth);

    await render(
      <BaseWrapper>
        <OnboardingProvider>
          <OnboardingModal />
        </OnboardingProvider>
      </BaseWrapper>,
    );

    expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();
    expect(readPref(store, "onboarding_completed")).toBe(true);
  });

  it("does not open when initialSyncDone is false", async () => {
    const store = new LocalStore("test");

    await render(
      <StoreContext.Provider
        value={{
          store,
          status: "idle",
          version: 0,
          kick: () => {},
          resync: async () => {},
          diagnostics: { lastError: null, lastSyncAt: null, quarantined: [], pending: 0 },
          attachments: null,
          initialSyncDone: false,
        }}
      >
        <OnboardingProvider>
          <OnboardingModal />
        </OnboardingProvider>
      </StoreContext.Provider>,
    );

    expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();
  });

  describe("first run on a device", () => {
    /** A store context whose first successful sync the test flips, as `StoreProvider` would. */
    function SyncedStore({
      store,
      synced,
      children,
    }: {
      store: LocalStore;
      synced: boolean;
      children: ReactNode;
    }) {
      const [version, bump] = useState(0);
      useEffect(() => store.onChange(() => bump((v) => v + 1)), [store]);
      return (
        <StoreContext.Provider
          value={{
            store,
            status: "idle",
            version,
            kick: () => {},
            resync: async () => {},
            diagnostics: {
              lastError: null,
              lastSyncAt: synced ? 1 : null,
              quarantined: [],
              pending: 0,
            },
            attachments: null,
            // The 4 s fallback has fired: settled, but nothing has synced.
            initialSyncDone: true,
          }}
        >
          <OnboardingProvider>{children}</OnboardingProvider>
        </StoreContext.Provider>
      );
    }

    it("waits for a sync to succeed, not for the fallback timer", async () => {
      const store = new LocalStore("test");
      const { rerender } = await render(
        <SyncedStore store={store} synced={false}>
          <OnboardingModal />
        </SyncedStore>,
      );
      expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();

      await rerender(
        <SyncedStore store={store} synced>
          <OnboardingModal />
        </SyncedStore>,
      );
      expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
    });

    it("never opens for an existing account whose data arrives with the first sync", async () => {
      const store = new LocalStore("test");
      const { rerender } = await render(
        <SyncedStore store={store} synced={false}>
          <OnboardingModal />
        </SyncedStore>,
      );
      await act(() => {
        store.set("preference", PREFERENCES_ID, "theme", "dark");
        store.set("task", "t1", "title", "From another device");
      });
      await rerender(
        <SyncedStore store={store} synced>
          <OnboardingModal />
        </SyncedStore>,
      );
      expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();
      // The synced choice survives: nothing was re-onboarded over it.
      expect(readPref(store, "theme")).toBe("dark");
    });

    it("closes by itself once synced data shows the account is already onboarded", async () => {
      const store = new LocalStore("test");
      await render(
        <SyncedStore store={store} synced>
          <OnboardingModal />
        </SyncedStore>,
      );
      expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();

      await act(() => {
        store.set("preference", PREFERENCES_ID, "onboarding_completed", true);
      });
      expect(screen.queryByText("Welcome to Atlas Todo")).toBeNull();
    });

    it("keeps a replay open even though onboarding was completed long ago", async () => {
      const store = new LocalStore("test");
      store.set("preference", PREFERENCES_ID, "onboarding_completed", true);
      let open: () => void = () => {};
      function Replay() {
        open = useOnboarding().openOnboarding;
        return <OnboardingModal />;
      }
      await render(
        <SyncedStore store={store} synced>
          <Replay />
        </SyncedStore>,
      );
      await act(() => open());
      expect(screen.getByText("Welcome to Atlas Todo")).toBeTruthy();
    });
  });
});
