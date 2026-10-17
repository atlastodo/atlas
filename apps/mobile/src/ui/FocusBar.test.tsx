import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask, visibleTasks } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { FocusProvider } from "../data/FocusProvider";
import { FocusBar } from "./FocusBar";
import { FocusSection } from "./FocusSection";

/**
 * The bar cannot start a run, so a `FocusSection` is rendered beside it and pressed. The harness viewport is 750pt,
 * so these run the narrow layout; the drag gesture is not covered.
 */

/** A store holding one real task, plus that task, so both components look at the same entity. */
function storeWithTask(): { store: LocalStore; task: Task } {
  const store = new LocalStore("test");
  const id = createTask(store, { title: "Write report" });
  const task = visibleTasks(store).find((x) => x.id === id)!;
  return { store, task };
}

function renderBar(store: LocalStore, task: Task) {
  const wrapper = withApp(store);
  return rtlRender(
    <FocusProvider>
      <FocusSection task={task} onUpdate={() => {}} />
      <FocusBar onOpen={() => {}} />
    </FocusProvider>,
    { wrapper: wrapper as ({ children }: { children: ReactNode }) => React.JSX.Element },
  );
}

describe("FocusBar", () => {
  it("spends no width on words when the viewport is narrow", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));

    // The phase and the task are dropped from the face -- but not from what a screen reader is told,
    // and not from the full timer the body opens.
    expect(screen.queryByText("Write report")).toBeNull();
    expect(screen.getByLabelText("Focus, 25:00, Write report")).toBeTruthy();
    expect(screen.getByText("25:00")).toBeTruthy();
  });

  it("offers Resume once paused", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));

    await fireEvent.press(screen.getByLabelText("Pause"));

    expect(screen.getByLabelText("Resume")).toBeTruthy();
    expect(screen.queryByLabelText("Pause")).toBeNull();
  });

  it("disappears when the focus feature is switched off mid-run", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));
    expect(screen.getByLabelText("Stop focus")).toBeTruthy();

    await act(() => {
      store.set("preference", PREFERENCES_ID, "focus_enabled", false);
    });

    // A disabled feature disappears everywhere -- it does not linger as an overlay you cannot close.
    expect(screen.queryByLabelText("Stop focus")).toBeNull();
  });

  it("clears the bar when the run is stopped", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));

    await fireEvent.press(screen.getByLabelText("Stop focus"));

    expect(screen.queryByLabelText("Stop focus")).toBeNull();
    expect(screen.queryByLabelText("Pause")).toBeNull();
  });

  it("can be collapsed to the compact mini pill and expanded back", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));

    expect(screen.getByLabelText("Collapse timer")).toBeTruthy();
    expect(screen.getByLabelText("Stop focus")).toBeTruthy();

    // Collapse into mini pill
    await fireEvent.press(screen.getByLabelText("Collapse timer"));

    // Action buttons are hidden in compact mini-pill mode
    expect(screen.queryByLabelText("Stop focus")).toBeNull();
    expect(screen.queryByLabelText("Pause")).toBeNull();
    // Clock is still readable
    expect(screen.getByText("25:00")).toBeTruthy();

    // Expand back
    await fireEvent.press(screen.getByLabelText("Focus, 25:00, Write report, Expand timer"));
    expect(screen.getByLabelText("Stop focus")).toBeTruthy();
    expect(screen.getByLabelText("Pause")).toBeTruthy();
  });

  it("can be docked to the edge and undocked back", async () => {
    const { store, task } = storeWithTask();
    await renderBar(store, task);
    await fireEvent.press(screen.getByLabelText("Start focus"));

    // Collapse to mini pill
    await fireEvent.press(screen.getByLabelText("Collapse timer"));
    const miniPill = screen.getByLabelText("Focus, 25:00, Write report, Expand timer");
    expect(miniPill).toBeTruthy();

    // Dock to screen edge via accessibility action
    await fireEvent(miniPill, "accessibilityAction", { nativeEvent: { actionName: "dock" } });

    // Only the undock tab peeks out, clock numbers are tucked away
    expect(screen.getByLabelText("Focus, 25:00, Write report, Undock from edge")).toBeTruthy();
    expect(screen.queryByText("25:00")).toBeNull();

    // Tapping undock restores the mini-pill
    await fireEvent.press(screen.getByLabelText("Focus, 25:00, Write report, Undock from edge"));
    expect(screen.getByText("25:00")).toBeTruthy();
    expect(screen.queryByLabelText("Focus, 25:00, Write report, Undock from edge")).toBeNull();
  });
});
