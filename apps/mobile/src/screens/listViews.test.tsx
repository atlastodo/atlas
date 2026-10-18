import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask, toTask } from "@atlastodo/shared";
import { fakeAuth, laterToday, withApp } from "../testutil";
import { InboxScreen } from "./InboxScreen";
import { AllTasksScreen } from "./AllTasksScreen";
import { CompletedScreen } from "./CompletedScreen";
import { AssignedScreen } from "./AssignedScreen";
import { TodayScreen } from "./TodayScreen";

// The smart-list screens: per-screen decisions (quick-add gating, reopen, session-keyed Assigned) and subtask widening via `taskListSections`.

const DAY = 86_400_000;

function store() {
  return new LocalStore("test");
}
const tasksOf = (s: LocalStore) => s.list("task").map((e) => toTask(e.id, e.fields));
const named = (s: LocalStore, title: string) => tasksOf(s).find((t) => t.title === title);

const meAuth = fakeAuth({
  session: {
    accessToken: "a",
    refreshToken: "r",
    deviceId: "d",
    user: { id: "me", email: "me@example.com", display_name: "Me" },
  },
});

describe("InboxScreen", () => {});

describe("AllTasksScreen", () => {});

describe("CompletedScreen", () => {
  it("unchecking a row reopens it", async () => {
    const s = store();
    createTask(s, { title: "Finished" });
    const t = named(s, "Finished")!;
    s.set("task", t.id, "is_completed", true);
    s.set("task", t.id, "completed_at", Date.now());
    await render(<CompletedScreen />, { wrapper: withApp(s) });

    // In this history view the row's control reopens the task (its label says so).
    await fireEvent.press(screen.getByLabelText("Reopen task"));
    expect(named(s, "Finished")?.is_completed).toBe(false);
  });

  it("has no quick-add: history is not a place to add work", async () => {
    await render(<CompletedScreen />, { wrapper: withApp(store()) });
    expect(screen.queryByLabelText("Add a task")).toBeNull();
  });
});

describe("AssignedScreen", () => {
  it("shows tasks assigned to the signed-in user, and no one else's", async () => {
    const s = store();
    createTask(s, { title: "Mine", assignee_id: "me" });
    createTask(s, { title: "Theirs", assignee_id: "other" });
    createTask(s, { title: "Unassigned" });
    await render(<AssignedScreen />, { wrapper: withApp(s, meAuth) });

    expect(screen.getByText("Mine")).toBeTruthy();
    expect(screen.queryByText("Theirs")).toBeNull();
    expect(screen.queryByText("Unassigned")).toBeNull();
  });

  it("has no quick-add: a new task has no assignee, so it would vanish", async () => {
    await render(<AssignedScreen />, { wrapper: withApp(store(), meAuth) });
    expect(screen.queryByLabelText("Add a task")).toBeNull();
  });

  it("explains its own empty state rather than the inbox's", async () => {
    await render(<AssignedScreen />, { wrapper: withApp(store(), meAuth) });
    expect(screen.getByText("Nothing is assigned to you.")).toBeTruthy();
    expect(screen.queryByText("Your inbox is empty")).toBeNull();
  });
});

describe("subtasks in a smart list", () => {
  it("Today shows a due parent's undated subtasks nested under it", async () => {
    // The headline bug: `todayTasks` needs a due date, so the child never entered the set and the
    // parent rendered childless -- subtasks only ever nested in a project.
    const s = store();
    const parent = createTask(s, { title: "Plan trip", due_at: Date.now() });
    createTask(s, { title: "Book flights", parent_id: parent });
    await render(<TodayScreen />, { wrapper: withApp(s) });

    expect(screen.getByText("Book flights")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Hide subtasks"));
    expect(screen.queryByText("Book flights")).toBeNull();
    expect(screen.getByText("Plan trip")).toBeTruthy();
  });

  it("Today pulls a parent in as context so a due subtask nests under it", async () => {
    const s = store();
    const parent = createTask(s, { title: "Plan trip", due_at: Date.now() + 7 * DAY });
    createTask(s, { title: "Book flights", parent_id: parent, due_at: laterToday() });
    await render(<TodayScreen />, { wrapper: withApp(s) });

    expect(screen.getByText("Book flights")).toBeTruthy();
    // The parent is on screen only as scaffolding, so the group counts the one real match.
    expect(screen.getByText("Plan trip")).toBeTruthy();
    expect(screen.getByLabelText("Today (1)")).toBeTruthy();
  });

  it("Inbox nests a subtask its own membership rule excludes", async () => {
    // `inboxTasks` filters out `parent_id !== null` on purpose -- the subtask comes back via the
    // tree, not the filter, so Inbox must still show it under its parent.
    const s = store();
    const parent = createTask(s, { title: "Plan trip" });
    createTask(s, { title: "Book flights", parent_id: parent });
    await render(<InboxScreen />, { wrapper: withApp(s) });

    expect(screen.getByText("Book flights")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Hide subtasks"));
    expect(screen.queryByText("Book flights")).toBeNull();
  });

  it("leaves completed subtasks off screen but counts them in the progress marker", async () => {
    const s = store();
    const parent = createTask(s, { title: "Plan trip" });
    createTask(s, { title: "Book flights", parent_id: parent });
    const doneId = createTask(s, { title: "Renew passport", parent_id: parent });
    s.set("task", doneId, "is_completed", true);
    await render(<InboxScreen />, { wrapper: withApp(s) });

    expect(screen.getByText("Book flights")).toBeTruthy();
    // Completed work lives in Completed, as it does in a project's Done section...
    expect(screen.queryByText("Renew passport")).toBeNull();
    // ...but the parent still says how much of it is finished.
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("Assigned pulls in a parent assigned to someone else", async () => {
    const s = store();
    const parent = createTask(s, { title: "Plan trip", assignee_id: "other" });
    createTask(s, { title: "Book flights", parent_id: parent, assignee_id: "me" });
    await render(<AssignedScreen />, { wrapper: withApp(s, meAuth) });

    expect(screen.getByText("Book flights")).toBeTruthy();
    expect(screen.getByText("Plan trip")).toBeTruthy();
  });

  it("orders a nested list by the chosen sort, not by sort_order", async () => {
    // The tree re-orders every level, so a smart list's `sortBy` must still apply to nested rows.
    const s = store();
    s.set("preference", PREFERENCES_ID, "list_prefs", { all: { group: "none", sort: "alpha" } });
    const parent = createTask(s, { title: "Beta" });
    createTask(s, { title: "zulu", parent_id: parent });
    createTask(s, { title: "alpha", parent_id: parent });
    createTask(s, { title: "Aardvark" });
    await render(<AllTasksScreen />, { wrapper: withApp(s) });

    // Text query (not a testid): the rendered order of the titles we seeded.
    const order = screen
      .getAllByText(/^(Aardvark|Beta|alpha|zulu)$/)
      .map((node) => node.props.children);
    expect(order).toEqual(["Aardvark", "Beta", "alpha", "zulu"]);
  });

  it("renders a parent and child that grouped into different buckets exactly once each", async () => {
    // Nesting across buckets is impossible; what must hold is that neither row is duplicated and
    // neither bucket is emptied by the widening.
    const s = store();
    s.set("preference", PREFERENCES_ID, "list_prefs", { all: { group: "date", sort: "manual" } });
    const parent = createTask(s, { title: "Plan trip", due_at: Date.now() - 2 * DAY });
    createTask(s, { title: "Book flights", parent_id: parent, due_at: laterToday() });
    await render(<AllTasksScreen />, { wrapper: withApp(s) });

    expect(screen.getAllByText("Book flights")).toHaveLength(1);
    expect(screen.getAllByText("Plan trip")).toHaveLength(1);
    expect(screen.getByLabelText("Overdue (1)")).toBeTruthy();
    expect(screen.getByLabelText("Today (1)")).toBeTruthy();
  });

  it("select-all skips a parent that is only on screen as context", async () => {
    const s = store();
    const parent = createTask(s, { title: "Plan trip", due_at: Date.now() + 7 * DAY });
    createTask(s, { title: "Book flights", parent_id: parent, due_at: laterToday() });
    await render(<TodayScreen />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("Select"));
    await fireEvent.press(screen.getByLabelText("Select all"));
    // One task is *in* Today; the parent is scaffolding and must not be swept into a bulk action.
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
});
