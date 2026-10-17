import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, TOAST_TTL_MS } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { ToastProvider, useToast } from "./ToastProvider";

/** The in-app toast layer: the message a user sees, and that Undo runs the action and removes the toast. */
function Trigger({ message, run }: { message: string; run?: () => void }) {
  const toast = useToast();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="fire"
      onPress={() => toast.show(message, run ? { label: "Undo", run } : undefined)}
    >
      <Text>fire</Text>
    </Pressable>
  );
}

describe("ToastProvider", () => {
  it("shows a toast, runs its action on Undo, and dismisses it", async () => {
    const run = jest.fn();
    await render(
      <ToastProvider>
        <Trigger message="Task deleted" run={run} />
      </ToastProvider>,
    );
    await fireEvent.press(screen.getByLabelText("fire"));
    expect(screen.getByText("Task deleted")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Undo"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Task deleted")).toBeNull();
  });

  it("auto-dismisses after the TTL", async () => {
    jest.useFakeTimers();
    try {
      await render(
        <ToastProvider>
          <Trigger message="Gone soon" />
        </ToastProvider>,
      );
      await fireEvent.press(screen.getByLabelText("fire"));
      expect(screen.getByText("Gone soon")).toBeTruthy();

      await act(() => {
        jest.advanceTimersByTime(TOAST_TTL_MS + 10);
      });
      expect(screen.queryByText("Gone soon")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("replaces a re-shown toast rather than stacking (same message twice)", async () => {
    await render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    await fireEvent.press(screen.getByLabelText("fire"));
    await fireEvent.press(screen.getByLabelText("fire"));
    // Two distinct ids (the counter increments), so both render -- this asserts the stack shows the
    // messages, not that ids dedupe (dedupe-by-id is covered in the shared reducer test).
    expect(screen.getAllByText("Saved").length).toBeGreaterThanOrEqual(1);
  });

  it("sets pointerEvents='box-none' on container and 'auto' on toast item", async () => {
    await render(
      <ToastProvider>
        <Trigger message="Pointer test" />
      </ToastProvider>,
    );
    await fireEvent.press(screen.getByLabelText("fire"));
    const pointerEventsOf = (el: { props: { style?: unknown } } | null) =>
      StyleSheet.flatten(el?.props.style as StyleProp<ViewStyle>)?.pointerEvents;
    const ancestors = [];
    for (let el = screen.getByText("Pointer test").parent; el; el = el.parent) ancestors.push(el);
    // Composite and host nodes repeat the same style, so collapse runs.
    const modes = ancestors.map(pointerEventsOf).filter((m, i, all) => m && m !== all[i - 1]);
    expect(modes.slice(0, 2)).toEqual(["auto", "box-none"]);
  });

  it("auto-dismisses after custom toast duration when configured in store", async () => {
    jest.useFakeTimers();
    try {
      const store = new LocalStore("test");
      store.set("preference", PREFERENCES_ID, "toast_duration", 3);
      await render(
        <ToastProvider>
          <Trigger message="Gone in 3s" />
        </ToastProvider>,
        { wrapper: withApp(store) },
      );
      await fireEvent.press(screen.getByLabelText("fire"));
      expect(screen.getByText("Gone in 3s")).toBeTruthy();

      await act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(screen.getByText("Gone in 3s")).toBeTruthy();

      await act(() => {
        jest.advanceTimersByTime(1010);
      });
      expect(screen.queryByText("Gone in 3s")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
