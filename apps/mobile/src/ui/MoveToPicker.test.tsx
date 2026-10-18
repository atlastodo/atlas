import { fireEvent, render, screen } from "@testing-library/react-native";
import type { Project, Section } from "@atlastodo/client-core";
import { MoveToPicker } from "./MoveToPicker";

describe("MoveToPicker", () => {
  const projects: Project[] = [
    {
      id: "p1",
      owner_id: "u1",
      name: "Work",
      color: "#38bdf8",
      icon: "briefcase",
      kind: "project",
      default_view: "list",
      parent_id: null,
      sort_order: 1,
      is_favorite: false,
      archived_at: null,
      deleted_at: null,
    },
    {
      id: "p2",
      owner_id: "u1",
      name: "Personal",
      color: "#10b981",
      icon: "heart",
      kind: "project",
      default_view: "list",
      parent_id: null,
      sort_order: 2,
      is_favorite: false,
      archived_at: null,
      deleted_at: null,
    },
    {
      id: "f1",
      owner_id: "u1",
      name: "Archive Folder",
      color: "#737373",
      icon: "folder",
      kind: "folder",
      default_view: "list",
      parent_id: null,
      sort_order: 3,
      is_favorite: false,
      archived_at: null,
      deleted_at: null,
    },
    {
      id: "p3",
      owner_id: "u1",
      name: "Nested Project",
      color: "#f59e0b",
      icon: "star",
      kind: "project",
      default_view: "list",
      parent_id: "f1",
      sort_order: 1,
      is_favorite: false,
      archived_at: null,
      deleted_at: null,
    },
  ];

  const sections: Section[] = [
    {
      id: "s1",
      project_id: "p1",
      name: "In Progress",
      sort_order: 1,
      archived_at: null,
      deleted_at: null,
    },
  ];

  it("picks Inbox immediately when pressed", async () => {
    const onPick = jest.fn();
    await render(
      <MoveToPicker
        title="Move 1 task"
        projects={projects}
        sections={sections}
        onPick={onPick}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByText("Inbox"));
    expect(onPick).toHaveBeenCalledWith({ project_id: null, section_id: null });
  });

  it("picks a project with no sections immediately", async () => {
    const onPick = jest.fn();
    await render(
      <MoveToPicker
        title="Move 1 task"
        projects={projects}
        sections={sections}
        onPick={onPick}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByText("Personal"));
    expect(onPick).toHaveBeenCalledWith({ project_id: "p2", section_id: null });
  });

  it("drills down into sections for a project that has sections", async () => {
    const onPick = jest.fn();
    await render(
      <MoveToPicker
        title="Move 1 task"
        projects={projects}
        sections={sections}
        onPick={onPick}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByText("Work"));
    expect(onPick).not.toHaveBeenCalled();

    // Now on sections screen
    expect(screen.getByText("No section")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();

    await fireEvent.press(screen.getByText("In Progress"));
    expect(onPick).toHaveBeenCalledWith({ project_id: "p1", section_id: "s1" });
  });

  it("orders sections by sort_order and excludes archived/deleted sections", async () => {
    const unorderedSections: Section[] = [
      {
        id: "s3",
        project_id: "p1",
        name: "Done Column",
        sort_order: 30,
        archived_at: null,
        deleted_at: null,
      },
      {
        id: "s1",
        project_id: "p1",
        name: "To Do Column",
        sort_order: 10,
        archived_at: null,
        deleted_at: null,
      },
      {
        id: "s2",
        project_id: "p1",
        name: "In Progress Column",
        sort_order: 20,
        archived_at: null,
        deleted_at: null,
      },
      {
        id: "s-archived",
        project_id: "p1",
        name: "Archived Column",
        sort_order: 5,
        archived_at: Date.now(),
        deleted_at: null,
      },
      {
        id: "s-deleted",
        project_id: "p1",
        name: "Deleted Column",
        sort_order: 6,
        archived_at: null,
        deleted_at: Date.now(),
      },
    ];

    await render(
      <MoveToPicker
        title="Move 1 task"
        projects={projects}
        sections={unorderedSections}
        onPick={jest.fn()}
        onClose={jest.fn()}
      />,
    );

    await fireEvent.press(screen.getByText("Work"));

    expect(screen.queryByText("Archived Column")).toBeNull();
    expect(screen.queryByText("Deleted Column")).toBeNull();

    const rendered = screen.getAllByText(/Column/);
    expect(rendered.map((r) => r.props.children)).toEqual([
      "To Do Column",
      "In Progress Column",
      "Done Column",
    ]);
  });
});
