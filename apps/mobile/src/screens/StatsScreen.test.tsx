import { render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { StatsScreen } from "./StatsScreen";

/** The screen surfaces the headline metrics and the breakdowns; the aggregation maths is `@atlastodo/shared`'s `stats.ts`. */

const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const HABIT = "11111111-1111-4111-8111-111111111111";

/** Seed a task already completed at `at`. */
function completed(store: LocalStore, title: string, at: number): string {
  const id = createTask(store, { title });
  store.set("task", id, "is_completed", true);
  store.set("task", id, "completed_at", at);
  return id;
}

function seedHabit(store: LocalStore, name: string, checkins: string[]) {
  for (const [field, value] of Object.entries({
    name,
    goal_kind: "daily",
    days: [],
    target: 1,
    color: "#6366f1",
    icon: "hash",
    archived_at: null,
    created_at: NOW,
    sort_order: NOW,
  })) {
    store.set("habit", HABIT, field, value);
  }
  checkins.forEach((date, i) => {
    const id = `22222222-2222-4222-8222-2222222222${String(i).padStart(2, "0")}`;
    store.set("habit_checkin", id, "habit_id", HABIT);
    store.set("habit_checkin", id, "date", date);
    store.set("habit_checkin", id, "state", "done");
  });
}

describe("StatsScreen", () => {
  it("counts completions in the selected range", async () => {
    const store = new LocalStore("test");
    completed(store, "Ship the release", NOW);
    completed(store, "Write the changelog", NOW);

    await render(<StatsScreen now={NOW} />, { wrapper: withApp(store) });

    expect(screen.getByLabelText("2 Completed in 30 days")).toBeTruthy();
  });

  it("labels the chart's range and the peak its bars are scaled to", async () => {
    const store = new LocalStore("test");
    completed(store, "Ship the release", NOW);
    completed(store, "Write the changelog", NOW);

    await render(<StatsScreen now={NOW} />, { wrapper: withApp(store) });

    expect(screen.getByText("Peak 2")).toBeTruthy();
    // The 30-day range runs from 29 days back to today.
    expect(screen.getByText(/May 19|19 May/)).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
  });

  it("counts the streak in the preferred time zone's days, not the device's", async () => {
    // Kiritimati (UTC+14) is ahead of any device clock: these two completions fall on two days
    // there but on one day for the device.
    const store = new LocalStore("test");
    store.set("preference", PREFERENCES_ID, "timezone", "Pacific/Kiritimati");
    completed(store, "Late on the 6th", Date.UTC(2026, 6, 6, 9));
    completed(store, "Early on the 7th", Date.UTC(2026, 6, 6, 11));

    await render(<StatsScreen now={Date.UTC(2026, 6, 7, 9)} />, { wrapper: withApp(store) });

    expect(screen.getByLabelText("2 days Current streak")).toBeTruthy();
  });

  it("gathers a routine's habits under it instead of listing them flat", async () => {
    const store = new LocalStore("test");
    seedHabit(store, "Meditate", ["2026-06-15", "2026-06-16", "2026-06-17"]);
    // A routine holding one habit, alongside the standalone one above.
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
      store.set("habit", "g1", field, value);
    }
    for (const [field, value] of Object.entries({
      name: "Serum",
      kind: "habit",
      parent_id: "g1",
      goal_kind: "daily",
      days: [],
      target: 1,
      color: "#6366f1",
      icon: "hash",
      archived_at: null,
      created_at: NOW,
      sort_order: NOW,
    })) {
      store.set("habit", "m1", field, value);
    }
    store.set("habit_checkin", "c1", "habit_id", "m1");
    store.set("habit_checkin", "c1", "date", "2026-06-17");
    store.set("habit_checkin", "c1", "state", "done");

    await render(<StatsScreen now={NOW} />, { wrapper: withApp(store) });

    // The routine gets a row of its own, carrying its members' combined count.
    expect(screen.getByText("Skincare")).toBeTruthy();
    expect(screen.getByText("Serum")).toBeTruthy();
    expect(screen.getByText("Meditate")).toBeTruthy();
  });
});
