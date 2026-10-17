/**
 * @jest-environment jsdom
 */
import { Platform } from "react-native";
// The web build: the permission hint is browser-only. Set before any render reads it.
(Platform as { OS: string }).OS = "web";

import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { createTask, visibleTasks } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { PermissionExplainerHost } from "./PermissionExplainerHost";
import { ReminderSection } from "./ReminderSection";

// Metro resolves `lib/notify` to its `.web` half for the browser; jest resolves the native one.
jest.mock("../lib/notify", () => jest.requireActual("../lib/notify.web"));

/**
 * The reminder section in a browser, over a real store and the real web notify seam. A fake
 * `Notification` global stands in for the browser's (jsdom has none) and records the prompts.
 */
type Perm = "default" | "granted" | "denied";

class FakeNotification {
  static permission: Perm = "default";
  static requested: Perm = "granted";
  static prompts = 0;
  static requestPermission(): Promise<Perm> {
    FakeNotification.prompts++;
    FakeNotification.permission = FakeNotification.requested;
    return Promise.resolve(FakeNotification.requested);
  }
}

type WithNotification = { Notification?: unknown };
const realNotification = (globalThis as WithNotification).Notification;

beforeEach(() => {
  FakeNotification.permission = "default";
  FakeNotification.requested = "granted";
  FakeNotification.prompts = 0;
  (globalThis as WithNotification).Notification = FakeNotification;
});
afterEach(() => {
  (globalThis as WithNotification).Notification = realNotification;
});

const DAY = 86_400_000;

function taskWithDue(store: LocalStore): Task {
  const id = createTask(store, { title: "Pay rent", due_at: Date.now() + 3 * DAY });
  return visibleTasks(store).find((t) => t.id === id)!;
}

/** A store with its own ids: jsdom's `crypto` has no `randomUUID` for the default. */
function newStore(): LocalStore {
  let n = 0;
  return new LocalStore("test", {
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

function withReminder(store: LocalStore, task: Task) {
  store.set("reminder", "r1", "task_id", task.id);
  store.set("reminder", "r1", "at", Date.now() + DAY);
  store.set("reminder", "r1", "created_at", 1);
}

async function renderSection(store: LocalStore, task: Task) {
  await render(
    <>
      <ReminderSection task={task} />
      <PermissionExplainerHost />
    </>,
    { wrapper: withApp(store) },
  );
  // The permission read is async; let it land.
  await act(async () => {});
}

describe("ReminderSection on the web", () => {
  it("explains, then asks for notification permission, when a reminder is added", async () => {
    const store = newStore();
    await renderSection(store, taskWithDue(store));

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("1 day before"));
    });

    // Reminders default on, so this is the one chance to ask: the explainer first, and the
    // browser's prompt from its button (the gesture the browser needs).
    expect(FakeNotification.prompts).toBe(0);
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Turn on notifications"));
    });
    expect(FakeNotification.prompts).toBe(1);
    expect(screen.queryByText("Get reminders on time")).toBeNull();
  });

  it("offers to enable notifications while they are off, and drops the hint once granted", async () => {
    const store = newStore();
    const task = taskWithDue(store);
    withReminder(store, task);
    await renderSection(store, task);

    expect(screen.getByText(/Notifications are off in this browser/)).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByRole("button", { name: "Enable notifications" }));
    });

    expect(FakeNotification.prompts).toBe(1);
    expect(screen.queryByText(/Notifications are off in this browser/)).toBeNull();
  });

  it("explains a blocked permission, where only the site settings can change it", async () => {
    FakeNotification.permission = "denied";
    const store = newStore();
    const task = taskWithDue(store);
    withReminder(store, task);
    await renderSection(store, task);

    expect(screen.getByText(/blocks notifications/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeTruthy();
  });

  it("stays quiet once notifications are allowed", async () => {
    FakeNotification.permission = "granted";
    const store = newStore();
    const task = taskWithDue(store);
    withReminder(store, task);
    await renderSection(store, task);

    expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull();
  });
});
