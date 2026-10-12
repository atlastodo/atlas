import type { ReactElement } from "react";
import { View } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { router, useLocalSearchParams } from "expo-router";
import { LocalStore, type ApiClient } from "@atlas/client-core";
import { fakeAuth, withApp } from "../testutil";
import { SettingsSidebar } from "../ui/SettingsSidebar";
import SettingsRoute from "../../app/(drawer)/settings";

// Settings shows one section at a time, chosen by `?section=`. expo-router is stood in for: `router.setParams` writes the query `useLocalSearchParams` reads.
const mockQuery: { section?: string; tab?: string } = {};
const mockListeners = new Set<() => void>();
jest.mock("expo-router", () => {
  const { useSyncExternalStore } = jest.requireActual<typeof import("react")>("react");
  return {
    __esModule: true,
    router: {
      setParams: jest.fn((params: { section?: string; tab?: string }) => {
        Object.assign(mockQuery, params);
        mockListeners.forEach((l) => l());
      }),
      push: jest.fn(),
    },
    useLocalSearchParams: () => {
      const subscribe = (l: () => void) => {
        mockListeners.add(l);
        return () => mockListeners.delete(l);
      };
      const section = useSyncExternalStore(subscribe, () => mockQuery.section);
      const tab = useSyncExternalStore(subscribe, () => mockQuery.tab);
      return { section, tab };
    },
  };
});

const setParams = router.setParams as jest.Mock;

/** The harness viewport is phone-sized; a desktop window is the wide case. */
function useWideWindow() {
  // On the module object itself (not an import namespace copy), so `useIsWide` sees it.
  jest
    .spyOn(jest.requireActual<typeof import("react-native")>("react-native"), "useWindowDimensions")
    .mockReturnValue({ width: 1280, height: 800, scale: 1, fontScale: 1 });
}

/** The wide shell as the `(drawer)` layout wires it while Settings is open. */
function WideShell({ onBack }: { onBack: () => void }) {
  const { section } = useLocalSearchParams<{ section?: string }>();
  return (
    <View>
      <SettingsSidebar
        brand="Atlas Todo"
        section={section}
        onSelectSection={(id) => router.setParams({ section: id })}
        onBack={onBack}
      />
      <SettingsRoute />
    </View>
  );
}

async function mount(ui: ReactElement, { admin = false } = {}) {
  const auth = fakeAuth({
    session: {
      accessToken: "a",
      refreshToken: "r",
      deviceId: "d",
      user: { id: "u1", email: "mikkel@example.com", display_name: "Mikkel", is_admin: admin },
    },
    // The admin tabs load over REST; empty answers are enough to show which tab is up.
    api: {
      listUsers: jest.fn(async () => []),
      listReports: jest.fn(async () => []),
      getAdminSettings: jest.fn(async () => ({ signup_enabled: true })),
      listSignupInvites: jest.fn(async () => []),
      listAudit: jest.fn(async () => []),
    } as unknown as ApiClient,
  });
  await render(ui, { wrapper: withApp(new LocalStore("test"), auth) });
}

beforeEach(() => {
  delete mockQuery.section;
  delete mockQuery.tab;
  setParams.mockClear();
  jest.restoreAllMocks();
});

describe("Settings navigation, wide", () => {
  it("turns the sidebar into Back plus the settings sections", async () => {
    useWideWindow();
    const onBack = jest.fn();
    await mount(<WideShell onBack={onBack} />);

    // The section list, with the first one selected when no section is in the URL...
    expect(screen.getByRole("button", { name: "Appearance", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account", selected: false })).toBeTruthy();
    // ...and no second, in-page copy of it: each section is listed exactly once.
    expect(screen.getAllByRole("button", { name: "Calendar & time" })).toHaveLength(1);

    await fireEvent.press(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("selects a section through ?section= and renders only that one -- Labels included", async () => {
    useWideWindow();
    await mount(<WideShell onBack={() => {}} />);
    expect(screen.getByLabelText("Dark")).toBeTruthy();

    // Labels was the section scroll-spy skipped on the desktop; it is a plain row now.
    await fireEvent.press(screen.getByRole("button", { name: "Labels" }));
    expect(setParams).toHaveBeenLastCalledWith({ section: "labels" });
    expect(screen.getByLabelText("Add label")).toBeTruthy();
    expect(screen.queryByLabelText("Dark")).toBeNull();
    expect(screen.getByRole("button", { name: "Labels", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Appearance", selected: false })).toBeTruthy();
  });

  it("opens the section a deep link names", async () => {
    useWideWindow();
    mockQuery.section = "account";
    await mount(<WideShell onBack={() => {}} />);
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account", selected: true })).toBeTruthy();
  });
});

describe("Settings navigation, phone", () => {
  it("switches sections from the pill bar", async () => {
    await mount(<SettingsRoute />);
    expect(screen.getByRole("button", { name: "Appearance", selected: true })).toBeTruthy();
    expect(screen.getByLabelText("Dark")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Account" }));
    expect(setParams).toHaveBeenLastCalledWith({ section: "account" });
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.queryByLabelText("Dark")).toBeNull();
    expect(screen.getByRole("button", { name: "Account", selected: true })).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Labels" }));
    expect(screen.getByLabelText("Add label")).toBeTruthy();
    expect(screen.queryByText("Sign out")).toBeNull();
  });

  it("falls back to the first section for an unknown one", async () => {
    mockQuery.section = "no-such-section";
    await mount(<SettingsRoute />);
    expect(screen.getByRole("button", { name: "Appearance", selected: true })).toBeTruthy();
    expect(screen.getByLabelText("Dark")).toBeTruthy();
  });

  it("does not open Admin for a non-admin, even by URL", async () => {
    // The section list only offers Admin to an administrator; a typed-in link is just unknown.
    mockQuery.section = "admin";
    await mount(<SettingsRoute />);
    expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("button", { name: "Appearance", selected: true })).toBeTruthy();
  });
});

describe("Settings navigation, Admin", () => {
  it("shows the admin tabs in place, opening on the account list", async () => {
    mockQuery.section = "admin";
    await mount(<SettingsRoute />, { admin: true });
    expect(screen.getByRole("button", { name: "Admin", selected: true })).toBeTruthy();
    expect(await screen.findByLabelText("Search users")).toBeTruthy();

    await fireEvent.press(screen.getByText("Error reports"));
    expect(setParams).toHaveBeenLastCalledWith({ tab: "reports" });
    expect(screen.queryByLabelText("Search users")).toBeNull();
  });

  it("opens the tab a deep link names", async () => {
    mockQuery.section = "admin";
    mockQuery.tab = "settings";
    await mount(<SettingsRoute />, { admin: true });
    expect(await screen.findByText("Allow new signups")).toBeTruthy();
    expect(screen.queryByLabelText("Search users")).toBeNull();
  });

  it("drops the admin tab when leaving for another section", async () => {
    mockQuery.section = "admin";
    mockQuery.tab = "reports";
    await mount(<SettingsRoute />, { admin: true });
    await fireEvent.press(screen.getByRole("button", { name: "Account" }));
    expect(setParams).toHaveBeenLastCalledWith({ section: "account", tab: undefined });
  });
});
