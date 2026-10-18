/**
 * The habit nudge scheduler over a real in-memory store. The notify seam is mocked (native-only expo
 * calls); the plain `scheduleIO` sink is where the habit nudges land.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import i18n from "../i18n";
import { withApp } from "../testutil";
import { useHabitReminderScheduler } from "./useHabitReminderScheduler";

jest.mock("../lib/notify", () => {
  // Created inside the factory (TDZ): read back off the mocked module.
  const permission = { current: "granted" };
  const exactAlarms = { current: "unsupported" };
  const permissionListeners = new Set<() => void>();
  return {
    __esModule: true,
    permission,
    permissionChanged: () => permissionListeners.forEach((listener) => listener()),
    readNotifyPermission: jest.fn(async () => permission.current),
    readExactAlarms: jest.fn(() => exactAlarms.current),
    openExactAlarmSettings: jest.fn(async () => {}),
    onNotifyPermissionChange: jest.fn((listener: () => void) => {
      permissionListeners.add(listener);
      return () => permissionListeners.delete(listener);
    }),
    ensureNotifyPermission: jest.fn(async () => true),
    ensureNotificationSetup: jest.fn(async () => {}),
    scheduleIO: { schedule: jest.fn(), cancel: jest.fn() },
    notificationGeneration: () => 0,
    bookedNotificationIds: jest.fn(async () => []),
  };
});

const seam = () =>
  jest.requireMock("../lib/notify") as {
    permission: { current: string };
    permissionChanged: () => void;
    ensureNotifyPermission: jest.Mock;
    bookedNotificationIds: jest.Mock;
    scheduleIO: { schedule: jest.Mock; cancel: jest.Mock };
  };

/** A daily habit with a nudge at 09:00, so the coming week has nudges to book. */
function seedHabit(store: LocalStore): string {
  store.set("habit", "h1", "name", "Stretch");
  store.set("habit", "h1", "reminder_time", "09:00");
  store.set("habit", "h1", "created_at", 1);
  return "h1";
}

async function mount(store: LocalStore) {
  return renderHook(() => useHabitReminderScheduler(), { wrapper: withApp(store) });
}

beforeEach(() => {
  jest.clearAllMocks();
  seam().permission.current = "granted";
});

describe("gate switched off", () => {
  it.each([
    ["habits", "habits_enabled"],
    ["reminders", "reminders_enabled"],
  ])("takes back every nudge it booked when %s go off", async (_name, field) => {
    const store = new LocalStore("test");
    seedHabit(store);

    await mount(store);
    await waitFor(() => expect(seam().scheduleIO.schedule).toHaveBeenCalled());
    const booked = seam().scheduleIO.schedule.mock.calls.map((c) => c[3] as string);

    await act(() => store.set("preference", PREFERENCES_ID, field, false));

    const cancelled = seam().scheduleIO.cancel.mock.calls.map((c) => c[0] as string);
    expect(cancelled.sort()).toEqual([...booked].sort());
  });
});

describe("after a relaunch", () => {
  it("cancels nudges an earlier launch booked for a habit that is gone", async () => {
    seam().bookedNotificationIds.mockResolvedValue(["habit:deleted:2026-01-01"]);
    const store = new LocalStore("test");
    seedHabit(store);

    await mount(store);

    await waitFor(() =>
      expect(seam().scheduleIO.cancel).toHaveBeenCalledWith("habit:deleted:2026-01-01"),
    );
    expect(seam().bookedNotificationIds).toHaveBeenCalledWith("habit");
  });

  it("cancels them when habits are off by now", async () => {
    seam().bookedNotificationIds.mockResolvedValue(["habit:h1:2026-01-01"]);
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "habits_enabled", false);

    await mount(store);

    await waitFor(() =>
      expect(seam().scheduleIO.cancel).toHaveBeenCalledWith("habit:h1:2026-01-01"),
    );
  });
});

describe("permission", () => {
  it("never prompts from the background: it waits for the permission to be granted", async () => {
    seam().permission.current = "default";
    const store = new LocalStore("test");
    seedHabit(store);

    await mount(store);
    await act(async () => {});
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
    expect(seam().scheduleIO.schedule).not.toHaveBeenCalled();

    seam().permission.current = "granted";
    await act(() => seam().permissionChanged());
    await waitFor(() => expect(seam().scheduleIO.schedule).toHaveBeenCalled());
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
  });
});

describe("notification text", () => {
  it("books every nudge again in the new language when the language changes", async () => {
    seam().bookedNotificationIds.mockResolvedValue([]);
    const store = new LocalStore("test");
    seedHabit(store);

    await mount(store);
    await waitFor(() => expect(seam().scheduleIO.schedule).toHaveBeenCalled());
    const booked = seam().scheduleIO.schedule.mock.calls.map((c) => c[3] as string);
    seam().scheduleIO.schedule.mockClear();

    try {
      await act(async () => {
        await i18n.changeLanguage("da");
      });

      // No fire time moved, yet every nudge is booked again -- replaced under its own id, in Danish.
      await waitFor(() => expect(seam().scheduleIO.schedule).toHaveBeenCalledTimes(booked.length));
      const rebooked = seam().scheduleIO.schedule.mock.calls;
      expect(rebooked.map((c) => c[3] as string).sort()).toEqual([...booked].sort());
      for (const call of rebooked) expect(call[1]).toBe(i18n.t("notify.habitBody", { lng: "da" }));
      expect(seam().scheduleIO.cancel).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        // The mounted scheduler re-renders on the language change.
        await act(async () => {
          await i18n.changeLanguage("en");
        });
      });
    }
  });
});
