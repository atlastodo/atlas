import { useState, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { PREFERENCES_ID, toProject } from "@atlastodo/shared";
import { withApp } from "../testutil";
import { ProjectsScreen } from "./ProjectsScreen";

/** The screen with its header actions rendered above it, as the route's nav header would. */
function WithHeader({ onCreated }: { onCreated?: (id: string) => void }) {
  const [actions, setActions] = useState<ReactElement | null>(null);
  return (
    <>
      {actions}
      <ProjectsScreen onHeaderActions={setActions} onCreated={onCreated} />
    </>
  );
}

// Over a real in-memory `LocalStore`; project rules live in `useProjects` + `@atlastodo/shared`.

const projects = (s: LocalStore) =>
  s
    .list("project")
    .map((e) => toProject(e.id, e.fields))
    .filter((p) => p.deleted_at == null);
const named = (s: LocalStore, name: string) => projects(s).find((p) => p.name === name);

function seed(s: LocalStore, name: string, extra: Record<string, unknown> = {}) {
  const id = s.newEntityId();
  s.set("project", id, "name", name);
  s.set("project", id, "kind", "project");
  for (const [k, v] of Object.entries(extra)) s.set("project", id, k, v);
  return id;
}

describe("ProjectsScreen", () => {
  it("creates a project with a real UUID id", async () => {
    // A non-UUID entity_id 422s the whole sync push, so this is not cosmetic.
    const s = new LocalStore("test");
    const onCreated = jest.fn();
    await render(<WithHeader onCreated={onCreated} />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getAllByLabelText("New project")[0]!);
    await fireEvent.changeText(screen.getByLabelText("Name"), "Garden");
    await fireEvent(screen.getByLabelText("Name"), "submitEditing");

    const created = named(s, "Garden");
    expect(onCreated).toHaveBeenCalledWith(created!.id);
    expect(created).toBeTruthy();
    expect(created!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // A fresh project gets the default icon and a non-blank colour, so it is distinct out of the box.
    expect(created!.icon).toBe("hash");
    expect(created!.color).not.toBe("");
  });

  it("renames a project through the edit sheet", async () => {
    const s = new LocalStore("test");
    const id = seed(s, "Home reno");
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Home reno"), "longPress");
    const nameField = screen.getByLabelText("Project name");
    await fireEvent.changeText(nameField, "House renovation");
    await fireEvent(nameField, "blur");

    expect(toProject(id, s.get("project", id)!).name).toBe("House renovation");
  });

  it("changes a project's icon and colour", async () => {
    const s = new LocalStore("test");
    const id = seed(s, "Home reno", { icon: "hash", color: "#6366f1" });
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Home reno"), "longPress");
    await fireEvent.press(screen.getByLabelText("rocket"));
    await fireEvent.press(screen.getByLabelText("#10b981"));

    const p = toProject(id, s.get("project", id)!);
    expect(p.icon).toBe("rocket");
    expect(p.color).toBe("#10b981");
  });

  it("soft-deletes a project from the edit sheet", async () => {
    const s = new LocalStore("test");
    const id = seed(s, "Home reno");
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Home reno"), "longPress");
    await fireEvent.press(screen.getByLabelText("Delete project"));

    // Soft delete -> Trash, recoverable, so deleted_at is set rather than tombstoned.
    expect(typeof s.get("project", id)?.deleted_at).toBe("number");
    expect(screen.queryByText("Home reno")).toBeNull();
  });

  it("creates a project that opens as a board", async () => {
    const s = new LocalStore("test");
    await render(<WithHeader />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getAllByLabelText("New project")[0]!);
    await fireEvent.changeText(screen.getByLabelText("Name"), "Sprint");
    await fireEvent.press(screen.getByText("Board"));
    await fireEvent.press(screen.getByLabelText("Create"));

    expect(named(s, "Sprint")!.default_view).toBe("board");
  });

  it("creates a folder from the header", async () => {
    const s = new LocalStore("test");
    await render(<WithHeader />, { wrapper: withApp(s) });

    await fireEvent.press(screen.getByLabelText("New folder"));
    await fireEvent.changeText(screen.getByLabelText("Name"), "Clients");
    await fireEvent.press(screen.getByLabelText("Create"));

    const created = named(s, "Clients");
    expect(created!.kind).toBe("folder");
    expect(screen.getByText("Clients")).toBeTruthy();
  });

  it("toggles a project's favorite status from the edit sheet", async () => {
    const s = new LocalStore("test");
    const id = seed(s, "Home reno");
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Home reno"), "longPress");
    await fireEvent.press(screen.getByLabelText("Favorite"));
    const favs = s.get("preference", PREFERENCES_ID)?.favorites as
      Record<string, boolean> | undefined;
    expect(favs?.[`project:${id}`]).toBe(true);
  });

  it("nests a project under its folder and hides it when the folder is collapsed", async () => {
    const s = new LocalStore("test");
    const folderId = seed(s, "Clients", { kind: "folder", sort_order: 1 });
    seed(s, "Acme", { parent_id: folderId, sort_order: 2 });
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    expect(screen.getByText("Acme")).toBeTruthy();
    await fireEvent.press(screen.getByText("Clients"));
    expect(screen.queryByText("Acme")).toBeNull();
  });

  it("moves a project into a folder from the edit sheet", async () => {
    const s = new LocalStore("test");
    const folderId = seed(s, "Clients", { kind: "folder" });
    const id = seed(s, "Acme");
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Acme"), "longPress");
    await fireEvent.press(screen.getByLabelText("Move to folder"));
    await fireEvent.press(screen.getByLabelText("Move to Clients"));

    expect(s.get("project", id)!.parent_id).toBe(folderId);
  });

  it("does not offer a folder its own subtree as a destination", async () => {
    // The cycle guard is enforced in the hook; the picker just never shows the impossible options.
    const s = new LocalStore("test");
    const outer = seed(s, "Work", { kind: "folder" });
    seed(s, "Clients", { kind: "folder", parent_id: outer });
    await render(<ProjectsScreen />, { wrapper: withApp(s) });

    await fireEvent(screen.getByText("Work"), "longPress");
    await fireEvent.press(screen.getByLabelText("Move to folder"));

    expect(screen.getByLabelText("No folder")).toBeTruthy();
    expect(screen.queryByLabelText("Move to Clients")).toBeNull();
    expect(screen.queryByLabelText("Move to Work")).toBeNull();
  });
});
