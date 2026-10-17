/**
 * @jest-environment jsdom
 */
import { Platform } from "react-native";
// The web build: reminders fire from the in-app tick. Set before any render reads it.
(Platform as { OS: string }).OS = "web";

import { act, renderHook, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask, makeInstant } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { useReminderScheduler } from "./useReminderScheduler";

/**
 * The web half of the reminder scheduler: the in-app tick that fires due reminders through the
 * browser's notifications while the tab is open, over a real in-memory store. The notify seam is
 * mocked so the posted notifications and the permission are both under the test's control.
 */
jest.mock("../lib/notify", () => {
  // Created inside the factory (TDZ, see the native suite): read back off the mocked module.
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
    notify: jest.fn(),
    reminderScheduleIO: { schedule: jest.fn(), cancel: jest.fn() },
    onReminderResponse: jest.fn(() => () => {}),
    launchReminderResponse: jest.fn(() => null),
    clearLaunchReminderResponse: jest.fn(),
    notificationGeneration: () => 0,
    bookedNotificationIds: jest.fn(async () => []),
  };
});

const seam = () =>
  jest.requireMock("../lib/notify") as {
    permission: { current: string };
    permissionChanged: () => void;
    notify: jest.Mock;
  };

const REMINDER_BODY = "";

/** A store with its own ids: jsdom's `crypto` has no `randomUUID` for the default. */
function newStore(): LocalStore {
  let n = 0;
  return new LocalStore("test", {
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

function seedReminder(store: LocalStore, taskId: string, at: number): void {
  store.set("reminder", "r1", "task_id", taskId);
  store.set("reminder", "r1", "at", at);
  store.set("reminder", "r1", "created_at", 1);
}

async function mount(store: LocalStore) {
  return await renderHook(() => useReminderScheduler("user-1"), { wrapper: withApp(store) });
}

beforeEach(() => {
  jest.clearAllMocks();
  seam().permission.current = "granted";
});

describe("web delivery", () => {
  it("starts delivering as soon as notification permission is granted", async () => {
    seam().permission.current = "default";
    const store = newStore();
    const taskId = createTask(store, { title: "Task" });
    seedReminder(store, taskId, Date.now() - 60_000);

    await mount(store);
    await act(async () => {});
    expect(seam().notify).not.toHaveBeenCalled();

    // Granted from the browser's site settings or a prompt: no reload, no store change needed.
    seam().permission.current = "granted";
    await act(() => seam().permissionChanged());

    await waitFor(() => expect(seam().notify).toHaveBeenCalledWith("Task", REMINDER_BODY, "r1"));
  });

  it("passes the first line of task notes as the notification body", async () => {
    const store = newStore();
    const taskId = createTask(store, { title: "Task", notes: "Check the oven\nTurn off stove" });
    seedReminder(store, taskId, Date.now() - 60_000);

    await mount(store);

    await waitFor(() => expect(seam().notify).toHaveBeenCalledWith("Task", "Check the oven", "r1"));
  });
});

describe("catching up", () => {
  it("stamps a long-past reminder fired without announcing it again", async () => {
    // The phone's OS notification delivered this an hour ago; nothing there stamps `fired_at`.
    const store = newStore();
    const taskId = createTask(store, { title: "Task" });
    seedReminder(store, taskId, Date.now() - 60 * 60_000);

    await mount(store);

    await waitFor(() => expect(store.get("reminder", "r1")?.fired_at).toEqual(expect.any(Number)));
    expect(seam().notify).not.toHaveBeenCalled();
  });

  it("still announces one that only just came due", async () => {
    const store = newStore();
    const taskId = createTask(store, { title: "Task" });
    seedReminder(store, taskId, Date.now() - 60_000);

    await mount(store);

    await waitFor(() => expect(seam().notify).toHaveBeenCalledWith("Task", REMINDER_BODY, "r1"));
    expect(store.get("reminder", "r1")?.fired_at).toEqual(expect.any(Number));
  });
});

describe("timezone preference", () => {
  it("fires an all-day morning-of reminder at 09:00 in the preferred zone", async () => {
    const zone = "Pacific/Auckland";
    // Five minutes after 09:00 there on the due day, long before the 23:59 due itself.
    const now = makeInstant(2031, 3, 14, 9, 5, 0, zone);
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      const store = newStore();
      store.set("preference", PREFERENCES_ID, "timezone", zone);
      const taskId = createTask(store, {
        title: "Task",
        due_at: makeInstant(2031, 3, 14, 23, 59, 0, zone),
      });
      store.set("reminder", "r1", "task_id", taskId);
      store.set("reminder", "r1", "offset_min_before_due", 0);
      store.set("reminder", "r1", "created_at", 1);

      await mount(store);

      await waitFor(() => expect(seam().notify).toHaveBeenCalledWith("Task", REMINDER_BODY, "r1"));
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("locked tasks", () => {
  it("announces one with a placeholder title, never its blank title", async () => {
    const store = newStore();
    const taskId = createTask(store, { title: "Task" });
    store.set("task", taskId, "title", { __enc: 1, iv: "iv", ct: "ct" });
    seedReminder(store, taskId, Date.now() - 60_000);

    await mount(store);

    await waitFor(() => expect(seam().notify).toHaveBeenCalled());
    expect(seam().notify.mock.calls[0][0]).toBe("Encrypted task");
  });
});
