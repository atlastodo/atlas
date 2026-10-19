import { describe, it, expect } from "vitest";
import { LocalStore } from "@atlastodo/client-core";
import { createTask, allTasks, visibleTasks } from "./taskOps";
import { moveSectionToProject, setSectionArchived, visibleSections } from "./sectionOps";

function setup() {
  const store = new LocalStore("test");
  return { store };
}

/** Create a section directly (there is no shared createSection; the app hooks own that). */
function makeSection(
  store: LocalStore,
  id: string,
  projectId: string,
  name: string,
  order: number,
) {
  store.set("section", id, "project_id", projectId);
  store.set("section", id, "name", name);
  store.set("section", id, "sort_order", order);
}

describe("moveSectionToProject", () => {
  it("re-parents the section and every task in it, keeping section_id", () => {
    const { store } = setup();
    makeSection(store, "s1", "p1", "Todo", 0);
    createTask(store, { title: "a", project_id: "p1", section_id: "s1" });
    createTask(store, { title: "b", project_id: "p1", section_id: "s1" });
    // A task in a different section of the same project must NOT move.
    createTask(store, { title: "c", project_id: "p1", section_id: "s2" });

    moveSectionToProject(store, "s1", "p2");

    const byTitle = (t: string) => allTasks(store).find((x) => x.title === t)!;
    expect(byTitle("a").project_id).toBe("p2");
    expect(byTitle("a").section_id).toBe("s1"); // section id unchanged
    expect(byTitle("b").project_id).toBe("p2");
    expect(byTitle("c").project_id).toBe("p1"); // untouched
    expect(visibleSections(store, "p2").map((s) => s.id)).toEqual(["s1"]);
    expect(visibleSections(store, "p1")).toHaveLength(0);
  });
});

describe("setSectionArchived", () => {
  it("archives a section and cascade-hides its tasks from lists; restore brings them back", () => {
    const { store } = setup();
    makeSection(store, "s1", "p1", "Todo", 0);
    createTask(store, { title: "a", project_id: "p1", section_id: "s1" });

    setSectionArchived(store, "s1", true);
    expect(visibleSections(store, "p1")).toHaveLength(0);
    expect(visibleTasks(store)).toHaveLength(0); // read cascade hides the task

    setSectionArchived(store, "s1", false);
    expect(visibleSections(store, "p1")).toHaveLength(1);
    expect(visibleTasks(store)).toHaveLength(1); // task returns with its section
  });
});
