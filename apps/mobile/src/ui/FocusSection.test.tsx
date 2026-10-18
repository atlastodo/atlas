import { fireEvent, render as rtlRender, screen } from "@testing-library/react-native";
import type { ReactElement, ReactNode } from "react";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { PREFERENCES_ID } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { FocusProvider } from "../data/FocusProvider";
import { FocusSection } from "./FocusSection";

/**
 * Over a real in-memory store and the real `FocusProvider` (no mocks). The pomodoro maths lives in
 * `@atlastodo/shared` and is tested there; these assert the section's wiring: the feature gate, starting a
 * run on this task, and that logged sessions surface as tracked time.
 */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Write report",
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

/** Render the section inside the real FocusProvider, over the given store. */
function renderSection(store: LocalStore, t: Task) {
  const wrapper = withApp(store);
  return rtlRender(<FocusSection task={t} onUpdate={() => {}} />, {
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

describe("FocusSection", () => {
  it("is hidden when the focus feature is off", async () => {
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "focus_enabled", false);

    await renderSection(store, task());

    expect(screen.queryByText("Focus")).toBeNull();
    expect(screen.queryByLabelText("Start focus")).toBeNull();
  });

  it("starts a run on this task when Start focus is pressed", async () => {
    const store = new LocalStore("test");

    await renderSection(store, task());

    const start = screen.getByLabelText("Start focus");
    expect(start.props.accessibilityState?.disabled).toBeFalsy();

    await fireEvent.press(start);

    // The button now reports the active run and disables itself.
    expect(screen.getByText(/Focusing/)).toBeTruthy();
    expect(screen.getByLabelText("Start focus").props.accessibilityState?.disabled).toBe(true);
  });

  it("shows tracked time from logged focus sessions", async () => {
    const store = new LocalStore("test");
    const id = store.newEntityId();
    store.set("focus_session", id, "task_id", "t1");
    store.set("focus_session", id, "duration_ms", 25 * 60_000);

    await renderSection(store, task());

    expect(screen.getByText("25m")).toBeTruthy();
  });
});
