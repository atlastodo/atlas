/**
 * The focus run's persistence across sessions, over a real in-memory store and the real notify seam.
 * expo-notifications' deep modules are the only doubles (their native module is absent off-device),
 * so the focus alarm's cancel is observable.
 */
import { act, render } from "@testing-library/react-native";
import type { ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LocalStore, type Session } from "@atlastodo/client-core";
import i18n from "../i18n";
import { fakeAuth, withApp } from "../testutil";
import { FOCUS_PHASE_ID, cancelAllAppNotifications } from "../lib/notify";
import { FocusProvider, useFocus, type FocusContextValue } from "./FocusProvider";

jest.mock("expo-notifications/build/scheduleNotificationAsync", () => ({
  scheduleNotificationAsync: jest.fn(async () => {}),
}));
jest.mock("expo-notifications/build/cancelScheduledNotificationAsync", () => ({
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
}));
jest.mock("expo-notifications/build/cancelAllScheduledNotificationsAsync", () => ({
  cancelAllScheduledNotificationsAsync: jest.fn(async () => {}),
}));
jest.mock("expo-notifications/build/dismissAllNotificationsAsync", () => ({
  dismissAllNotificationsAsync: jest.fn(async () => {}),
}));

const scheduleAsync = () =>
  jest.requireMock("expo-notifications/build/scheduleNotificationAsync")
    .scheduleNotificationAsync as jest.Mock;

const cancelScheduled = () =>
  jest.requireMock("expo-notifications/build/cancelScheduledNotificationAsync")
    .cancelScheduledNotificationAsync as jest.Mock;

const sessionFor = (id: string) =>
  ({ user: { id, email: `${id}@example.com`, display_name: id } }) as unknown as Session;

let focus: FocusContextValue | null = null;
function Probe() {
  focus = useFocus();
  return null;
}

/** Mount the provider as `userId`, and let the async restore of a persisted run land. */
async function mountAs(userId: string) {
  const wrapper = withApp(new LocalStore("test"), fakeAuth({ session: sessionFor(userId) }));
  const view = await render(
    <FocusProvider>
      <Probe />
    </FocusProvider>,
    { wrapper: wrapper as ({ children }: { children: ReactNode }) => React.JSX.Element },
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return view;
}

beforeEach(async () => {
  focus = null;
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe("focus run across accounts", () => {
  it("never restores one user's run into another user's session", async () => {
    const a = await mountAs("user-a");
    await act(() => focus!.start(null));
    await a.unmount();

    const b = await mountAs("user-b");
    // B would otherwise resume A's timer and log A's focus time into B's account.
    expect(focus!.active).toBe(false);
    await b.unmount();

    await mountAs("user-a");
    expect(focus!.active).toBe(true);
  });

  it("drops the run and its alarm when the session ends", async () => {
    const a = await mountAs("user-a");
    await act(() => focus!.start(null));

    await act(() => cancelAllAppNotifications());

    expect(focus!.active).toBe(false);
    expect(cancelScheduled()).toHaveBeenCalledWith(FOCUS_PHASE_ID);
    await a.unmount();
    await mountAs("user-a");
    expect(focus!.active).toBe(false);
  });
});

describe("the phase-end alert", () => {
  it("is booked again, for the same instant, in the new language when the language changes", async () => {
    await mountAs("user-a");
    await act(() => focus!.start(null));
    const [first] = scheduleAsync().mock.calls.at(-1)!;
    expect(first.content.title).toBe(i18n.t("focus.alertWorkTitle", { lng: "en" }));
    scheduleAsync().mockClear();

    try {
      await act(async () => {
        await i18n.changeLanguage("da");
      });

      expect(scheduleAsync()).toHaveBeenCalledTimes(1);
      const [again] = scheduleAsync().mock.calls[0]!;
      expect(again.identifier).toBe(FOCUS_PHASE_ID);
      expect(again.content.title).toBe(i18n.t("focus.alertWorkTitle", { lng: "da" }));
      expect(again.content.title).not.toBe(first.content.title);
      expect(again.trigger.date).toBe(first.trigger.date);
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });
});
