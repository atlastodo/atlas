import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, createTask } from "@atlastodo/shared";
import i18n from "../i18n";
import { withApp } from "../testutil";
import { useSelection, type SelectionApi } from "../data/SelectionProvider";
import { AllTasksScreen } from "../screens/AllTasksScreen";
import { ProjectScreen } from "../screens/ProjectScreen";

/**
 * A long list must re-render only the rows that changed. Every store write rebuilds every `Task`
 * object and bumps the store context, so without row memoisation one edit re-rendered all 1,000
 * rows.
 *
 * Renders are counted through `usePaintHandlers`, which `TaskRow` calls exactly once per render and
 * nothing else in these screens calls.
 */
const mockRenders = new Map<string, number>();
jest.mock("../hooks/usePaintHandlers", () => {
  const actual = jest.requireActual("../hooks/usePaintHandlers");
  return {
    ...actual,
    usePaintHandlers: (id: string, ...rest: unknown[]) => {
      mockRenders.set(id, (mockRenders.get(id) ?? 0) + 1);
      return actual.usePaintHandlers(id, ...rest);
    },
  };
});

const COUNT = 1000;

function seed(projectId: string | null = null) {
  const s = new LocalStore("test");
  if (projectId) {
    s.set("project", projectId, "name", "Big project");
    s.set("project", projectId, "kind", "project");
  }
  const ids: string[] = [];
  for (let i = 0; i < COUNT; i++)
    ids.push(createTask(s, { title: `Task ${i}`, project_id: projectId, sort_order: i }));
  return { s, ids };
}

/** Rows rendered since the last reset. */
function rendered(): string[] {
  return [...mockRenders.keys()];
}

function report(what: string) {
  let total = 0;
  for (const n of mockRenders.values()) total += n;
  console.log(`${what}: ${mockRenders.size} rows, ${total} renders`);
}

beforeEach(() => mockRenders.clear());

describe.each([
  ["AllTasksScreen (GroupedTaskList)", false],
  ["ProjectScreen (ProjectTaskList)", true],
])("%s", (_name, inProject) => {
  async function mount() {
    const projectId = inProject ? "p1" : null;
    const { s, ids } = seed(projectId);
    await render(inProject ? <ProjectScreen projectId="p1" /> : <AllTasksScreen />, {
      wrapper: withApp(s),
    });
    expect(screen.getByText(`Task ${COUNT - 1}`)).toBeTruthy();
    expect(mockRenders.size).toBe(COUNT);
    mockRenders.clear();
    return { s, ids };
  }

  it("re-renders only the edited row when one task changes", async () => {
    const { s, ids } = await mount();

    await act(async () => {
      s.set("task", ids[500]!, "title", "Renamed");
    });

    expect(screen.getByText("Renamed")).toBeTruthy();
    report(`[${_name}] one title edit`);
    expect(rendered()).toEqual([ids[500]]);
  });

  it("re-renders only the completed row when one is toggled", async () => {
    const { ids } = await mount();

    await fireEvent.press(screen.getAllByLabelText("Complete task")[10]!);

    // The completed task leaves the open list; nothing else needs to render again.
    report(`[${_name}] completing one task`);
    expect(rendered().filter((id) => id !== ids[10])).toEqual([]);
  });
});

describe.each([
  ["AllTasksScreen (GroupedTaskList)", false],
  ["ProjectScreen (ProjectTaskList)", true],
])("%s selection", (_name, inProject) => {
  let selection: SelectionApi;
  function Probe() {
    selection = useSelection();
    return null;
  }

  it("re-renders only the row whose selection changed", async () => {
    const { s, ids } = seed(inProject ? "p1" : null);
    await render(
      <>
        <Probe />
        {inProject ? <ProjectScreen projectId="p1" /> : <AllTasksScreen />}
      </>,
      { wrapper: withApp(s) },
    );
    mockRenders.clear();
    await act(async () => selection.enter());
    // Entering select mode changes every row (the checkbox replaces the toggle).
    expect(mockRenders.size).toBe(COUNT);
    mockRenders.clear();

    const boxes = screen.getAllByLabelText(i18n.t("selection.toggleRow"));
    await fireEvent.press(boxes[3]!);
    report(`[${_name}] selecting one row`);

    expect(rendered()).toEqual([ids[3]]);
    expect(screen.getAllByLabelText(i18n.t("selection.toggleRow"))[3]).toBeChecked();
  });
});

/** What a memoised row must still pick up: changes to the values it shows that are not its task's. */
describe("a memoised row still updates", () => {
  function small() {
    const s = new LocalStore("test");
    s.set("project", "p1", "name", "Garden");
    s.set("project", "p1", "kind", "project");
    s.set("label", "l1", "name", "Errands");
    const parent = createTask(s, { title: "Parent", sort_order: 0 });
    const child = createTask(s, { title: "Child", parent_id: parent, sort_order: 1 });
    createTask(s, { title: "Sibling child", parent_id: parent, sort_order: 2 });
    createTask(s, { title: "Planted", project_id: "p1", label_ids: ["l1"], sort_order: 3 });
    return { s, parent, child };
  }

  it("when its project is renamed", async () => {
    const { s } = small();
    await render(<AllTasksScreen />, { wrapper: withApp(s) });
    expect(screen.getByText("Garden")).toBeTruthy();

    await act(async () => {
      s.set("project", "p1", "name", "Allotment");
    });

    expect(screen.getByText("Allotment")).toBeTruthy();
  });

  it("when its label is renamed", async () => {
    const { s } = small();
    await render(<AllTasksScreen />, { wrapper: withApp(s) });
    expect(screen.getByText("Errands")).toBeTruthy();

    await act(async () => {
      s.set("label", "l1", "name", "Shopping");
    });

    expect(screen.getByText("Shopping")).toBeTruthy();
  });

  it("when one of its subtasks is completed", async () => {
    const { s, child } = small();
    await render(<AllTasksScreen />, { wrapper: withApp(s) });
    expect(screen.getByText("0/2")).toBeTruthy();

    await act(async () => {
      s.set("task", child, "is_completed", true);
      s.set("task", child, "completed_at", Date.now());
    });

    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("when the language changes", async () => {
    const { s } = small();
    await render(<AllTasksScreen />, { wrapper: withApp(s) });
    const english = i18n.t("task.complete");
    expect(screen.getAllByLabelText(english)).toHaveLength(4);

    try {
      await act(async () => {
        await i18n.changeLanguage("da");
      });
      const danish = i18n.t("task.complete");
      expect(danish).not.toBe(english);
      expect(screen.getAllByLabelText(danish)).toHaveLength(4);
    } finally {
      await act(async () => {
        await i18n.changeLanguage("en");
      });
    }
  });

  it("when the swipe preference changes", async () => {
    const { s } = small();
    await render(<AllTasksScreen />, { wrapper: withApp(s) });
    mockRenders.clear();

    await act(async () => {
      s.set("preference", PREFERENCES_ID, "swipe_left_action", "delete");
    });

    expect(mockRenders.size).toBe(4);
  });
});
