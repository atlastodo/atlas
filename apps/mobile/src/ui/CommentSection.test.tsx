import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { isTrashed, toComment, writeActivity } from "@atlastodo/shared";
import { fakeAuth, withApp } from "../testutil";
import { CommentSection } from "./CommentSection";

/**
 * Over a real in-memory `LocalStore`. The comment/activity mapping is `@atlastodo/shared`; these assert
 * the section posts and removes `comment` entities and renders a merged, time-ordered feed of
 * comments and activity.
 */

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    project_id: null,
    section_id: null,
    parent_id: null,
    title: "Buy milk",
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

const meAuth = fakeAuth({
  session: {
    accessToken: "a",
    refreshToken: "r",
    deviceId: "d",
    user: { id: "me", email: "me@example.com", display_name: "Me" },
  },
});

const commentsFor = (s: LocalStore, taskId: string) =>
  s
    .list("comment")
    .filter((e) => !isTrashed(e.fields))
    .map((e) => toComment(e.id, e.fields))
    .filter((c) => c.task_id === taskId);

describe("CommentSection", () => {
  it("posts a comment authored by the current user", async () => {
    const s = new LocalStore("test");
    await render(<CommentSection task={baseTask()} />, { wrapper: withApp(s, meAuth) });

    await fireEvent.changeText(screen.getByLabelText("Add a comment"), "Looks good");
    await fireEvent(screen.getByLabelText("Add a comment"), "submitEditing");

    const cs = commentsFor(s, "t1");
    expect(cs).toHaveLength(1);
    expect(cs[0]?.body).toBe("Looks good");
    expect(cs[0]?.author_id).toBe("me");
    expect(screen.getByText("Looks good")).toBeTruthy();
  });

  it("does not post an empty comment", async () => {
    const s = new LocalStore("test");
    await render(<CommentSection task={baseTask()} />, { wrapper: withApp(s, meAuth) });

    await fireEvent.changeText(screen.getByLabelText("Add a comment"), "   ");
    await fireEvent(screen.getByLabelText("Add a comment"), "submitEditing");

    expect(commentsFor(s, "t1")).toHaveLength(0);
  });

  it("removes the current user's comment", async () => {
    const s = new LocalStore("test");
    const id = s.newEntityId();
    s.set("comment", id, "task_id", "t1");
    s.set("comment", id, "author_id", "me");
    s.set("comment", id, "body", "Delete me");
    s.set("comment", id, "created_at", Date.now());
    await render(<CommentSection task={baseTask()} />, { wrapper: withApp(s, meAuth) });

    await fireEvent.press(screen.getByLabelText("Delete comment"));
    expect(commentsFor(s, "t1")).toHaveLength(0);
  });

  it("merges activity into the feed in time order", async () => {
    const s = new LocalStore("test");
    // An activity entry written before a comment.
    writeActivity(s, "me", "t1", "status", null, "completed", 1000);
    const cid = s.newEntityId();
    s.set("comment", cid, "task_id", "t1");
    s.set("comment", cid, "author_id", "me");
    s.set("comment", cid, "body", "After completing");
    s.set("comment", cid, "created_at", 2000);
    await render(<CommentSection task={baseTask()} />, { wrapper: withApp(s, meAuth) });

    // Both the activity line and the comment appear.
    expect(screen.getByText(/completed this task/)).toBeTruthy();
    expect(screen.getByText("After completing")).toBeTruthy();
  });

  it("shows an empty state with no comments or activity", async () => {
    const s = new LocalStore("test");
    await render(<CommentSection task={baseTask()} />, { wrapper: withApp(s, meAuth) });
    expect(screen.getByText(/No activity yet/)).toBeTruthy();
  });
});
