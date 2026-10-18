import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { HabitGroupDetailScreen } from "./HabitGroupDetailScreen";

// Over a real in-memory `LocalStore`; streak maths is tested in `@atlastodo/shared`.

// 2026-06-17 is a Wednesday.
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const GROUP = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";

function seed() {
  const store = new LocalStore("test");
  const write = (id: string, fields: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(fields)) store.set("habit", id, field, value);
  };
  write(GROUP, {
    name: "Skincare",
    kind: "group",
    parent_id: null,
    color: "#6366f1",
    icon: "folder",
    archived_at: null,
    created_at: NOW,
    sort_order: 1,
  });
  write(MEMBER, {
    name: "Morning",
    kind: "habit",
    parent_id: GROUP,
    goal_kind: "daily",
    days: [],
    target: 1,
    color: "#6366f1",
    icon: "hash",
    archived_at: null,
    created_at: NOW,
    sort_order: 2,
  });
  return store;
}

async function renderGroup(store: LocalStore, onLeave = () => {}) {
  await render(<HabitGroupDetailScreen groupId={GROUP} now={NOW} onLeave={onLeave} />, {
    wrapper: withApp(store),
  });
}

describe("HabitGroupDetailScreen", () => {
  it("takes a habit back out of the group", async () => {
    const store = seed();
    await renderGroup(store);

    await fireEvent.press(screen.getByLabelText("Remove from group"));

    expect(store.get("habit", MEMBER)?.parent_id).toBeNull();
    expect(screen.getByText("No habits in this group yet.")).toBeTruthy();
  });

  it("adds a habit straight into the group", async () => {
    const store = seed();
    await renderGroup(store);

    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Evening");
    await fireEvent.press(screen.getByLabelText("Add"));

    expect(screen.getAllByText("Evening").length).toBe(2);
  });

  it("renames the group from the edit sheet", async () => {
    const store = seed();
    await renderGroup(store);

    await fireEvent.press(screen.getByLabelText("Edit group"));
    const input = screen.getByLabelText("Group name");
    await fireEvent.changeText(input, "Evening care");
    await fireEvent(input, "blur");

    expect(store.get("habit", GROUP)?.name).toBe("Evening care");
  });

  it("names the day the routine broke and the habit that broke it", async () => {
    const store = seed();
    // Kept every day but the 15th, which is the one Morning owed and did not get.
    for (const day of ["2026-06-13", "2026-06-14", "2026-06-16", "2026-06-17"]) {
      store.set("habit_checkin", `c-${day}`, "habit_id", MEMBER);
      store.set("habit_checkin", `c-${day}`, "date", day);
      store.set("habit_checkin", `c-${day}`, "state", "done");
    }
    await renderGroup(store);

    expect(screen.getByText(/Last broken/)).toBeTruthy();
    expect(screen.getByText(/Morning not done/)).toBeTruthy();
  });
});
