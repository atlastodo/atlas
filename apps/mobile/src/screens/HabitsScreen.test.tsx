import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { HabitsScreen } from "./HabitsScreen";

// Over a real in-memory `LocalStore`; schedule/streak maths is tested in `@atlastodo/shared`. `now` is fixed.

// A fixed midday instant so "today" is stable regardless of when the test runs.
// 2026-06-17 is a Wednesday.
const NOW = new Date(2026, 5, 17, 12, 0, 0).getTime();
const TODAY = "2026-06-17";
const YESTERDAY = "2026-06-16";

async function renderScreen(store: LocalStore = new LocalStore("test")) {
  await render(<HabitsScreen now={NOW} />, { wrapper: withApp(store) });
  return store;
}

/** A habit already in the store, for the cases that start from one rather than create it. */
function seedHabit(store: LocalStore, fields: Record<string, unknown> = {}) {
  const id = "11111111-1111-4111-8111-111111111111";
  const base: Record<string, unknown> = {
    name: "Meditate",
    goal_kind: "daily",
    days: [],
    target: 1,
    color: "#6366f1",
    icon: "hash",
    steps: [],
    archived_at: null,
    created_at: NOW,
    sort_order: NOW,
    ...fields,
  };
  for (const [field, value] of Object.entries(base)) store.set("habit", id, field, value);
  return store;
}

/** Open the add sheet, type a name, and submit. */
async function addHabit(name: string, configure?: () => void | Promise<void>) {
  await fireEvent.press(screen.getByText("Add habit"));
  await fireEvent.changeText(screen.getByLabelText("Habit name"), name);
  await configure?.();
  await fireEvent.press(screen.getByLabelText("Add"));
}

async function addGroup(name: string) {
  // By text, so it works from the empty state's action as well as the list header's button.
  await fireEvent.press(screen.getByText("New group"));
  await fireEvent.changeText(screen.getByLabelText("Group name"), name);
  await fireEvent.press(screen.getByLabelText("Add"));
}

async function openGroupMenu(name: string) {
  await fireEvent.press(screen.getByLabelText(`Actions for ${name}`), {
    nativeEvent: { pageX: 10, pageY: 10 },
  });
}

describe("HabitsScreen", () => {
  it("moves the streak when you check in today", async () => {
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Mark Meditate done today"));

    expect(screen.getByText("1 day")).toBeTruthy();
    expect(screen.queryByText("0 days")).toBeNull();
  });

  it("records a past day from the strip -- 'I did that yesterday'", async () => {
    await renderScreen();
    await addHabit("Meditate");

    // Yesterday starts unrecorded; tapping its cell checks it in.
    await fireEvent.press(screen.getByLabelText(`${YESTERDAY}: not recorded`));

    expect(screen.getByLabelText(`${YESTERDAY}: done`)).toBeTruthy();
    // Today is still open, and yesterday's backfill carries the streak.
    expect(screen.getByText("1 day")).toBeTruthy();
  });

  it("filters by what was due yesterday, which is the part the strip cannot tell you", async () => {
    await renderScreen();
    // NOW is a Wednesday, so a Tuesday-only habit was due yesterday and is not due today.
    await addHabit(
      "Tuesdays only",
      async () => await fireEvent.press(screen.getByLabelText("Toggle Tue")),
    );
    expect(screen.queryByText("Tuesdays only")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Yesterday"));

    expect(screen.getByText("Tuesdays only")).toBeTruthy();
  });

  it("comes back to today, with yesterday's backfill kept", async () => {
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Yesterday"));
    await fireEvent.press(screen.getByLabelText("Mark Meditate done yesterday"));
    await fireEvent.press(screen.getByLabelText("Today"));

    // Today's circle is today's again -- stepping back is a visit, not a mode you get stuck in.
    await fireEvent.press(screen.getByLabelText("Mark Meditate done today"));
    expect(screen.getByLabelText(`${TODAY}: done`)).toBeTruthy();
    expect(screen.getByLabelText(`${YESTERDAY}: done`)).toBeTruthy();
    expect(screen.getByText("2 days")).toBeTruthy();
  });

  it("cycles a day done -> skipped -> clear, so a mis-tap is always correctable", async () => {
    await renderScreen();
    await addHabit("Meditate");

    const cell = () => screen.getByLabelText(new RegExp(`^${YESTERDAY}: `));
    await fireEvent.press(cell());
    expect(screen.getByLabelText(`${YESTERDAY}: done`)).toBeTruthy();

    await fireEvent.press(cell());
    expect(screen.getByLabelText(`${YESTERDAY}: skipped`)).toBeTruthy();

    await fireEvent.press(cell());
    // Back to no data -- not left as a false miss.
    expect(screen.getByLabelText(`${YESTERDAY}: not recorded`)).toBeTruthy();
  });

  it("offers an undo for a check-in, and the undo puts it back", async () => {
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Mark Meditate done today"));
    expect(screen.getByLabelText(`${TODAY}: done`)).toBeTruthy();

    await fireEvent.press(screen.getByText("Undo"));

    expect(screen.getByLabelText(`${TODAY}: not recorded`)).toBeTruthy();
    expect(screen.getByText("0 days")).toBeTruthy();
  });

  it("adds a weekly habit whose progress counts toward its target", async () => {
    await renderScreen();
    await addHabit("Exercise", async () => {
      await fireEvent.press(screen.getByLabelText("Weekly"));
      // Defaults to 3 a week; one press of Increase makes it 4.
      await fireEvent.press(screen.getByLabelText("Increase"));
    });

    expect(screen.getByText("Exercise")).toBeTruthy();
    expect(screen.getByText("0 of 4")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Mark Exercise done today"));
    expect(screen.getByText("1 of 4")).toBeTruthy();
    // One of four is not a satisfied week, and the week is still running -- so no streak yet, and
    // crucially it does not read as broken either.
    expect(screen.getByText("0 periods")).toBeTruthy();
  });

  it("reveals a habit's steps from the card, and hides them again", async () => {
    await renderScreen(seedHabit(new LocalStore("test"), { steps: ["cleanse", "moisturize"] }));

    expect(screen.queryByText("1. cleanse")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Show steps for Meditate"));
    expect(screen.getByText("1. cleanse")).toBeTruthy();
    expect(screen.getByText("2. moisturize")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Hide steps for Meditate"));
    expect(screen.queryByText("1. cleanse")).toBeNull();
  });

  it("creates a group and puts a habit in it", async () => {
    await renderScreen();
    await addGroup("Skincare");
    expect(screen.getByText("Skincare")).toBeTruthy();

    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Morning");
    await fireEvent.press(screen.getByLabelText("Add"));

    expect(screen.getByText("Morning")).toBeTruthy();
    // It is a member, so collapsing the group takes it away.
    await fireEvent.press(screen.getByLabelText("Collapse Skincare"));
    expect(screen.queryByText("Morning")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Expand Skincare"));
    expect(screen.getByText("Morning")).toBeTruthy();
  });

  it("reads the routine's progress across its members, and gives it one streak", async () => {
    await renderScreen();
    await addGroup("Skincare");
    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Morning");
    await fireEvent.press(screen.getByLabelText("Add"));
    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Evening");
    await fireEvent.press(screen.getByLabelText("Add"));

    expect(screen.getByText("0 of 2 today")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Mark Morning done today"));
    expect(screen.getByText("1 of 2 today")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Mark Evening done today"));
    expect(screen.getByText("2 of 2 today")).toBeTruthy();
    // The group's own streak, alongside each member's.
    expect(screen.getAllByText("1 day").length).toBe(3);
  });

  it("moves a standalone habit into a group from its menu", async () => {
    await renderScreen();
    await addGroup("Skincare");
    await addHabit("Morning");

    await fireEvent.press(screen.getByLabelText("Actions for Morning"), {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByLabelText("Move to group"));
    await fireEvent.press(screen.getByLabelText("Skincare"));

    // Proved by collapsing the group: only a member goes away.
    await fireEvent.press(screen.getByLabelText("Collapse Skincare"));
    expect(screen.queryByText("Morning")).toBeNull();
  });

  it("offers an undo when a group is deleted", async () => {
    await renderScreen();
    await addGroup("Skincare");

    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Delete"));
    expect(screen.queryByText("Skincare")).toBeNull();

    await fireEvent.press(screen.getByText("Undo"));
    expect(screen.getByText("Skincare")).toBeTruthy();
  });

  it("opens on Today, listing only what is in play", async () => {
    await renderScreen();
    await addHabit("Every day");
    await addHabit("Mondays only", async () => {
      // NOW is a Wednesday.
      await fireEvent.press(screen.getByLabelText("Toggle Mon"));
    });

    expect(screen.getByText("Every day")).toBeTruthy();
    expect(screen.queryByText("Mondays only")).toBeNull();
    // And says where it went, so a short list never reads as lost data.
    expect(screen.getByText("1 habit isn't scheduled today.")).toBeTruthy();
  });

  it("keeps a habit on screen after you tick it, rather than making it vanish", async () => {
    // The trap this scope has to avoid: completing a habit must not remove the row you completed,
    // or the undo goes with it and the progress becomes invisible.
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Mark Meditate done today"));

    expect(screen.getByText("Meditate")).toBeTruthy();
    expect(screen.getByText("1 day")).toBeTruthy();
  });

  it("offers a way back to All when nothing at all is due today", async () => {
    await renderScreen();
    await addHabit(
      "Mondays only",
      async () => await fireEvent.press(screen.getByLabelText("Toggle Mon")),
    );

    // Not "No habits yet" -- there is one, today just does not want it.
    expect(screen.getByText("No habits due today")).toBeTruthy();
    // Creating must stay reachable: the Add / New group buttons live in the list header, which is
    // not rendered when the list is empty.
    expect(screen.getByText("Add habit")).toBeTruthy();
    expect(screen.getByText("New group")).toBeTruthy();

    await fireEvent.press(screen.getByText("Show all habits"));
    expect(screen.getByText("Mondays only")).toBeTruthy();
  });

  it("hides a routine whose members are all off today, and keeps an empty one reachable", async () => {
    await renderScreen();
    await addHabit("Every day");
    await addGroup("Skincare");
    // An empty group stays listed: hiding it would strand a routine with no way to fill it.
    expect(screen.getByText("Skincare")).toBeTruthy();

    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Mondays");
    await fireEvent.press(screen.getByLabelText("Toggle Mon"));
    await fireEvent.press(screen.getByLabelText("Add"));

    // Now it has a member, and that member is not due today.
    expect(screen.queryByText("Skincare")).toBeNull();
    expect(screen.queryByText("Mondays")).toBeNull();
  });

  it("does not check the habit in when its steps are revealed", async () => {
    // The steps are reference only -- reading them is not doing them.
    await renderScreen(seedHabit(new LocalStore("test"), { steps: ["cleanse"] }));

    await fireEvent.press(screen.getByLabelText("Show steps for Meditate"));

    expect(screen.getByText("0 days")).toBeTruthy();
    expect(screen.getByLabelText(`${TODAY}: not recorded`)).toBeTruthy();
  });

  it("tells a missed day from today's open one and from days before the habit existed", async () => {
    // Created three days ago: the two days since are missed, today is still open, and the days
    // before it existed were never due to anyone.
    await renderScreen(
      seedHabit(new LocalStore("test"), { created_at: new Date(2026, 5, 14, 9).getTime() }),
    );

    expect(screen.getByLabelText(`${YESTERDAY}: missed`)).toBeTruthy();
    expect(screen.getByLabelText("2026-06-14: missed")).toBeTruthy();
    expect(screen.getByLabelText(`${TODAY}: not recorded`)).toBeTruthy();
    expect(screen.getByLabelText("2026-06-13: not recorded")).toBeTruthy();
    // The legend says what each circle means.
    expect(screen.getByText("Missed")).toBeTruthy();
    expect(screen.getByText("Not done yet")).toBeTruthy();
  });

  it("drags a whole routine, carrying its members", async () => {
    const store = await renderScreen();
    await addGroup("Skincare");
    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Serum");
    await fireEvent.press(screen.getByLabelText("Add"));
    await addHabit("Read");

    const groupId = store.list("habit").find((h) => h.fields.name === "Skincare")!.id;
    const member = store.list("habit").find((h) => h.fields.name === "Serum")!;
    const read = store.list("habit").find((h) => h.fields.name === "Read")!;
    const memberRankBefore = member.fields.sort_order;

    // The double moves the first row -- the group header -- to the end.
    await fireEvent.press(screen.getByLabelText(`reorder:${groupId}`));

    // The routine ranks past the standalone habit...
    expect(store.get("habit", groupId)!.sort_order).toBeGreaterThan(
      read.fields.sort_order as number,
    );
    // ...on one write: a member's rank is relative to its siblings, so it does not move.
    expect(store.get("habit", member.id)!.sort_order).toBe(memberRankBefore);
    expect(store.get("habit", member.id)!.parent_id).toBe(groupId);
  });

  it("moves a habit inside its routine, past its own neighbour", async () => {
    const store = await renderScreen();
    await addGroup("Skincare");
    for (const name of ["Cleanser", "Serum"]) {
      await openGroupMenu("Skincare");
      await fireEvent.press(screen.getByLabelText("Add habit to group"));
      await fireEvent.changeText(screen.getByLabelText("Habit name"), name);
      await fireEvent.press(screen.getByLabelText("Add"));
    }
    const cleanser = store.list("habit").find((h) => h.fields.name === "Cleanser")!;
    const serum = store.list("habit").find((h) => h.fields.name === "Serum")!;
    expect(serum.fields.sort_order as number).toBeGreaterThan(cleanser.fields.sort_order as number);

    // Second in the routine, so Move up swaps it with the first -- not with the group header.
    await openGroupMenu("Serum");
    await fireEvent.press(screen.getByLabelText("Move up"));

    expect(store.get("habit", serum.id)!.sort_order).toBeLessThan(
      cleanser.fields.sort_order as number,
    );
    // It stays in the routine: moving up is a rank change, not a way out of the group.
    expect(store.get("habit", serum.id)!.parent_id).toBe(
      store.list("habit").find((h) => h.fields.name === "Skincare")!.id,
    );
  });

  it("offers no Move up to the first habit in a routine", async () => {
    await renderScreen();
    await addGroup("Skincare");
    await openGroupMenu("Skincare");
    await fireEvent.press(screen.getByLabelText("Add habit to group"));
    await fireEvent.changeText(screen.getByLabelText("Habit name"), "Cleanser");
    await fireEvent.press(screen.getByLabelText("Add"));

    await openGroupMenu("Cleanser");

    expect(screen.queryByLabelText("Move up")).toBeNull();
    expect(screen.queryByLabelText("Move down")).toBeNull();
  });

  it("records yesterday's check-in from the day toggle", async () => {
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Yesterday"));
    // The card's own circle now means yesterday, and says so.
    await fireEvent.press(screen.getByLabelText("Mark Meditate done yesterday"));

    expect(screen.getByLabelText(`${YESTERDAY}: done`)).toBeTruthy();
    expect(screen.getByText("1 day")).toBeTruthy();
  });

  it("keeps a skipped habit on screen, so the skip stays reversible", async () => {
    await renderScreen();
    await addHabit("Meditate");

    await fireEvent.press(screen.getByLabelText("Mark Meditate done today"));
    await fireEvent.press(screen.getByLabelText(`${TODAY}: done`));

    expect(screen.getByLabelText(`${TODAY}: skipped`)).toBeTruthy();
    expect(screen.getByText("Meditate")).toBeTruthy();
  });

  it("adds a daily habit, which starts with no streak", async () => {
    await renderScreen();
    await addHabit("Meditate");

    expect(screen.getByText("Meditate")).toBeTruthy();
    expect(screen.getByText("0 days")).toBeTruthy();
  });
});
