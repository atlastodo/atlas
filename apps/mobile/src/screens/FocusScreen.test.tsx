import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { FocusProvider } from "../data/FocusProvider";
import { FocusScreen } from "./FocusScreen";

// Over a real in-memory store and the real `FocusProvider`; pomodoro maths is tested in `@atlastodo/shared`.

/** Render the screen inside the real FocusProvider, over the given store. */
function renderScreen(store: LocalStore) {
  const wrapper = withApp(store);
  return rtlRender(<FocusScreen />, {
    wrapper: ({ children }: { children: ReactNode }) => {
      const Inner = wrapper;
      return (
        <Inner>
          <FocusProvider>{children as ReactElement}</FocusProvider>
        </Inner>
      );
    },
  });
}

/** A store whose work phase is one minute, so a test can run a whole phase out cheaply. */
function shortStore(): LocalStore {
  const store = new LocalStore("test");
  store.set("preference", PREFERENCES_ID, "pomodoro_work_min", 1);
  return store;
}

describe("FocusScreen", () => {
  it("starts a run and swaps the primary action for Pause", async () => {
    await renderScreen(new LocalStore("test"));

    await fireEvent.press(screen.getByLabelText("Start focus"));

    expect(screen.getByText("Focus")).toBeTruthy();
    expect(screen.getByLabelText("Pause")).toBeTruthy();
    expect(screen.getByLabelText("Skip phase")).toBeTruthy();
    expect(screen.getByLabelText("Stop focus")).toBeTruthy();
  });

  it("parks on the break when the phase runs out, and waits to be told to start it", async () => {
    jest.useFakeTimers();
    try {
      await renderScreen(shortStore());
      await fireEvent.press(screen.getByLabelText("Start focus"));

      await act(() => {
        jest.advanceTimersByTime(61_000);
      });

      // The break is loaded at full length but has not begun: the clock is parked and the primary
      // action asks for a deliberate tap.
      expect(screen.getByText("Short break")).toBeTruthy();
      expect(screen.getByText("05:00", { includeHiddenElements: true })).toBeTruthy();
      expect(screen.getByLabelText("Start short break")).toBeTruthy();

      // A further minute of wall time must not move a phase nobody has started.
      await act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expect(screen.getByText("05:00", { includeHiddenElements: true })).toBeTruthy();
      expect(screen.getByLabelText("Start short break")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("tracks an untethered run without attributing it to a task", async () => {
    jest.useFakeTimers();
    const store = shortStore();
    try {
      await renderScreen(store);
      // No task picked: the default option is "No task".
      await fireEvent.press(screen.getByLabelText("Start focus"));
      await act(() => {
        jest.advanceTimersByTime(61_000);
      });

      const sessions = store.list("focus_session");
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.fields.task_id).toBe("");
      expect(sessions[0]!.fields.duration_ms as number).toBeGreaterThan(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("starts today at midnight in the preferred time zone", async () => {
    // 01:00 on the 7th in Samoa (UTC-11); its midnight is later than any device clock's.
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 6, 7, 12));
    try {
      const store = new LocalStore("test");
      store.set("preference", PREFERENCES_ID, "timezone", "Pacific/Pago_Pago");
      const session = (startedAt: number) => {
        const id = store.newEntityId();
        store.set("focus_session", id, "task_id", null);
        store.set("focus_session", id, "started_at", startedAt);
        store.set("focus_session", id, "duration_ms", 25 * 60_000);
      };
      session(Date.UTC(2026, 6, 7, 10)); // 23:00 on the 6th there: yesterday
      session(Date.UTC(2026, 6, 7, 11, 30)); // 00:30 on the 7th there: today

      await renderScreen(store);

      expect(screen.getByText(/1 session/)).toBeTruthy();
    } finally {
      now.mockRestore();
    }
  });

  it("opens and closes the distraction-free view over a running timer", async () => {
    await renderScreen(new LocalStore("test"));

    expect(screen.queryByLabelText("Leave focus mode")).toBeNull();

    // With a run under way, so the keep-awake that only mounts for a running timer is exercised too.
    await fireEvent.press(screen.getByLabelText("Start focus"));
    await fireEvent.press(screen.getByLabelText("Focus mode"));

    expect(screen.getByLabelText("Leave focus mode")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Leave focus mode"));
    expect(screen.queryByLabelText("Leave focus mode")).toBeNull();
  });
});
