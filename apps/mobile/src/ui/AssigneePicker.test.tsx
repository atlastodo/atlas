import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { AssigneePicker } from "./AssigneePicker";

/**
 * Over a real in-memory `LocalStore`. Members are `project_member` entities the server authors; these
 * seed them and assert the picker offers the project's members and writes `assignee_id`.
 */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: "p1",
    section_id: null,
    parent_id: null,
    title: "Task",
    notes: "",
    priority: 4,
    start_at: null,
    due_at: null,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function withMembers() {
  const s = new LocalStore("test");
  const add = (userId: string, name: string) => {
    const id = s.newEntityId();
    s.set("project_member", id, "project_id", "p1");
    s.set("project_member", id, "user_id", userId);
    s.set("project_member", id, "display_name", name);
    s.set("project_member", id, "email", `${userId}@example.com`);
    s.set("project_member", id, "role", "editor");
    s.set("project_member", id, "state", "active");
  };
  add("u-alice", "Alice");
  add("u-bob", "Bob");
  return s;
}

describe("AssigneePicker", () => {
  it("renders nothing for a project with no members", async () => {
    const s = new LocalStore("test");
    const { toJSON } = await render(<AssigneePicker task={task()} onUpdate={() => {}} />, {
      wrapper: withApp(s),
    });
    // Assignees are a shared-project concept -- no collaborators, no picker.
    expect(toJSON()).toBeNull();
  });

  it("offers each active member and Unassigned", async () => {
    await render(<AssigneePicker task={task()} onUpdate={() => {}} />, {
      wrapper: withApp(withMembers()),
    });
    expect(screen.getByLabelText("Alice")).toBeTruthy();
    expect(screen.getByLabelText("Bob")).toBeTruthy();
    expect(screen.getByLabelText("Unassigned")).toBeTruthy();
  });

  it("assigns the task to a chosen member", async () => {
    const onUpdate = jest.fn();
    const t = task();
    await render(<AssigneePicker task={t} onUpdate={onUpdate} />, {
      wrapper: withApp(withMembers()),
    });

    await fireEvent.press(screen.getByLabelText("Bob"));
    expect(onUpdate).toHaveBeenCalledWith(t, { assignee_id: "u-bob" });
  });

  it("clears the assignee with Unassigned", async () => {
    const onUpdate = jest.fn();
    const t = task({ assignee_id: "u-alice" });
    await render(<AssigneePicker task={t} onUpdate={onUpdate} />, {
      wrapper: withApp(withMembers()),
    });

    await fireEvent.press(screen.getByLabelText("Unassigned"));
    expect(onUpdate).toHaveBeenCalledWith(t, { assignee_id: null });
  });

  it("marks the current assignee as selected", async () => {
    await render(<AssigneePicker task={task({ assignee_id: "u-alice" })} onUpdate={() => {}} />, {
      wrapper: withApp(withMembers()),
    });
    expect(screen.getByLabelText("Alice").props.accessibilityState.selected).toBe(true);
    expect(screen.getByLabelText("Bob").props.accessibilityState.selected).toBe(false);
  });
});
