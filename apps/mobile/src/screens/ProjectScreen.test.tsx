import { useState, type ReactElement } from "react";
import { Dimensions, View } from "react-native";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { createTask, reorderRank, sectionCreateFields, sortTasks, toTask } from "@atlastodo/shared";
import { fakeAuth, lastCopiedText, withApp } from "../testutil";
import { ProjectScreen, type ProjectScreenProps } from "./ProjectScreen";

/**
 * The screen scopes to its project (shows only its tasks, adds into it) and a reorder persists a new `sort_order`.
 * `react-native-reorderable-list` is mocked in `jest-setup`; its `reorder:<key>` trigger moves the first row to the last position.
 */

function projectStore() {
  const s = new LocalStore("test");
  const id = s.newEntityId();
  s.set("project", id, "name", "Home reno");
  s.set("project", id, "kind", "project");
  return { s, id };
}
const tasksIn = (s: LocalStore, projectId: string) =>
  s
    .list("task")
    .map((e) => toTask(e.id, e.fields))
    .filter((t) => t.project_id === projectId);

function addSection(s: LocalStore, projectId: string, name: string, sortOrder = 0) {
  const id = s.newEntityId();
  const fields = sectionCreateFields({ project_id: projectId, name, sort_order: sortOrder });
  for (const [field, value] of Object.entries(fields)) s.set("section", id, field, value);
  return id;
}

/**
 * The screen plus the header actions it publishes, mounted side by side as the route does through
 * `navigation.setOptions({ headerRight })`: outside the screen but under the same providers, so a
 * Select pressed in the header enters the screen's select mode.
 */
function ProjectWithHeader(props: Omit<ProjectScreenProps, "onHeaderActions">) {
  const [actions, setActions] = useState<ReactElement | null>(null);
  return (
    <>
      <View testID="nav-header">{actions}</View>
      <ProjectScreen {...props} onHeaderActions={setActions} />
    </>
  );
}

/** The phone header's overflow: open the ⋯ menu, then press its item. */
async function pressOverflowItem(name: string) {
  await fireEvent.press(screen.getByLabelText("Project actions"));
  await fireEvent.press(screen.getByRole("menuitem", { name }));
}

/** Resize the window (the jest default is 750 wide, a phone by `useIsWide`'s 768 breakpoint). */
async function setWindowWidth(width: number) {
  const window = { width, height: 900, scale: 2, fontScale: 2 };
  await act(() =>
    (Dimensions as unknown as { set(d: object): void }).set({ window, screen: window }),
  );
}

describe("ProjectScreen", () => {
  it("shows only this project's open tasks", async () => {
    const { s, id } = projectStore();
    createTask(s, { title: "Paint the hall", project_id: id });
    createTask(s, { title: "Loose task" });
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    expect(screen.getByText("Paint the hall")).toBeTruthy();
    expect(screen.queryByText("Loose task")).toBeNull();
  });

  it("adds a task into this project", async () => {
    const { s, id } = projectStore();
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("Add"));
    await fireEvent.changeText(screen.getByLabelText("Add a task"), "Fix the door");
    await fireEvent(screen.getByLabelText("Add a task"), "submitEditing");

    expect(tasksIn(s, id).map((t) => t.title)).toContain("Fix the door");
  });

  it("persists a new sort_order when a task is reordered", async () => {
    const { s, id } = projectStore();
    createTask(s, { title: "First", project_id: id, sort_order: 10 });
    createTask(s, { title: "Second", project_id: id, sort_order: 20 });
    createTask(s, { title: "Third", project_id: id, sort_order: 30 });
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    const ordered = sortTasks(tasksIn(s, id), "manual");
    const expected = reorderRank(ordered, 0, 2)!; // the mock moves index 0 to the last index

    await fireEvent.press(screen.getByLabelText(/^reorder:/));

    const moved = tasksIn(s, id).find((t) => t.id === expected.id);
    expect(moved?.sort_order).toBe(expected.sort_order);
    // A fractional rank re-ranks only the moved row, so it must now sort last.
    const after = sortTasks(tasksIn(s, id), "manual");
    expect(after[after.length - 1]?.id).toBe(expected.id);
  });

  it("nests a subtask under its parent in a flat project, collapsible", async () => {
    const { s, id } = projectStore();
    const parent = createTask(s, { title: "Paint the hall", project_id: id });
    createTask(s, { title: "Buy paint", project_id: id, parent_id: parent });
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    expect(screen.getByText("Buy paint")).toBeTruthy();
    expect(screen.getByText("0/1")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Hide subtasks"));
    expect(screen.queryByText("Buy paint")).toBeNull();
    expect(screen.getByText("Paint the hall")).toBeTruthy();
  });

  it("nests a subtask under its parent inside a section too", async () => {
    const { s, id } = projectStore();
    const sectionId = addSection(s, id, "Walls");
    const parent = createTask(s, {
      title: "Paint the hall",
      project_id: id,
      section_id: sectionId,
    });
    createTask(s, {
      title: "Buy paint",
      project_id: id,
      section_id: sectionId,
      parent_id: parent,
    });
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    // The child renders (nested inside the section) with the parent's progress marker.
    expect(screen.getByText("Buy paint")).toBeTruthy();
    expect(screen.getByText("0/1")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Hide subtasks"));
    expect(screen.queryByText("Buy paint")).toBeNull();
    expect(screen.getByText("Paint the hall")).toBeTruthy();
  });

  it("adds a section from the bottom input", async () => {
    const { s, id } = projectStore();
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await fireEvent.changeText(screen.getByLabelText("Add section"), "Walls");
    await fireEvent(screen.getByLabelText("Add section"), "submitEditing");

    const names = s.list("section").map((e) => e.fields.name);
    expect(names).toContain("Walls");
  });

  it("adds a task into a specific section", async () => {
    const { s, id } = projectStore();
    const sectionId = addSection(s, id, "Walls");
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("Add task to Walls"));
    const input = screen.getByLabelText("Add a task");
    await fireEvent.changeText(input, "Sand the walls");
    await fireEvent(input, "submitEditing");

    const created = tasksIn(s, id).find((t) => t.title === "Sand the walls");
    expect(created?.section_id).toBe(sectionId);
  });

  it("toggles a section's expanded state on the header", async () => {
    const { s, id } = projectStore();
    addSection(s, id, "Walls");
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    const header = screen.getByLabelText("Toggle Walls");
    expect(header.props.accessibilityState.expanded).toBe(true);

    await fireEvent.press(header);
    expect(screen.getByLabelText("Toggle Walls").props.accessibilityState.expanded).toBe(false);
  });

  // --- Shared-project delete vs leave (only an owner may delete; a non-owner can only leave) ---

  function addMember(s: LocalStore, projectId: string, userId: string, role: string) {
    const id = s.newEntityId();
    s.set("project_member", id, "project_id", projectId);
    s.set("project_member", id, "user_id", userId);
    s.set("project_member", id, "role", role);
    s.set("project_member", id, "state", "active");
  }

  /** A shared project where the current user ("me") holds `myRole`, plus one other member. */
  function sharedProjectStore(myRole: "owner" | "editor") {
    const { s, id } = projectStore();
    addMember(s, id, "someone-else", myRole === "owner" ? "editor" : "owner");
    addMember(s, id, "me", myRole);
    return { s, id };
  }

  const meAuth = (api: Partial<{ removeMember: jest.Mock }> = {}) =>
    fakeAuth({
      session: { user: { id: "me", email: "me@x.y", display_name: "Me" } } as never,
      api: api as never,
    });

  it("shows Delete (not Leave) to an owner of a shared project", async () => {
    const { s, id } = sharedProjectStore("owner");
    await render(<ProjectWithHeader projectId={id} />, { wrapper: withApp(s, meAuth()) });

    await pressOverflowItem("Edit project");
    expect(screen.getByLabelText("Delete project")).toBeTruthy();
    expect(screen.queryByLabelText("Leave project")).toBeNull();
  });

  it("shows Leave (not Delete) to a non-owner, and confirming calls removeMember(self)", async () => {
    const { s, id } = sharedProjectStore("editor");
    const removeMember = jest.fn().mockResolvedValue(undefined);
    await render(<ProjectWithHeader projectId={id} />, {
      wrapper: withApp(s, meAuth({ removeMember })),
    });

    await pressOverflowItem("Edit project");
    expect(screen.queryByLabelText("Delete project")).toBeNull();

    // The footer action opens a confirm (leaving isn't locally undoable); confirming leaves.
    await fireEvent.press(screen.getByLabelText("Leave project")); // footer -> confirm dialog
    await fireEvent.press(screen.getByLabelText("Leave project")); // confirm button
    expect(removeMember).toHaveBeenCalledWith(id, "me");
    // Leaving ends in a toast; wait for it rather than letting it land after the test.
    expect(await screen.findByText("Left project")).toBeTruthy();
  });

  it("renames a section from its long-press actions menu", async () => {
    const { s, id } = projectStore();
    const sectionId = addSection(s, id, "Walls");
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    // Long-press the section header opens the actions menu; its Rename item starts the inline edit.
    await fireEvent(screen.getByLabelText("Toggle Walls"), "longPress", {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Rename section Walls");
    await fireEvent.changeText(input, "Interior walls");
    await fireEvent(input, "submitEditing");

    expect(s.get("section", sectionId)?.name).toBe("Interior walls");
  });

  it("abandons a rename on Escape, keeping the old name", async () => {
    const { s, id } = projectStore();
    const sectionId = addSection(s, id, "Walls");
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await fireEvent(screen.getByLabelText("Toggle Walls"), "longPress", {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByRole("menuitem", { name: "Rename" }));

    const input = screen.getByLabelText("Rename section Walls");
    await fireEvent.changeText(input, "Interior walls");
    await fireEvent(input, "keyPress", { nativeEvent: { key: "Escape" } });
    // Escape blurs the field, and blur is also the commit path -- the cancel has to win.
    await fireEvent(input, "blur");

    expect(s.get("section", sectionId)?.name).toBe("Walls");
  });

  it("discards a half-typed section on Escape", async () => {
    const { s, id } = projectStore();
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    const input = screen.getByLabelText("Add section");
    await fireEvent.changeText(input, "Walls");
    await fireEvent(input, "keyPress", { nativeEvent: { key: "Escape" } });

    expect(input.props.value).toBe("");
    expect(s.list("section")).toHaveLength(0);
  });

  it("copies a task with the project and section it lives in", async () => {
    // The copy carries the same origin as a copy from Today (both go through `useTaskClipboard`).
    const { s, id } = projectStore();
    const sectionId = addSection(s, id, "Walls");
    createTask(s, { title: "Paint the hall", project_id: id, section_id: sectionId });
    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s) });

    await fireEvent(screen.getByLabelText("Toggle Walls"), "longPress", {
      nativeEvent: { pageX: 10, pageY: 10 },
    });
    await fireEvent.press(screen.getByRole("menuitem", { name: "Select tasks" }));
    await fireEvent.press(screen.getByLabelText("Copy"));

    await waitFor(() => expect(lastCopiedText()).toBe("- Paint the hall (#Home reno/Walls)"));
  });

  it("selects a task on tap when in select mode and completes with a single bulk toast", async () => {
    const { s, id } = projectStore();
    createTask(s, { title: "Task 1", project_id: id });
    createTask(s, { title: "Task 2", project_id: id });
    await render(<ProjectWithHeader projectId={id} />, { wrapper: withApp(s) });

    // Select, from the header's overflow, enters select mode
    await pressOverflowItem("Select");

    // Tap Task 1 row to select it
    await fireEvent.press(screen.getByText("Task 1"));

    // Tap Task 2 row to select it
    await fireEvent.press(screen.getByText("Task 2"));

    // Selection toolbar count should be 2
    expect(screen.getByText("2 selected")).toBeTruthy();

    // Complete the selected tasks
    await fireEvent.press(screen.getByLabelText("Complete task"));

    // Verify single toast appears and both tasks are marked completed
    await waitFor(() => {
      expect(screen.getByText("Completed 2 tasks")).toBeTruthy();
      expect(tasksIn(s, id).filter((t) => t.is_completed).length).toBe(2);
    });

    // Undo bulk completion restores both
    await fireEvent.press(screen.getByText("Undo"));
    await waitFor(() => {
      expect(tasksIn(s, id).filter((t) => !t.is_completed).length).toBe(2);
    });
  });

  it("renders owner scheduled for deletion banner and allows claiming ownership", async () => {
    const { s, id } = projectStore();
    // Add owner with deletion_scheduled: true
    const ownerMemberId = s.newEntityId();
    s.set("project_member", ownerMemberId, "project_id", id);
    s.set("project_member", ownerMemberId, "user_id", "user-owner");
    s.set("project_member", ownerMemberId, "role", "owner");
    s.set("project_member", ownerMemberId, "state", "active");
    s.set("project_member", ownerMemberId, "deletion_scheduled", true);

    // Add current user as active editor
    const myMemberId = s.newEntityId();
    s.set("project_member", myMemberId, "project_id", id);
    s.set("project_member", myMemberId, "user_id", "user-me");
    s.set("project_member", myMemberId, "role", "editor");
    s.set("project_member", myMemberId, "state", "active");

    const claimMock = jest.fn().mockResolvedValue({});
    const auth = fakeAuth({
      session: {
        accessToken: "t",
        refreshToken: "r",
        deviceId: "d",
        user: { id: "user-me", email: "me@test.com", display_name: "Me", is_admin: false },
      },
      api: { claimProjectOwnership: claimMock } as never,
    });

    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s, auth) });

    expect(screen.getByTestId("owner-deletion-banner")).toBeTruthy();
    expect(screen.getByText("Become owner")).toBeTruthy();

    await fireEvent.press(screen.getByText("Become owner"));

    // Confirm dialog should appear
    expect(
      screen.getByText("Are you sure you want to take over ownership of this project?"),
    ).toBeTruthy();

    // Confirm (modal confirm button)
    await fireEvent.press(screen.getAllByText("Become owner")[2]!);

    await waitFor(() => {
      expect(claimMock).toHaveBeenCalledWith(id);
    });
  });

  it("does not render owner deletion banner when owner is not scheduled for deletion", async () => {
    const { s, id } = projectStore();
    const ownerMemberId = s.newEntityId();
    s.set("project_member", ownerMemberId, "project_id", id);
    s.set("project_member", ownerMemberId, "user_id", "user-owner");
    s.set("project_member", ownerMemberId, "role", "owner");
    s.set("project_member", ownerMemberId, "state", "active");
    s.set("project_member", ownerMemberId, "deletion_scheduled", false);

    const myMemberId = s.newEntityId();
    s.set("project_member", myMemberId, "project_id", id);
    s.set("project_member", myMemberId, "user_id", "user-me");
    s.set("project_member", myMemberId, "role", "editor");
    s.set("project_member", myMemberId, "state", "active");

    const auth = fakeAuth({
      session: {
        accessToken: "t",
        refreshToken: "r",
        deviceId: "d",
        user: { id: "user-me", email: "me@test.com", display_name: "Me", is_admin: false },
      },
    });

    await render(<ProjectScreen projectId={id} />, { wrapper: withApp(s, auth) });

    expect(screen.queryByTestId("owner-deletion-banner")).toBeNull();
  });

  // --- The project's actions live in the nav header (headerRight), not in the screen body ---

  describe("header actions", () => {
    const INLINE = ["Favorite", "Edit project", "Share project", "Select", "List options"];
    const header = () => within(screen.getByTestId("nav-header"));
    // Sharing loads the member list; nothing else here touches the API.
    const listMembers = () => jest.fn(async () => []);
    const shareAuth = (members: jest.Mock) => fakeAuth({ api: { listMembers: members } as never });

    afterEach(() => setWindowWidth(750));

    it("shows every action inline, once, in a wide header", async () => {
      await setWindowWidth(1280);
      const { s, id } = projectStore();
      createTask(s, { title: "Paint the hall", project_id: id });
      await render(<ProjectWithHeader projectId={id} />, { wrapper: withApp(s) });

      for (const name of INLINE) {
        expect(header().getByLabelText(name)).toBeTruthy();
        // Only in the header: the old in-page row and the list's toolbar are gone.
        expect(screen.getAllByLabelText(name)).toHaveLength(1);
      }
      expect(header().getByRole("radio", { name: "List" })).toBeTruthy();
      expect(header().getByRole("radio", { name: "Board" })).toBeTruthy();
      expect(screen.getAllByLabelText("View mode")).toHaveLength(1);
      expect(screen.queryByLabelText("Project actions")).toBeNull();
    });

    it("keeps only List|Board plus an overflow in a phone header", async () => {
      const { s, id } = projectStore();
      createTask(s, { title: "Paint the hall", project_id: id });
      await render(<ProjectWithHeader projectId={id} />, { wrapper: withApp(s) });

      expect(header().getByRole("radio", { name: "Board" })).toBeTruthy();
      expect(screen.getAllByLabelText("View mode")).toHaveLength(1);
      for (const name of INLINE) expect(screen.queryByLabelText(name)).toBeNull();

      await fireEvent.press(header().getByLabelText("Project actions"));
      expect(screen.getAllByRole("menuitem").map((item) => item.props.accessibilityLabel)).toEqual(
        INLINE,
      );
    });

    it("picks the header layout by the pane's width, not the window's", async () => {
      await setWindowWidth(1280);
      const { s, id } = projectStore();
      createTask(s, { title: "Paint the hall", project_id: id });
      await render(<ProjectWithHeader projectId={id} />, { wrapper: withApp(s) });
      const layoutPane = (width: number) =>
        fireEvent(screen.getByTestId("project-screen"), "layout", {
          nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } },
        });

      // A wide window whose sidebar leaves a narrow pane: the overflow layout.
      await layoutPane(560);
      expect(header().getByLabelText("Project actions")).toBeTruthy();
      expect(header().queryByLabelText("Favorite")).toBeNull();
      expect(header().getByText("Board")).toBeTruthy();

      // A phone-narrow pane: the switch drops its text but keeps its accessible names.
      await layoutPane(360);
      expect(header().queryByText("Board")).toBeNull();
      expect(header().getByRole("radio", { name: "Board" })).toBeTruthy();

      await layoutPane(1000);
      expect(header().getByLabelText("Favorite")).toBeTruthy();
      expect(header().queryByLabelText("Project actions")).toBeNull();
    });

    it("runs each list action from the phone overflow", async () => {
      const { s, id } = projectStore();
      createTask(s, { title: "Paint the hall", project_id: id });
      const members = listMembers();
      await render(<ProjectWithHeader projectId={id} />, {
        wrapper: withApp(s, shareAuth(members)),
      });

      await pressOverflowItem("Favorite");
      expect(screen.getByText("Added to favorites")).toBeTruthy();

      await pressOverflowItem("List options");
      await fireEvent.press(screen.getByLabelText("Group: Priority"));
      expect(screen.getByText(/No priority/)).toBeTruthy();
      await fireEvent.press(screen.getAllByLabelText("Close").at(-1)!);

      await pressOverflowItem("Edit project");
      expect(screen.getByLabelText("Delete project")).toBeTruthy();
      await fireEvent.press(screen.getAllByLabelText("Close").at(-1)!);

      await pressOverflowItem("Share project");
      expect(screen.getByText("Share “Home reno”")).toBeTruthy();
      await waitFor(() => expect(members).toHaveBeenCalledWith(id));
      // Let the dialog take in the members it just loaded.
      await act(async () => {});
    });

    it("switches to the board from the header, which drops the list-only actions", async () => {
      await setWindowWidth(1280);
      const { s, id } = projectStore();
      createTask(s, { title: "Paint the hall", project_id: id });
      const onSetMode = jest.fn();
      await render(<ProjectWithHeader projectId={id} onSetMode={onSetMode} />, {
        wrapper: withApp(s),
      });

      await fireEvent.press(header().getByRole("radio", { name: "Board" }));
      expect(onSetMode).toHaveBeenCalledWith("board");
      expect(screen.getByText(/No section \(1\)/)).toBeTruthy();
      expect(header().getByRole("radio", { name: "Board" }).props.accessibilityState.selected).toBe(
        true,
      );
      // The board has no selection toolbar or list arrangement, so no Select or group/sort.
      expect(screen.queryByLabelText("Select")).toBeNull();
      expect(screen.queryByLabelText("List options")).toBeNull();
      for (const name of ["Favorite", "Edit project", "Share project"]) {
        expect(screen.getAllByLabelText(name)).toHaveLength(1);
      }

      await fireEvent.press(header().getByRole("radio", { name: "List" }));
      expect(onSetMode).toHaveBeenLastCalledWith("list");
      expect(header().getByLabelText("Select")).toBeTruthy();
    });

    it("offers the board's actions from the phone overflow", async () => {
      const { s, id } = projectStore();
      const members = listMembers();
      const onSetMode = jest.fn();
      await render(<ProjectWithHeader projectId={id} mode="board" onSetMode={onSetMode} />, {
        wrapper: withApp(s, shareAuth(members)),
      });

      await fireEvent.press(header().getByLabelText("Project actions"));
      expect(screen.getAllByRole("menuitem").map((item) => item.props.accessibilityLabel)).toEqual([
        "Favorite",
        "Edit project",
        "Share project",
      ]);
      await fireEvent.press(screen.getByRole("menuitem", { name: "Favorite" }));
      expect(screen.getByText("Added to favorites")).toBeTruthy();

      await pressOverflowItem("Edit project");
      expect(screen.getByLabelText("Delete project")).toBeTruthy();
      await fireEvent.press(screen.getAllByLabelText("Close").at(-1)!);

      await pressOverflowItem("Share project");
      expect(screen.getByText("Share “Home reno”")).toBeTruthy();
      await waitFor(() => expect(members).toHaveBeenCalledWith(id));
      await act(async () => {});

      await fireEvent.press(header().getByRole("radio", { name: "List" }));
      expect(onSetMode).toHaveBeenCalledWith("list");
    });

    it("clears the header when the screen goes away", async () => {
      const { s, id } = projectStore();
      const onHeaderActions = jest.fn();
      const { unmount } = await render(
        <ProjectScreen projectId={id} onHeaderActions={onHeaderActions} />,
        { wrapper: withApp(s) },
      );
      expect(onHeaderActions).toHaveBeenLastCalledWith(expect.anything());
      await unmount();
      expect(onHeaderActions).toHaveBeenLastCalledWith(null);
    });
  });
});
