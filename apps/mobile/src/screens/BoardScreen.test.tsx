import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, columnCards, createTask, toSection, toTask } from "@atlastodo/shared";
import { lastCopiedText, withApp } from "../testutil";
import { useCursor, type CursorContextValue } from "../data/CursorProvider";
import { haptics } from "../lib/haptics";
import { BoardScreen } from "./BoardScreen";

/**
 * Board columns render from sections; move-to-column and within-column reorder persist `section_id` + `sort_order`.
 * `react-native-reorderable-list` is mocked in jest-setup.
 */

function boardStore() {
  const s = new LocalStore("test");
  const projectId = s.newEntityId();
  s.set("project", projectId, "name", "Home reno");
  s.set("project", projectId, "kind", "project");
  return { s, projectId };
}
function addSection(s: LocalStore, projectId: string, name: string, sortOrder: number) {
  const id = s.newEntityId();
  s.set("section", id, "project_id", projectId);
  s.set("section", id, "name", name);
  s.set("section", id, "sort_order", sortOrder);
  return id;
}
const task = (s: LocalStore, id: string) => {
  const e = s.get("task", id);
  return e ? toTask(id, e) : undefined;
};
const projectTasks = (s: LocalStore, projectId: string) =>
  s
    .list("task")
    .map((e) => toTask(e.id, e.fields))
    .filter((t) => t.project_id === projectId);

describe("BoardScreen", () => {
  it("renders a labelled card with its label chip instead of crashing", async () => {
    // The cards were handed quick-add's by-name label creator as their id resolver, so any card
    // with a label threw while rendering.
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    const labelId = s.newEntityId();
    s.set("label", labelId, "name", "urgent");
    s.set("label", labelId, "color", "#ef4444");
    createTask(s, {
      title: "Paint",
      project_id: projectId,
      section_id: todo,
      label_ids: [labelId],
    });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    expect(screen.getByText("Paint")).toBeTruthy();
    expect(screen.getByText("urgent")).toBeTruthy();
    // Rendering a card never creates labels.
    expect(s.list("label")).toHaveLength(1);
  });

  it("nests subtasks inside their parent's card instead of showing them as cards", async () => {
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    const parent = createTask(s, { title: "Paint", project_id: projectId, section_id: todo });
    createTask(s, {
      title: "Tape edges",
      project_id: projectId,
      section_id: todo,
      parent_id: parent,
    });
    const sub = createTask(s, {
      title: "Buy rollers",
      project_id: projectId,
      section_id: todo,
      parent_id: parent,
    });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    // One card: the column counts the parent only, and the subtasks are rows inside its card.
    expect(screen.getByText(/To do \(1\)/)).toBeTruthy();
    expect(screen.getByText("Tape edges")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Hide subtasks"));
    expect(screen.queryByText("Tape edges")).toBeNull();
    await fireEvent.press(screen.getByLabelText("Show subtasks"));

    // Completing a nested subtask completes that subtask, not its parent.
    const row = screen.getByLabelText("Buy rollers");
    await fireEvent.press(within(row).getByLabelText("Complete task"));
    expect(task(s, sub)?.is_completed).toBe(true);
    expect(task(s, parent)?.is_completed).toBe(false);
  });

  it("creates a section from the add-column field", async () => {
    const { s, projectId } = boardStore();
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    await fireEvent.changeText(screen.getByLabelText("Section name"), "Backlog");
    await fireEvent(screen.getByLabelText("Section name"), "submitEditing");

    const names = s.list("section").map((e) => toSection(e.id, e.fields).name);
    expect(names).toContain("Backlog");
  });

  it("reorders cards within a column via the reorder list with light haptic feedback", async () => {
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    const id1 = createTask(s, {
      title: "First",
      project_id: projectId,
      section_id: todo,
      sort_order: 10,
    });
    createTask(s, { title: "Second", project_id: projectId, section_id: todo, sort_order: 20 });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    const impactSpy = jest.spyOn(haptics, "impact");
    await fireEvent.press(screen.getByLabelText(`reorder:${id1}`));

    const reordered = task(s, id1);
    expect(reordered?.sort_order).toBeGreaterThan(10);
    expect(impactSpy).toHaveBeenCalledWith("light");
    impactSpy.mockRestore();
  });

  it("renames a section from its column actions menu", async () => {
    const { s, projectId } = boardStore();
    addSection(s, projectId, "To do", 10);
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("To do section actions"));
    await fireEvent.press(screen.getByText("Rename"));
    const input = screen.getByLabelText("Rename section To do");
    await fireEvent.changeText(input, "In progress");
    await fireEvent(input, "submitEditing");

    const names = s.list("section").map((e) => toSection(e.id, e.fields).name);
    expect(names).toContain("In progress");
    expect(names).not.toContain("To do");
  });

  it("deletes a section from its menu with an undo toast that restores it", async () => {
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("To do section actions"));
    await fireEvent.press(screen.getByText("Delete"));
    // Soft-deleted: it drops out of the live section list.
    const visible = () =>
      s
        .list("section")
        .map((e) => toSection(e.id, e.fields))
        .filter((sec) => sec.deleted_at == null && sec.id === todo);
    expect(visible()).toHaveLength(0);

    // Undo restores it.
    await fireEvent.press(screen.getByText("Undo"));
    expect(visible()).toHaveLength(1);
  });

  it("shows the Done column only when the project's show-completed toggle is on", async () => {
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    const id = createTask(s, { title: "Painted", project_id: projectId, section_id: todo });
    s.set("task", id, "is_completed", true);
    s.set("task", id, "completed_at", Date.now());

    // Off by default: no Done column.
    const first = await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });
    expect(screen.queryByText(/Done \(/)).toBeNull();
    await first.unmount();

    // Turn the synced per-project toggle on -> the Done column header shows the count (collapsed).
    s.set("preference", PREFERENCES_ID, "project_show_done", { [projectId]: true });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });
    expect(screen.getByText(/Done \(1\)/)).toBeTruthy();
  });

  it("appends a created task to the bottom of the section with a distinct rank", async () => {
    // Existing tasks share the default sort_order 0 (the tied-rank case). A new task must land at the
    // bottom with a rank greater than every sibling, not tie at 0.
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    createTask(s, { title: "First", project_id: projectId, section_id: todo });
    createTask(s, { title: "Second", project_id: projectId, section_id: todo });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    await fireEvent.changeText(screen.getByLabelText("Add task to To do"), "Third");
    await fireEvent(screen.getByLabelText("Add task to To do"), "submitEditing");

    const ordered = columnCards(projectTasks(s, projectId), todo);
    // It is last in the column, and its rank is strictly greater than the previous last card's.
    expect(ordered.at(-1)?.title).toBe("Third");
    expect(ordered.at(-1)!.sort_order).toBeGreaterThan(ordered.at(-2)!.sort_order);
  });

  it("lets the keyboard cursor walk and complete the board's cards", async () => {
    // The board registered nothing, so the cursor kept acting on a list hidden behind it.
    let cursor: CursorContextValue | undefined;
    function Probe() {
      cursor = useCursor();
      return null;
    }
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    createTask(s, { title: "Paint", project_id: projectId, section_id: todo });
    await render(
      <>
        <Probe />
        <BoardScreen projectId={projectId} />
      </>,
      { wrapper: withApp(s) },
    );
    await act(() => cursor!.next());
    await act(() => cursor!.completeCursor());
    expect(projectTasks(s, projectId)[0]!.is_completed).toBe(true);
  });

  describe("card actions menu", () => {
    async function boardWithCard() {
      const { s, projectId } = boardStore();
      const todo = addSection(s, projectId, "To do", 10);
      createTask(s, { title: "Sand the floor", project_id: projectId, section_id: todo });
      await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });
      return { s, projectId };
    }
    const openMenu = () =>
      fireEvent(screen.getByLabelText("Sand the floor"), "longPress", {
        nativeEvent: { pageX: 20, pageY: 30 },
      });

    it("copies a card with the project and section it lives in", async () => {
      await boardWithCard();
      await openMenu();
      await fireEvent.press(screen.getByRole("menuitem", { name: "Copy" }));

      await waitFor(() => expect(lastCopiedText()).toBe("- Sand the floor (#Home reno/To do)"));
    });

    it("completes a card from the menu", async () => {
      const { s, projectId } = await boardWithCard();
      await openMenu();
      await fireEvent.press(screen.getByRole("menuitem", { name: "Complete task" }));

      expect(projectTasks(s, projectId)[0]!.is_completed).toBe(true);
    });

    it("selects the card from the menu, and a press then toggles it", async () => {
      await boardWithCard();
      await openMenu();
      await fireEvent.press(screen.getByRole("menuitem", { name: "Select" }));
      expect(screen.getByText("1 selected")).toBeTruthy();
      expect(screen.getByLabelText("Sand the floor").props.accessibilityState?.selected).toBe(true);

      await fireEvent.press(screen.getByLabelText("Sand the floor"));
      expect(screen.getByText("0 selected")).toBeTruthy();
    });
  });

  describe("moving a card from its actions menu", () => {
    async function boardWithSubtasks() {
      const { s, projectId } = boardStore();
      const todo = addSection(s, projectId, "To do", 10);
      const doing = addSection(s, projectId, "Doing", 20);
      const parent = createTask(s, { title: "Paint", project_id: projectId, section_id: todo });
      const sub = createTask(s, {
        title: "Tape edges",
        project_id: projectId,
        section_id: todo,
        parent_id: parent,
      });
      await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });
      return { s, todo, doing, parent, sub };
    }
    const startMove = async () => {
      await fireEvent(screen.getByLabelText("Paint"), "longPress", {
        nativeEvent: { pageX: 20, pageY: 30 },
      });
      await fireEvent.press(screen.getByRole("menuitem", { name: "Move to section" }));
    };

    it("moves the card with its subtasks to the picked column, with an undo", async () => {
      const { s, todo, doing, parent, sub } = await boardWithSubtasks();
      await startMove();

      expect(screen.getByText('Moving "Paint" — tap Move here on another section')).toBeTruthy();
      // Every other column offers itself; the card's own column does not.
      expect(screen.queryByLabelText("Move the card to To do")).toBeNull();
      expect(screen.getByLabelText("Move the card to No section")).toBeTruthy();
      await fireEvent.press(screen.getByLabelText("Move the card to Doing"));

      expect(task(s, parent)?.section_id).toBe(doing);
      expect(task(s, sub)?.section_id).toBe(doing);
      expect(screen.getByText(/Doing \(1\)/)).toBeTruthy();
      // The move is over: no banner, no targets left.
      expect(screen.queryByText(/Moving "Paint"/)).toBeNull();
      expect(screen.queryByLabelText(/Move the card to/)).toBeNull();

      await fireEvent.press(screen.getByText("Undo"));
      expect(task(s, parent)?.section_id).toBe(todo);
      expect(task(s, sub)?.section_id).toBe(todo);
    });

    it("leaves everything in place when the move is cancelled", async () => {
      const { s, todo, parent } = await boardWithSubtasks();
      await startMove();
      await fireEvent.press(screen.getByLabelText("Cancel"));

      expect(screen.queryByLabelText(/Move the card to/)).toBeNull();
      expect(task(s, parent)?.section_id).toBe(todo);
    });

    it("is not offered for a completed card in the Done column", async () => {
      const { s, projectId } = boardStore();
      const todo = addSection(s, projectId, "To do", 10);
      const id = createTask(s, { title: "Painted", project_id: projectId, section_id: todo });
      s.set("task", id, "is_completed", true);
      s.set("task", id, "completed_at", Date.now());
      s.set("preference", PREFERENCES_ID, "project_show_done", { [projectId]: true });
      await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

      await fireEvent.press(screen.getByLabelText("Done (1)"));
      await fireEvent.press(screen.getByLabelText("Task actions"));
      expect(screen.getByRole("menuitem", { name: "Copy" })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: "Move to section" })).toBeNull();
    });
  });

  it("adds a task straight into a column", async () => {
    const { s, projectId } = boardStore();
    const todo = addSection(s, projectId, "To do", 10);
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    await fireEvent.changeText(screen.getByLabelText("Add task to To do"), "Sand the floor");
    await fireEvent(screen.getByLabelText("Add task to To do"), "submitEditing");

    const inColumn = columnCards(projectTasks(s, projectId), todo).map((t) => t.title);
    expect(inColumn).toContain("Sand the floor");
  });

  it("hides an empty No section column once the project has sections", async () => {
    const { s, projectId } = boardStore();
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });
    // Without sections it is the only column, so it stays.
    expect(screen.getByLabelText("Add task to No section")).toBeTruthy();

    addSection(s, projectId, "To do", 10);
    await act(async () => {});
    await waitFor(() => expect(screen.queryByLabelText("Add task to No section")).toBeNull());

    // A task without a section brings it back.
    await act(async () => {
      createTask(s, { title: "Loose end", project_id: projectId });
    });
    await waitFor(() => expect(screen.getByLabelText("Add task to No section")).toBeTruthy());
  });

  it("places a task in its section's column with the count", async () => {
    const { s, projectId } = boardStore();
    const sectionId = addSection(s, projectId, "To do", 10);
    createTask(s, { title: "Paint", project_id: projectId, section_id: sectionId });
    await render(<BoardScreen projectId={projectId} />, { wrapper: withApp(s) });

    expect(screen.getByText("Paint")).toBeTruthy();
    expect(screen.getByText(/To do \(1\)/)).toBeTruthy();
  });
});
