/**
 * Quick-add's implicit morning-of reminder, over a real in-memory store. The notify seam is mocked
 * (native-only expo calls) so the permission request it makes is observable.
 */
import { act, fireEvent, renderHook, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { PermissionExplainerHost } from "../ui/PermissionExplainerHost";
import { useQuickAddMorningReminder } from "./useReminders";

jest.mock("../lib/notify", () => ({
  __esModule: true,
  ensureNotifyPermission: jest.fn(async () => true),
  readNotifyPermission: jest.fn(async () => "default"),
  readExactAlarms: jest.fn(() => "unsupported"),
  openExactAlarmSettings: jest.fn(async () => {}),
  onNotifyPermissionChange: jest.fn(() => () => {}),
}));

const ensureNotifyPermission = () =>
  jest.requireMock("../lib/notify").ensureNotifyPermission as jest.Mock;

// Friday 2026-07-17 12:00 UTC; Saturday's all-day due is stored at 23:59 that day.
const NOW = Date.UTC(2026, 6, 17, 12, 0, 0);
const SATURDAY_ALL_DAY = Date.UTC(2026, 6, 18, 23, 59, 0);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useQuickAddMorningReminder", () => {
  it("explains, then asks for notification permission, from the quick-add that creates the reminder", async () => {
    const store = new LocalStore("test");
    const App = withApp(store);
    const { result } = await renderHook(() => useQuickAddMorningReminder(), {
      wrapper: ({ children }) => (
        <App>
          {children}
          <PermissionExplainerHost />
        </App>
      ),
    });

    // The write re-renders the store wrapper, so it belongs inside act.
    await act(() => result.current("t1", SATURDAY_ALL_DAY, "UTC", NOW));
    await act(async () => {});

    expect(store.list("reminder")).toHaveLength(1);
    // The explainer's button is the gesture a browser requires for its permission prompt.
    expect(ensureNotifyPermission()).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Turn on notifications"));
    expect(ensureNotifyPermission()).toHaveBeenCalledTimes(1);
  });

  it("asks nothing when no reminder is created", async () => {
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "reminders_enabled", false);
    const { result } = await renderHook(() => useQuickAddMorningReminder(), {
      wrapper: withApp(store),
    });

    // The write re-renders the store wrapper, so it belongs inside act.
    await act(() => result.current("t1", SATURDAY_ALL_DAY, "UTC", NOW));

    expect(store.list("reminder")).toHaveLength(0);
    expect(ensureNotifyPermission()).not.toHaveBeenCalled();
  });
});
