import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { HabitDetailScreen } from "./HabitDetailScreen";

// Over a real in-memory `LocalStore`; the maths is tested in `@atlastodo/shared`.

// 2026-06-17 is a Wednesday.
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const HABIT = "11111111-1111-4111-8111-111111111111";
const GROUP = "33333333-3333-4333-8333-333333333333";

function seed(store: LocalStore, fields: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    name: "Meditate",
    goal_kind: "daily",
    days: [],
    target: 1,
    color: "#6366f1",
    icon: "hash",
    notes: "",
    steps: [],
    archived_at: null,
    created_at: NOW,
    sort_order: NOW,
    ...fields,
  };
  for (const [field, value] of Object.entries(base)) store.set("habit", HABIT, field, value);
  return store;
}

/** A routine holding the seeded habit. */
function seedGroup(store: LocalStore) {
  for (const [field, value] of Object.entries({
    name: "Skincare",
    kind: "group",
    parent_id: null,
    color: "#f43f5e",
    icon: "folder",
    archived_at: null,
    created_at: NOW,
    sort_order: NOW,
  })) {
    store.set("habit", GROUP, field, value);
  }
  store.set("habit", HABIT, "parent_id", GROUP);
  return store;
}

async function renderDetail(
  store: LocalStore,
  onLeave = () => {},
  onOpenGroup?: (groupId: string) => void,
) {
  await render(
    <HabitDetailScreen habitId={HABIT} now={NOW} onOpenGroup={onOpenGroup} onLeave={onLeave} />,
    { wrapper: withApp(store) },
  );
}

describe("HabitDetailScreen", () => {
  it("renames the habit from the edit sheet", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Edit habit"));
    const input = screen.getByLabelText("Habit name");
    await fireEvent.changeText(input, "Read");
    await fireEvent(input, "blur");

    expect(store.get("habit", HABIT)?.name).toBe("Read");
  });

  it("refuses to save an empty name", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Edit habit"));
    const input = screen.getByLabelText("Habit name");
    await fireEvent.changeText(input, "   ");
    await fireEvent(input, "blur");

    expect(store.get("habit", HABIT)?.name).toBe("Meditate");
  });

  it("records a past day from the month calendar", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("2026-06-10: not recorded"));

    expect(screen.getByLabelText("2026-06-10: done")).toBeTruthy();
  });

  it("archives the habit and leaves the screen", async () => {
    const store = seed(new LocalStore("test"));
    let left = false;
    await renderDetail(store, () => {
      left = true;
    });

    await fireEvent.press(screen.getByLabelText("Edit habit"));
    await fireEvent.press(screen.getByLabelText("Archive habit"));

    expect(typeof store.get("habit", HABIT)?.archived_at).toBe("number");
    expect(left).toBe(true);
  });

  it("adds steps in a run, keeping the field ready for the next one", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    const field = () => screen.getByLabelText("Add step");
    await fireEvent.changeText(field(), "cleanse");
    await fireEvent(field(), "submitEditing");
    await fireEvent.changeText(field(), "  moisturize  ");
    await fireEvent(field(), "submitEditing");

    expect(store.get("habit", HABIT)?.steps).toEqual(["cleanse", "moisturize"]);
  });

  it("does not save a step Escape discarded", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    const field = screen.getByLabelText("Add step");
    await fireEvent.changeText(field, "cleanse");
    await fireEvent(field, "keyPress", { nativeEvent: { key: "Escape" } });
    // Cancelling blurs the field, and the blur commits -- the guard is what stops it saving.
    await fireEvent(field, "blur");

    expect(store.get("habit", HABIT)?.steps).toEqual([]);
  });

  it("edits a step in place", async () => {
    const store = seed(new LocalStore("test"), { steps: ["cleanse", "moisturize"] });
    await renderDetail(store);

    const row = screen.getByLabelText("Step 1");
    await fireEvent.changeText(row, "gentle cleanser");
    await fireEvent(row, "blur");

    expect(store.get("habit", HABIT)?.steps).toEqual(["gentle cleanser", "moisturize"]);
  });

  it("snaps an emptied step back rather than blanking it", async () => {
    const store = seed(new LocalStore("test"), { steps: ["cleanse"] });
    await renderDetail(store);

    const row = screen.getByLabelText("Step 1");
    await fireEvent.changeText(row, "   ");
    await fireEvent(row, "blur");

    expect(store.get("habit", HABIT)?.steps).toEqual(["cleanse"]);
  });

  it("removes a step, and the undo puts it back", async () => {
    const store = seed(new LocalStore("test"), { steps: ["cleanse", "moisturize"] });
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Actions for step 1"), {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByLabelText("Delete"));
    expect(store.get("habit", HABIT)?.steps).toEqual(["moisturize"]);

    await fireEvent.press(screen.getByText("Undo"));
    expect(store.get("habit", HABIT)?.steps).toEqual(["cleanse", "moisturize"]);
  });

  it("moves a step up", async () => {
    const store = seed(new LocalStore("test"), { steps: ["cleanse", "moisturize"] });
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Actions for step 2"), {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByLabelText("Move up"));

    expect(store.get("habit", HABIT)?.steps).toEqual(["moisturize", "cleanse"]);
  });

  it("offers no move-up on the first step or move-down on the last", async () => {
    const store = seed(new LocalStore("test"), { steps: ["cleanse", "moisturize"] });
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Actions for step 1"), {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    expect(screen.queryByLabelText("Move up")).toBeNull();
    expect(screen.getByLabelText("Move down")).toBeTruthy();
  });

  it("records the outgoing schedule when the goal changes", async () => {
    // So the days already lived under the old goal keep being judged by it.
    const store = seed(new LocalStore("test"), { days: [1, 4] });
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Weekly"));

    const history = store.get("habit", HABIT)?.schedule_history as unknown[];
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ goal_kind: "daily", days: [1, 4] });
    expect(history[1]).toMatchObject({ goal_kind: "weekly", target: 3 });
  });

  it("folds a run of goal edits on the same day into one recorded change", async () => {
    // The editor writes the kind and the target as separate calls, and each stepper press is
    // another one -- five entries for one decision would be nonsense.
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Weekly"));
    await fireEvent.press(screen.getByLabelText("Increase"));
    await fireEvent.press(screen.getByLabelText("Increase"));

    expect(store.get("habit", HABIT)?.schedule_history).toHaveLength(2);
    expect(store.get("habit", HABIT)?.target).toBe(5);
  });

  it("records no schedule change when only the notes move", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    const input = screen.getByLabelText("Notes");
    await fireEvent.changeText(input, "Ten minutes after coffee");
    await fireEvent(input, "blur");

    expect(store.get("habit", HABIT)?.schedule_history).toBeUndefined();
  });

  it("says when a change does not take effect until the coming week", async () => {
    // A weekly goal changed mid-week applies from the next week start, so someone who sets 3 to 5
    // and still reads "2 of 3 this week" is told why rather than left to file a bug.
    const store = seed(new LocalStore("test"), {
      goal_kind: "weekly",
      target: 5,
      schedule_history: [
        { from: "2026-06-01", goal_kind: "weekly", days: [], target: 3 },
        // 2026-06-17 is a Wednesday, so this lands on Sunday the 21st.
        { from: "2026-06-17", goal_kind: "weekly", days: [], target: 5 },
      ],
    });
    await renderDetail(store);

    expect(screen.getByText(/New goal starts/)).toBeTruthy();
  });

  it("names the routine the habit belongs to, and opens it", async () => {
    const store = seedGroup(seed(new LocalStore("test")));
    const opened: string[] = [];
    await renderDetail(
      store,
      () => {},
      (id) => opened.push(id),
    );

    await fireEvent.press(screen.getByLabelText("Part of Skincare"));

    expect(opened).toEqual([GROUP]);
  });

  it("takes the habit out of its routine from the edit sheet", async () => {
    const store = seedGroup(seed(new LocalStore("test")));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Edit habit"));
    await fireEvent.press(screen.getByLabelText("Remove from group"));

    expect(store.get("habit", HABIT)?.parent_id).toBeNull();
  });

  it("saves notes", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    const input = screen.getByLabelText("Notes");
    await fireEvent.changeText(input, "Ten minutes after coffee");
    await fireEvent(input, "blur");

    expect(store.get("habit", HABIT)?.notes).toBe("Ten minutes after coffee");
  });

  it("changes the goal to a weekly target", async () => {
    const store = seed(new LocalStore("test"));
    await renderDetail(store);

    await fireEvent.press(screen.getByLabelText("Weekly"));

    expect(store.get("habit", HABIT)?.goal_kind).toBe("weekly");
    expect(store.get("habit", HABIT)?.target).toBe(3);
  });
});
