import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import {
  PREFERENCES_ID,
  createTask,
  quickScheduleOptions,
  reminderFireAt,
  toReminder,
  toTask,
} from "@atlastodo/shared";
import { withApp } from "../testutil";
import { QuickAdd } from "./QuickAdd";

/**
 * `now` is injected everywhere so "tomorrow" is a fixed instant rather than whatever the clock says
 * when CI runs. The parsing itself is `@atlastodo/shared`'s and tested there; these assert the wiring --
 * that what the parser understood is what actually gets created.
 */
const NOW = Date.parse("2026-07-17T12:00:00Z"); // a Friday
const TOMORROW = Date.parse("2026-07-18T12:00:00Z");

async function add(text: string, props: Partial<React.ComponentProps<typeof QuickAdd>> = {}) {
  const onAdd = jest.fn();
  await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" {...props} />);
  const field = screen.getByLabelText("Add a task");
  await fireEvent.changeText(field, text);
  await fireEvent(field, "submitEditing");
  return onAdd;
}

describe("QuickAdd", () => {
  it("creates a task with the parsed due date and priority", async () => {
    // The feature request's acceptance example.
    const onAdd = await add("buy milk tomorrow p1");

    expect(onAdd).toHaveBeenCalledTimes(1);
    const input = onAdd.mock.calls[0]![0];
    expect(input.title).toBe("buy milk");
    expect(input.priority).toBe(1);
    // Tomorrow, at the same time of day, in the given zone.
    expect(new Date(input.due_at).toISOString().slice(0, 10)).toBe(
      new Date(TOMORROW).toISOString().slice(0, 10),
    );
  });

  it("previews what it parsed before you commit", async () => {
    await render(<QuickAdd onAdd={() => {}} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "buy milk tomorrow p1");

    // The point of quick-add: you can see it understood you without submitting first -- on the very
    // chips that would have set those fields by hand.
    expect(screen.getByText("P1")).toBeTruthy();
    expect(screen.getByText(/Tomorrow/)).toBeTruthy();
  });

  it("puts the chips away again when the field loses focus", async () => {
    await render(<QuickAdd onAdd={() => {}} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    expect(screen.getByLabelText("Task details")).toBeTruthy();

    await fireEvent(field, "blur");
    expect(screen.queryByLabelText("Task details")).toBeNull();
  });

  it("resolves @labels at submit time", async () => {
    const resolveLabels = jest.fn(() => ["l1"]);
    const onAdd = await add("water plants @home", { resolveLabels });

    // Labels resolve on submit, not per keystroke -- resolving may create them.
    expect(resolveLabels).toHaveBeenCalledWith(["home"]);
    expect(onAdd.mock.calls[0]![0].label_ids).toEqual(["l1"]);
  });

  it("lets a parsed value win over a default", async () => {
    const onAdd = await add("mow the lawn p2", { defaults: { priority: 4 } });
    // What you typed beats what the view assumed.
    expect(onAdd.mock.calls[0]![0].priority).toBe(2);
  });

  it("does not create a task with no title", async () => {
    const onAdd = await add("   ");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("clears the field after adding, ready for the next task", async () => {
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "buy milk tomorrow");
    await fireEvent(field, "submitEditing");

    expect(field.props.value).toBe("");
    // ...and the preview goes with it, rather than describing a task already created.
    expect(screen.queryByText("Tomorrow")).toBeNull();
  });

  it("discards the draft on Escape without creating anything", async () => {
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "buy milk tomorrow p1");
    await fireEvent(field, "keyPress", { nativeEvent: { key: "Escape" } });

    // The way out of a field that keeps the caret between entries: nothing is created and the
    // half-typed draft (and its preview) is gone.
    expect(onAdd).not.toHaveBeenCalled();
    expect(field.props.value).toBe("");
    expect(screen.queryByLabelText("Task details")).toBeNull();
  });

  it("autocompletes a trailing @label from the suggestions", async () => {
    const onAdd = jest.fn();
    await render(
      <QuickAdd
        onAdd={onAdd}
        now={NOW}
        timeZone="UTC"
        labels={[
          { id: "l1", name: "home" },
          { id: "l2", name: "work" },
        ]}
        resolveLabels={(names) => names}
      />,
    );
    const field = screen.getByLabelText("Add a task");
    await fireEvent.changeText(field, "water plants @ho");

    // The partial mention offers the matching label; picking it completes the token.
    await fireEvent.press(screen.getByLabelText("home"));
    expect(field.props.value).toBe("water plants @home ");
  });

  it("creates a task with a date set from the chips", async () => {
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "buy milk");

    await fireEvent.press(screen.getByLabelText("Due date"));
    await fireEvent.press(screen.getByLabelText("Tomorrow"));
    await fireEvent.press(screen.getByLabelText("Save"));
    await fireEvent(field, "submitEditing");

    const tomorrow = quickScheduleOptions(NOW, "UTC").find((o) => o.key === "tomorrow")!;
    expect(onAdd.mock.calls[0]![0].due_at).toBe(tomorrow.dueAt);
    expect(onAdd.mock.calls[0]![0].title).toBe("buy milk");
  });

  it("lets a chip beat both the screen's default and the title", async () => {
    const onAdd = jest.fn();
    await render(
      <QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" defaults={{ due_at: 111, priority: 4 }} />,
    );
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "pay rent tomorrow");

    await fireEvent.press(screen.getByLabelText("Due date"));
    await fireEvent.press(screen.getByLabelText("Next week"));
    await fireEvent.press(screen.getByLabelText("Save"));
    await fireEvent(field, "submitEditing");

    const nextWeek = quickScheduleOptions(NOW, "UTC").find((o) => o.key === "nextWeek")!;
    expect(onAdd.mock.calls[0]![0].due_at).toBe(nextWeek.dueAt);
    // The phrase stops being read as a date once one is chosen by hand, so the word goes back to
    // being part of the title -- where the user can still see it and delete it.
    expect(onAdd.mock.calls[0]![0].title).toBe("pay rent tomorrow");
  });

  it("can refuse the date the screen assumed", async () => {
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" defaults={{ due_at: 111 }} />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "someday maybe");

    await fireEvent.press(screen.getByLabelText("Due date"));
    await fireEvent.press(screen.getByLabelText("No date"));
    await fireEvent.press(screen.getByLabelText("Save"));
    await fireEvent(field, "submitEditing");

    expect(onAdd.mock.calls[0]![0].due_at).toBeNull();
  });

  it("starts the next task from the screen's defaults again", async () => {
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "buy milk");
    await fireEvent.press(screen.getByLabelText("Priority"));
    await fireEvent.press(screen.getByLabelText("P1"));
    await fireEvent.press(screen.getByLabelText("Save"));
    await fireEvent(field, "submitEditing");

    // Nothing is sticky: a one-off P1 must not ride along on everything typed after it.
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "wash the car");
    await fireEvent(field, "submitEditing");

    expect(onAdd.mock.calls[0]![0].priority).toBe(1);
    expect(onAdd.mock.calls[1]![0].priority).toBeUndefined();
  });

  it("keeps the chips up while one of them is being pressed", async () => {
    // A chip press blurs the field on the web; if that put the bar away, the press that caused it
    // would land on nothing.
    await render(<QuickAdd onAdd={jest.fn()} now={NOW} timeZone="UTC" />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");

    const bar = screen.getByLabelText("Task details");
    await fireEvent(bar, "startShouldSetResponderCapture");
    await fireEvent(field, "blur");

    expect(screen.getByLabelText("Task details")).toBeTruthy();
  });

  it("keeps dates literal when smart dates are disabled", async () => {
    const onAdd = await add("meet tomorrow", { smartDates: false });
    // The whole phrase stays in the title; no due date is parsed.
    expect(onAdd.mock.calls[0]![0].title).toBe("meet tomorrow");
    expect(onAdd.mock.calls[0]![0].due_at).toBeUndefined();
  });

  it("shows dynamic create option and creates new label from mention", async () => {
    const onCreateLabel = jest.fn((name: string) => `lbl_${name}`);
    const onAdd = jest.fn();
    await render(
      <QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" onCreateLabel={onCreateLabel} labels={[]} />,
    );
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");

    // Keystrokes must NOT create labels
    await fireEvent.changeText(field, "Task @n");
    expect(onCreateLabel).not.toHaveBeenCalled();
    await fireEvent.changeText(field, "Task @ne");
    expect(onCreateLabel).not.toHaveBeenCalled();
    await fireEvent.changeText(field, "Task @newfeature");
    expect(onCreateLabel).not.toHaveBeenCalled();

    // The create option should be shown
    const createBtn = screen.getByLabelText("Create @newfeature");
    expect(createBtn).toBeTruthy();
    await fireEvent.press(createBtn);

    expect(onCreateLabel).toHaveBeenCalledTimes(1);
    expect(onCreateLabel).toHaveBeenCalledWith("newfeature");
  });

  it("keeps unknown #project and @label as literal text without auto-creating them upon submission", async () => {
    const onCreateProject = jest.fn((name: string) => `proj_${name}`);
    const onCreateLabel = jest.fn((name: string) => `lbl_${name}`);
    const onAdd = jest.fn();
    await render(
      <QuickAdd
        onAdd={onAdd}
        now={NOW}
        timeZone="UTC"
        onCreateProject={onCreateProject}
        onCreateLabel={onCreateLabel}
        projects={[]}
        labels={[]}
      />,
    );
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "Implement auth #Backend @Urgent");
    await fireEvent(field, "submitEditing");

    expect(onCreateProject).not.toHaveBeenCalled();
    expect(onCreateLabel).not.toHaveBeenCalled();
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Implement auth #Backend @Urgent",
      }),
    );
    const input = onAdd.mock.calls[0]![0];
    expect(input.project_id ?? null).toBeNull();
    expect(input.label_ids ?? []).toEqual([]);
  });

  it("never invents a project or label id when no creator is wired", async () => {
    // An id minted here would name a project/label that never exists, and the server rejects it.
    const onAdd = jest.fn();
    await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" projects={[]} labels={[]} />);
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "Plan trip #Travel");
    expect(screen.queryByLabelText("Create #Travel")).toBeNull();
    await fireEvent.changeText(field, "Plan trip @later");
    expect(screen.queryByLabelText("Create @later")).toBeNull();
    await fireEvent(field, "submitEditing");
    const input = onAdd.mock.calls[0]![0];
    expect(input.project_id ?? null).toBeNull();
    expect(input.label_ids ?? []).toEqual([]);
  });

  it("files a mention it creates under the id the creator returned", async () => {
    const onCreateProject = jest.fn(() => "real-project-id");
    const onAdd = jest.fn();
    await render(
      <QuickAdd
        onAdd={onAdd}
        now={NOW}
        timeZone="UTC"
        projects={[]}
        onCreateProject={onCreateProject}
      />,
    );
    const field = screen.getByLabelText("Add a task");
    await fireEvent(field, "focus");
    await fireEvent.changeText(field, "Plan trip #Travel");
    await fireEvent.press(screen.getByLabelText("Create #Travel"));
    await fireEvent(field, "submitEditing");
    expect(onCreateProject).toHaveBeenCalledWith("Travel");
    expect(onAdd.mock.calls[0]![0].project_id).toBe("real-project-id");
  });

  describe("suggestion keyboard navigation", () => {
    async function renderWithLabels() {
      return await render(
        <QuickAdd
          onAdd={jest.fn()}
          now={NOW}
          timeZone="UTC"
          onCreateLabel={jest.fn(() => "new-label")}
          labels={[
            { id: "l1", name: "home" },
            { id: "l2", name: "hobby" },
          ]}
        />,
      );
    }

    /** RNTL's synthetic key event needs an explicit preventDefault, as the real one always carries. */
    function key(key: string) {
      return { nativeEvent: { key }, preventDefault: jest.fn() };
    }

    it("highlights the first suggestion and moves the highlight with the arrows, wrapping", async () => {
      await renderWithLabels();
      const field = screen.getByLabelText("Add a task");
      await fireEvent.changeText(field, "water plants @ho");

      expect(screen.getByLabelText("home").props.accessibilityState).toEqual({ selected: true });
      expect(screen.getByLabelText("hobby").props.accessibilityState?.selected).toBeFalsy();

      await fireEvent(field, "keyPress", key("ArrowDown"));
      expect(screen.getByLabelText("hobby").props.accessibilityState).toEqual({ selected: true });

      // Down past the end and up past the start both wrap around.
      await fireEvent(field, "keyPress", key("ArrowDown"));
      await fireEvent(field, "keyPress", key("ArrowDown"));
      expect(screen.getByLabelText("home").props.accessibilityState).toEqual({ selected: true });

      await fireEvent(field, "keyPress", key("ArrowUp"));
      expect(screen.getByLabelText("Create @ho").props.accessibilityState).toEqual({
        selected: true,
      });
    });

    it("shows one row per distinct name, even when projects share a name", async () => {
      // Two projects both called "Test" are legal data; the popover keys rows by name, so a
      // duplicate would warn about colliding React keys.
      await render(
        <QuickAdd
          onAdd={jest.fn()}
          now={NOW}
          timeZone="UTC"
          projects={[
            { id: "p1", name: "Test" },
            { id: "p2", name: "Test" },
          ]}
        />,
      );
      const field = screen.getByLabelText("Add a task");
      await fireEvent.changeText(field, "file it #Test");

      expect(screen.getAllByLabelText("Test")).toHaveLength(1);
    });

    it("indicates the currently selected project in the mention popover", async () => {
      await render(
        <QuickAdd
          onAdd={jest.fn()}
          now={NOW}
          timeZone="UTC"
          defaults={{ project_id: "p1" }}
          projects={[
            { id: "p1", name: "Work" },
            { id: "p2", name: "Workshop" },
          ]}
        />,
      );
      const field = screen.getByLabelText("Add a task");
      await fireEvent.changeText(field, "file it #Wor");

      // p1 ("Work") is the current default project; it marks selected even when arrow moves to Workshop
      const workRow = screen.getByLabelText("Work");
      expect(workRow.props.accessibilityState).toEqual({ selected: true });

      // Moving highlight to Workshop leaves Work selected
      await fireEvent(field, "keyPress", key("ArrowDown"));
      const workshopRow = screen.getByLabelText("Workshop");
      expect(workshopRow.props.accessibilityState).toEqual({ selected: true });
      expect(workRow.props.accessibilityState).toEqual({ selected: true });
    });

    it("Escape puts the popover away first and only cancels the draft on the second press", async () => {
      await renderWithLabels();
      const field = screen.getByLabelText("Add a task");
      await fireEvent.changeText(field, "water plants @ho");
      expect(screen.getByLabelText("home")).toBeTruthy();

      await fireEvent(field, "keyPress", key("Escape"));
      // The popover is gone but the draft -- the mention being typed -- survives.
      expect(screen.queryByLabelText("home")).toBeNull();
      expect(field.props.value).toBe("water plants @ho");

      // Typing a different mention brings the popover back.
      await fireEvent.changeText(field, "water plants @hom");
      expect(screen.getByLabelText("home")).toBeTruthy();

      await fireEvent(field, "keyPress", key("Escape"));
      await fireEvent(field, "keyPress", key("Escape"));
      expect(field.props.value).toBe("");
    });
  });

  describe("implicit morning-of reminder", () => {
    // `NOW` is Friday 2026-07-17 at 12:00 UTC, so "tomorrow" (Saturday) all-day still has its 09:00
    // ahead of it, while "today"'s 09:00 is already past.
    const SATURDAY_9AM = Date.UTC(2026, 6, 18, 9, 0, 0);

    /** Quick-add into a real store, the way the screens wire it: `onAdd` creates and returns the id. */
    async function addInStore(
      text: string,
      store: LocalStore,
      props: Partial<React.ComponentProps<typeof QuickAdd>> = {},
    ) {
      const onAdd = jest.fn((input: Parameters<typeof createTask>[1]) => createTask(store, input));
      await render(<QuickAdd onAdd={onAdd} now={NOW} timeZone="UTC" {...props} />, {
        wrapper: withApp(store),
      });
      await fireEvent.changeText(screen.getByLabelText("Add a task"), text);
      await fireEvent(screen.getByLabelText("Add a task"), "submitEditing");
      return { onAdd, store };
    }

    const remindersIn = (store: LocalStore) =>
      store.list("reminder").map((e) => toReminder(e.id, e.fields));

    it("attaches one 09:00 morning-of reminder to an all-day quick-add", async () => {
      const store = new LocalStore("test");
      const { onAdd } = await addInStore("buy milk tomorrow", store);

      const reminders = remindersIn(store);
      expect(reminders).toHaveLength(1);
      // Anchored to the created task, expressed as the due-relative offset, never yet fired.
      expect(reminders[0]!.task_id).toBe(onAdd.mock.results[0]!.value);
      expect(reminders[0]!.offset_min_before_due).toBe(0);
      expect(reminders[0]!.at).toBeNull();
      expect(reminders[0]!.fired_at).toBeNull();
      // Round-tripped through the scheduler's resolver, it fires at 09:00 local on the due day.
      const task = toTask(
        onAdd.mock.results[0]!.value,
        store.get("task", onAdd.mock.results[0]!.value)!,
      );
      expect(reminderFireAt(reminders[0]!, task, "UTC")).toBe(SATURDAY_9AM);
    });

    it("does not attach when the quick-add parsed an explicit time", async () => {
      const store = new LocalStore("test");
      await addInStore("buy milk tomorrow 3pm", store);

      expect(remindersIn(store)).toHaveLength(0);
    });

    it("does not attach when the 09:00 morning is already past", async () => {
      const store = new LocalStore("test");
      await addInStore("buy milk today", store);

      expect(remindersIn(store)).toHaveLength(0);
    });

    it("does not attach when reminders are turned off in Settings", async () => {
      const store = new LocalStore("test");
      store.set("preference", PREFERENCES_ID, "reminders_enabled", false);
      await addInStore("buy milk tomorrow", store);

      expect(remindersIn(store)).toHaveLength(0);
    });
  });
});
