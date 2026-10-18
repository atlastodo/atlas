import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { openPermissionsSheet, PERMISSIONS_SHEET_SEEN_KEY } from "../lib/permissionsSheet";
import { PermissionsSheetHost } from "./PermissionsSheet";

jest.mock("../lib/notify", () => {
  // Created inside the factory (it runs before any outer const exists): read back off the mock.
  const permission = { current: "default" };
  const exactAlarms = { current: "denied" };
  const listeners = new Set<() => void>();
  return {
    __esModule: true,
    permission,
    exactAlarms,
    changed: () => listeners.forEach((listener) => listener()),
    readNotifyPermission: jest.fn(async () => permission.current),
    readExactAlarms: jest.fn(() => exactAlarms.current),
    onNotifyPermissionChange: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ensureNotifyPermission: jest.fn(async () => true),
    openExactAlarmSettings: jest.fn(async () => true),
  };
});

const seam = () =>
  jest.requireMock("../lib/notify") as {
    permission: { current: string };
    exactAlarms: { current: string };
    changed: () => void;
    ensureNotifyPermission: jest.Mock;
    openExactAlarmSettings: jest.Mock;
  };

/** Let the async reads (permission, the seen flag) land and the sheet render. */
const settle = () => act(async () => {});

async function mount(prefs: Record<string, unknown> = { onboarding_completed: true }) {
  const store = new LocalStore("test");
  for (const [field, value] of Object.entries(prefs)) {
    store.set("preference", PREFERENCES_ID, field, value);
  }
  await render(<PermissionsSheetHost />, { wrapper: withApp(store) });
  await settle();
  await settle();
}

beforeEach(async () => {
  await AsyncStorage.clear();
  seam().permission.current = "default";
  seam().exactAlarms.current = "denied";
  seam().ensureNotifyPermission.mockClear();
  seam().openExactAlarmSettings.mockClear();
});

describe("PermissionsSheetHost", () => {
  it("opens by itself once onboarding is done, e.g. after signing in to an existing account", async () => {
    await mount();
    expect(screen.getByText("Get reminders on time")).toBeTruthy();
    expect(screen.getByText("Notifications")).toBeTruthy();
    expect(screen.getByText("Alarms & reminders")).toBeTruthy();
  });

  it("waits while onboarding has not finished", async () => {
    await mount({ onboarding_completed: false });
    expect(screen.queryByText("Get reminders on time")).toBeNull();
  });

  it("stays closed when nothing is missing", async () => {
    seam().permission.current = "granted";
    seam().exactAlarms.current = "granted";
    await mount();
    expect(screen.queryByText("Get reminders on time")).toBeNull();
  });

  it("asks for each permission from its own button and shows it allowed", async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText("Allow"));
    expect(seam().ensureNotifyPermission).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByLabelText("Open settings"));
    expect(seam().openExactAlarmSettings).toHaveBeenCalledTimes(1);

    // Back from the system prompt and settings page: the sheet re-reads where they stand.
    seam().permission.current = "granted";
    seam().exactAlarms.current = "granted";
    await act(() => seam().changed());
    await settle();
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.getByLabelText("Done")).toBeTruthy();
  });

  it("remembers Not now on this device, and Settings can still open it", async () => {
    await mount();
    await fireEvent.press(screen.getByLabelText("Not now"));
    expect(screen.queryByText("Get reminders on time")).toBeNull();
    expect(await AsyncStorage.getItem(PERMISSIONS_SHEET_SEEN_KEY)).toBe("1");

    await act(() => openPermissionsSheet());
    expect(screen.getByText("Get reminders on time")).toBeTruthy();
  });

  it("does not open by itself again once seen", async () => {
    await AsyncStorage.setItem(PERMISSIONS_SHEET_SEEN_KEY, "1");
    await mount();
    expect(screen.queryByText("Get reminders on time")).toBeNull();
  });
});
