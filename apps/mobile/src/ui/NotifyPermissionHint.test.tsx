import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { OnboardingProvider } from "../data/OnboardingContext";
import { NotifyPermissionHint } from "./NotifyPermissionHint";
import { OnboardingModal } from "./OnboardingModal";
import { PermissionExplainerHost } from "./PermissionExplainerHost";

jest.mock("../lib/notify", () => {
  // Created inside the factory (it runs before any outer const exists): read back off the mock.
  const permission = { current: "granted" };
  const exactAlarms = { current: "unsupported" };
  return {
    __esModule: true,
    permission,
    exactAlarms,
    readNotifyPermission: jest.fn(async () => permission.current),
    readExactAlarms: jest.fn(() => exactAlarms.current),
    openExactAlarmSettings: jest.fn(async () => {}),
    onNotifyPermissionChange: jest.fn(() => () => {}),
    ensureNotifyPermission: jest.fn(async () => true),
  };
});

const seam = () =>
  jest.requireMock("../lib/notify") as {
    permission: { current: string };
    exactAlarms: { current: string };
    openExactAlarmSettings: jest.Mock;
    ensureNotifyPermission: jest.Mock;
  };

beforeEach(() => {
  seam().permission.current = "granted";
  seam().exactAlarms.current = "unsupported";
  seam().ensureNotifyPermission.mockClear();
});

/** The permission read is async; let it land. */
const settle = () => act(async () => {});

describe("NotifyPermissionHint (native)", () => {
  it("points a phone that denied notifications to the system settings", async () => {
    seam().permission.current = "denied";
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    await render(<NotifyPermissionHint />);
    await settle();

    expect(screen.getByText(/Allow them in your device settings/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
    expect(openSettings).toHaveBeenCalled();
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
    openSettings.mockRestore();
  });

  it("asks again while asking is still possible", async () => {
    seam().permission.current = "default";
    await render(<NotifyPermissionHint />);
    await settle();

    await fireEvent.press(screen.getByRole("button", { name: "Enable notifications" }));
    expect(seam().ensureNotifyPermission).toHaveBeenCalled();
  });

  it("says nothing once notifications are allowed", async () => {
    await render(<NotifyPermissionHint />);
    await settle();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("points a phone without exact-alarm access to Alarms & reminders", async () => {
    seam().exactAlarms.current = "denied";
    await render(<NotifyPermissionHint />);
    await settle();

    expect(screen.getByText(/up to 10 minutes late/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Open settings" }));
    expect(seam().openExactAlarmSettings).toHaveBeenCalled();
  });
});

describe("onboarding's reminders step", () => {
  async function leaveFeaturesStep() {
    seam().permission.current = "default";
    const App = withApp(new LocalStore("test"));
    await render(
      <App>
        <OnboardingProvider>
          <OnboardingModal />
          <PermissionExplainerHost />
        </OnboardingProvider>
      </App>,
    );
    for (let i = 0; i < 3; i++) await fireEvent.press(screen.getByLabelText("Continue"));
    expect(screen.getByText("Customize your tools")).toBeTruthy();
    await settle();
    // The hint sits under the (default-on) Reminders toggle.
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeTruthy();
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByLabelText("Continue"));
    await settle();
  }

  it("on a phone, leaves the asking to the permissions drawer after the wizard", async () => {
    await leaveFeaturesStep();
    expect(screen.queryByText("Get reminders on time")).toBeNull();
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
  });
});
