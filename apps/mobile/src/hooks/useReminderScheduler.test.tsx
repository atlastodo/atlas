/**
 * The reminder scheduler's interactive half, over a real in-memory store: a Complete press completes
 * the task through the app's normal toggle path (recurrence roll-forward included) and stamps the
 * reminder fired; a Snooze press re-arms the reminder an hour out; presses on a completed or
 * deleted task, and a duplicated delivery of the same press, are no-ops. The notify seam is mocked
 * (native-only expo calls), and the tests drive it through the listener it hands the seam.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import {
  PREFERENCES_ID,
  allTasks,
  createTask,
  makeInstant,
  softDeleteTask,
  zonedParts,
} from "@atlastodo/shared";
import i18n from "../i18n";
import { withApp } from "../testutil";
import {
  REMINDER_COMPLETE_ACTION,
  REMINDER_SNOOZE_ACTION,
  SNOOZE_INTERVAL_MS,
  type ReminderResponse,
} from "../lib/reminderActions";
import { useReminderScheduler } from "./useReminderScheduler";

jest.mock("../lib/notify", () => {
  // Created inside the factory (the factory runs while this module's imports resolve, before any
  // outer const exists -- TDZ): the listener registry is read back off the mocked module.
  const permission = { current: "granted" };
  const exactAlarms = { current: "unsupported" };
  const permissionListeners = new Set<() => void>();
  return {
    __esModule: true,
    permission,
    exactAlarms,
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
    scheduleIO: { schedule: jest.fn(), cancel: jest.fn() },
    onReminderResponse: jest.fn(() => () => {}),
    launchReminderResponse: jest.fn(() => null),
    clearLaunchReminderResponse: jest.fn(),
    notificationGeneration: () => 0,
    bookedNotificationIds: jest.fn(async () => []),
  };
});

const seam = () =>
  jest.requireMock("../lib/notify") as {
    bookedNotificationIds: jest.Mock;
    permission: { current: string };
    exactAlarms: { current: string };
    permissionChanged: () => void;
    notify: jest.Mock;
    ensureNotifyPermission: jest.Mock;
    reminderScheduleIO: { schedule: jest.Mock; cancel: jest.Mock };
    onReminderResponse: jest.Mock;
    launchReminderResponse: jest.Mock;
    clearLaunchReminderResponse: jest.Mock;
  };

const REMINDER_BODY = "";
const NOW = 1_700_000_000_000;

/** The response listener the mounted scheduler handed to the seam. */
function listener(): (response: ReminderResponse) => void {
  const calls = seam().onReminderResponse.mock.calls;
  return calls[calls.length - 1][0];
}

function seedTask(store: LocalStore, overrides = {}): string {
  return createTask(store, { title: "Task", ...overrides });
}

function seedReminder(store: LocalStore, taskId: string, fields: Record<string, unknown>): string {
  for (const [field, value] of Object.entries(fields)) store.set("reminder", "r1", field, value);
  store.set("reminder", "r1", "task_id", taskId);
  store.set("reminder", "r1", "fired_at", null);
  store.set("reminder", "r1", "created_at", NOW);
  return "r1";
}

async function mount(store: LocalStore) {
  return renderHook(() => useReminderScheduler("user-1"), { wrapper: withApp(store) });
}

// `store.get` resolves an entity to its visible fields bag directly (or null).
const taskFields = (store: LocalStore, id: string) => store.get("task", id) ?? {};
const reminderFields = (store: LocalStore) => store.get("reminder", "r1") ?? {};

beforeEach(() => {
  jest.clearAllMocks();
  seam().permission.current = "granted";
  seam().exactAlarms.current = "unsupported";
});

describe("Complete press", () => {
  it("completes the task through the normal toggle path and stamps the reminder fired", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: NOW - 3_600_000 });

    await mount(store);
    await act(() =>
      listener()({
        reminderId: "r1",
        actionIdentifier: REMINDER_COMPLETE_ACTION,
        notificationDate: 1,
      }),
    );

    expect(taskFields(store, taskId).is_completed).toBe(true);
    expect(taskFields(store, taskId).completed_at).not.toBeNull();
    // The dedupe stamp: the reconciliation must not re-fire the old notification.
    expect(reminderFields(store).fired_at).not.toBeNull();
  });

  it("rolls a recurring task forward to its next occurrence", async () => {
    const store = new LocalStore("test");
    const due = NOW + 86_400_000;
    const taskId = seedTask(store, { due_at: due, recurrence: "FREQ=DAILY;INTERVAL=2" });
    seedReminder(store, taskId, { at: null, offset_min_before_due: 1440 });

    await mount(store);
    await act(() =>
      listener()({
        reminderId: "r1",
        actionIdentifier: REMINDER_COMPLETE_ACTION,
        notificationDate: 1,
      }),
    );

    expect(taskFields(store, taskId).is_completed).toBe(true);
    const spawned = store.list("task").find((e) => e.id !== taskId);
    expect(spawned?.fields.is_completed).toBe(false);
    expect(spawned?.fields.due_at).toBe(due + 2 * 86_400_000);
    // The series' reminder carries onto the spawned instance (a fresh reminder entity).
    expect(spawned).toBeDefined();
    const carried = store
      .list("reminder")
      .find((e) => e.fields.task_id === spawned!.id && e.id !== "r1");
    expect(carried).toBeDefined();
  });
});

describe("Snooze press", () => {
  it("re-arms the reminder one hour out, replacing its due-relative anchor", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    // A due-relative reminder whose fire time has passed.
    seedReminder(store, taskId, { at: null, offset_min_before_due: 60 });

    await mount(store);
    const at = NOW + SNOOZE_INTERVAL_MS;
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await act(async () =>
        listener()({
          reminderId: "r1",
          actionIdentifier: REMINDER_SNOOZE_ACTION,
          notificationDate: 1,
        }),
      );
      expect(reminderFields(store).at).toBe(at);
      expect(reminderFields(store).offset_min_before_due).toBeNull();
      // Re-armed, not swallowed: the fire stamp is cleared so the new time actually fires.
      expect(reminderFields(store).fired_at).toBeNull();
      // And the reconcile books it with the OS at the moved instant -- the future, never the past.
      expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
        "Task",
        REMINDER_BODY,
        at,
        "r1",
      );
    } finally {
      jest.restoreAllMocks();
    }
  });
});

describe("stale presses", () => {
  it("no-ops both actions on a deleted task", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: NOW - 3_600_000 });
    softDeleteTask(store, allTasks(store)[0]!);

    await mount(store);
    await act(() => {
      listener()({
        reminderId: "r1",
        actionIdentifier: REMINDER_COMPLETE_ACTION,
        notificationDate: 1,
      });
      listener()({
        reminderId: "r1",
        actionIdentifier: REMINDER_SNOOZE_ACTION,
        notificationDate: 2,
      });
    });

    expect(taskFields(store, taskId).is_completed).toBe(false);
    expect(reminderFields(store).at).toBe(NOW - 3_600_000);
    expect(seam().reminderScheduleIO.schedule).not.toHaveBeenCalled();
  });
});

describe("delivery paths", () => {
  it("handles the response the app was cold-started from", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: NOW - 3_600_000 });
    seam().launchReminderResponse.mockReturnValueOnce({
      reminderId: "r1",
      actionIdentifier: REMINDER_COMPLETE_ACTION,
      notificationDate: 1,
    });

    await mount(store); // the launch response is consumed at mount, before any listener exists

    expect(taskFields(store, taskId).is_completed).toBe(true);
    expect(seam().clearLaunchReminderResponse).toHaveBeenCalled();
  });

  it("delivers the same press only once, whichever path brings it", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: null, offset_min_before_due: 60 });

    await mount(store);
    // The OS can both cache the press for the launch read and emit it to a listener that
    // subscribed in time; the two deliveries carry the same notification date. The clock advances
    // between them, so a re-handled press would be visible as an even later snooze.
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(NOW);
    const press = {
      reminderId: "r1",
      actionIdentifier: REMINDER_SNOOZE_ACTION,
      notificationDate: 1,
    };
    try {
      await act(async () => listener()(press));
      nowSpy.mockReturnValue(NOW + 1_000);
      await act(async () => listener()(press));
      // Snoozed once, not twice: a second hour is not appended.
      expect(reminderFields(store).at).toBe(NOW + SNOOZE_INTERVAL_MS);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("reminders switched off", () => {
  it("takes back every notification it booked", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);
    await waitFor(() => expect(seam().reminderScheduleIO.schedule).toHaveBeenCalled());

    await act(() => store.set("preference", PREFERENCES_ID, "reminders_enabled", false));

    // Off means nothing left with the OS: the booked banner carries the task's plaintext title.
    expect(seam().reminderScheduleIO.cancel).toHaveBeenCalledWith("r1");
  });
});

describe("after a relaunch", () => {
  it("cancels what an earlier launch booked for a reminder that is gone", async () => {
    // Deleted (or its task completed) on another device while this app was closed.
    seam().bookedNotificationIds.mockResolvedValue(["gone", "r1"]);
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);

    await waitFor(() => expect(seam().reminderScheduleIO.cancel).toHaveBeenCalledWith("gone"));
    expect(seam().bookedNotificationIds).toHaveBeenCalledWith("reminder");
    expect(seam().reminderScheduleIO.cancel).not.toHaveBeenCalledWith("r1");
    expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
      "Task",
      REMINDER_BODY,
      expect.any(Number),
      "r1",
    );
  });

  it("cancels what an earlier launch booked when reminders are off by now", async () => {
    seam().bookedNotificationIds.mockResolvedValue(["left-over"]);
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "reminders_enabled", false);

    await mount(store);

    await waitFor(() => expect(seam().reminderScheduleIO.cancel).toHaveBeenCalledWith("left-over"));
  });
});

describe("permission", () => {
  it("never prompts from the background: it waits for the permission to be granted", async () => {
    seam().permission.current = "default";
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);
    await act(async () => {});
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
    expect(seam().reminderScheduleIO.schedule).not.toHaveBeenCalled();

    // Granted from an explicit prompt (Settings, onboarding, adding a reminder).
    seam().permission.current = "granted";
    await act(() => seam().permissionChanged());
    await waitFor(() => expect(seam().reminderScheduleIO.schedule).toHaveBeenCalled());
    expect(seam().ensureNotifyPermission).not.toHaveBeenCalled();
  });

  it("books every reminder again once exact-alarm access is granted", async () => {
    seam().exactAlarms.current = "denied";
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);
    await waitFor(() => expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledTimes(1));

    // Booked inexact: unmoved, the diff alone would leave it to Doze.
    seam().exactAlarms.current = "granted";
    await act(() => seam().permissionChanged());
    await waitFor(() => expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledTimes(2));
  });
});

describe("timezone preference", () => {
  it("books an all-day morning-of reminder at 09:00 in the preferred zone", async () => {
    const zone = "Pacific/Auckland";
    const day = zonedParts(Date.now() + 3 * 86_400_000, zone);
    const due = makeInstant(day.year, day.month, day.day, 23, 59, 0, zone);
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "timezone", zone);
    const taskId = seedTask(store, { due_at: due });
    seedReminder(store, taskId, { at: null, offset_min_before_due: 0 });

    await mount(store);

    await waitFor(() => expect(seam().reminderScheduleIO.schedule).toHaveBeenCalled());
    expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
      "Task",
      REMINDER_BODY,
      makeInstant(day.year, day.month, day.day, 9, 0, 0, zone),
      "r1",
    );
  });
});

describe("notification text", () => {
  it("uses the first line of task notes as reminder body when present", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store, { notes: "Buy fresh milk\nAnd some bread" });
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);

    await waitFor(() =>
      expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
        "Task",
        "Buy fresh milk",
        expect.any(Number),
        "r1",
      ),
    );
  });

  it("books what is already booked again when the language changes", async () => {
    // A language change moves no fire time, so the banner the OS already holds kept the old text.
    seam().bookedNotificationIds.mockResolvedValue([]);
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);
    await waitFor(() =>
      expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
        "Task",
        REMINDER_BODY,
        expect.any(Number),
        "r1",
      ),
    );
    const at = seam().reminderScheduleIO.schedule.mock.calls[0][2];
    seam().reminderScheduleIO.schedule.mockClear();

    try {
      await act(async () => {
        await i18n.changeLanguage("da");
      });

      await waitFor(() =>
        expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
          "Task",
          i18n.t("notify.reminderBody", { lng: "da" }),
          at,
          "r1",
        ),
      );
      // Replaced under its own id: a cancel could land after the new booking and take it out.
      expect(seam().reminderScheduleIO.cancel).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        // The mounted scheduler re-renders on the language change.
        await act(async () => {
          await i18n.changeLanguage("en");
        });
      });
    }
  });

  it("titles a locked task with a placeholder, never its blank title", async () => {
    const store = new LocalStore("test");
    const taskId = seedTask(store);
    // A title encrypted under a key this device does not have yet.
    store.set("task", taskId, "title", { __enc: 1, iv: "iv", ct: "ct" });
    seedReminder(store, taskId, { at: Date.now() + 3_600_000 });

    await mount(store);

    await waitFor(() =>
      expect(seam().reminderScheduleIO.schedule).toHaveBeenCalledWith(
        i18n.t("notify.lockedTitle"),
        REMINDER_BODY,
        expect.any(Number),
        "r1",
      ),
    );
  });
});
