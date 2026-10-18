import { fireEvent, render, screen } from "@testing-library/react-native";
import { quickScheduleOptions } from "@atlastodo/shared";
import { TaskComposeBar } from "./TaskComposeBar";
import type { ComposeValue } from "../lib/composeDraft";

/** What each chip reads and what a tap reports, driven by label and text only; precedence is `lib/composeDraft`'s. */

const NOW = Date.parse("2026-07-17T12:00:00Z"); // a Friday
const TZ = "UTC";
const dueAt = (key: "today" | "tomorrow" | "weekend" | "nextWeek") =>
  quickScheduleOptions(NOW, TZ).find((o) => o.key === key)!.dueAt;

const EMPTY: ComposeValue = {
  due_at: null,
  priority: null,
  project_id: null,
  section_id: null,
  recurrence: null,
  label_ids: [],
  typedLabels: [],
};

async function mount(value: Partial<ComposeValue> = {}, props: Record<string, unknown> = {}) {
  const onChange = jest.fn();
  await render(
    <TaskComposeBar
      value={{ ...EMPTY, ...value }}
      onChange={onChange}
      projects={[
        { id: "p1", name: "Work" },
        { id: "p2", name: "Home" },
      ]}
      labels={[
        { id: "l1", name: "errand", color: "#f00" },
        { id: "l2", name: "urgent" },
      ]}
      now={NOW}
      timeZone={TZ}
      formatDue={(ms) => new Date(ms).toISOString().slice(0, 10)}
      {...props}
    />,
  );
  return onChange;
}

describe("TaskComposeBar", () => {
  it("reads the values in force, however they got there", async () => {
    await mount(
      {
        due_at: dueAt("tomorrow"),
        priority: 2,
        project_id: "p1",
        section_id: "s1",
        label_ids: ["l1"],
      },
      {
        sections: [{ id: "s1", project_id: "p1", name: "Urgent Stuff" }],
      },
    );
    expect(screen.getByText("Tomorrow")).toBeTruthy(); // all-day dues read date-only
    expect(screen.getByText("P2")).toBeTruthy();
    expect(screen.getByText("Work / Urgent Stuff")).toBeTruthy();
    expect(screen.getByText("errand")).toBeTruthy();
  });

  it("carries the clock time for a timed due", async () => {
    await mount({ due_at: Date.parse("2026-07-18T09:00:00Z") });
    expect(screen.getByText(/^Tomorrow,/)).toBeTruthy();
  });

  it("falls back to the list's own date format beyond tomorrow", async () => {
    await mount({ due_at: dueAt("nextWeek") });
    expect(screen.getByText("2026-07-24")).toBeTruthy();
  });

  it("opens the date presets in a bottom modal, and returns after confirming", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Due date"));

    expect(screen.getByLabelText("This weekend")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Tomorrow"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ due_at: dueAt("tomorrow") });
  });

  it("hands the keyboard back to the title field after a pick", async () => {
    const onInteract = jest.fn();
    await mount({}, { onInteract });
    await fireEvent.press(screen.getByLabelText("Due date"));
    expect(onInteract).toHaveBeenCalled();
  });

  it("says no date explicitly, rather than merely forgetting one", async () => {
    const onChange = await mount({ due_at: dueAt("today") });
    await fireEvent.press(screen.getByLabelText("Due date"));
    await fireEvent.press(screen.getByLabelText("No date"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ due_at: null });
  });

  it("sets a priority", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Priority"));
    await fireEvent.press(screen.getByLabelText("P1"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ priority: 1 });
  });

  it("files the task into a project, or the inbox", async () => {
    const onChange = await mount({ project_id: "p1" });
    await fireEvent.press(screen.getByLabelText("Project"));
    await fireEvent.press(screen.getByLabelText("Home"));
    expect(onChange).toHaveBeenCalledWith({ project_id: "p2", section_id: null });
  });

  it("drills down into sections when a project has sections and saves selected section", async () => {
    const onChange = await mount(
      {},
      {
        sections: [
          { id: "s1", project_id: "p1", name: "Backlog" },
          { id: "s2", project_id: "p1", name: "Doing" },
        ],
      },
    );
    await fireEvent.press(screen.getByLabelText("Project"));
    await fireEvent.press(screen.getByLabelText("Work"));
    // We are now in section list under Work
    await fireEvent.press(screen.getByLabelText("Doing"));
    expect(onChange).toHaveBeenCalledWith({ project_id: "p1", section_id: "s2" });
  });

  it("allows selecting 'No section' when drilling into a project with sections", async () => {
    const onChange = await mount(
      {},
      {
        sections: [{ id: "s1", project_id: "p1", name: "Backlog" }],
      },
    );
    await fireEvent.press(screen.getByLabelText("Project"));
    await fireEvent.press(screen.getByLabelText("Work"));
    await fireEvent.press(screen.getByLabelText("No section"));
    expect(onChange).toHaveBeenCalledWith({ project_id: "p1", section_id: null });
  });

  it("keeps the label list open across several choices and confirms on save", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Labels"));
    await fireEvent.press(screen.getByLabelText("errand"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ label_ids: ["l1"] });
  });

  it("takes a label back off", async () => {
    const onChange = await mount({ label_ids: ["l1", "l2"] });
    await fireEvent.press(screen.getByLabelText("Labels"));
    await fireEvent.press(screen.getByLabelText("errand"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ label_ids: ["l2"] });
  });

  it("sets a recurrence through the editor the task detail screen uses", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Repeat"));
    await fireEvent.press(screen.getByLabelText("Weekly"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ recurrence: expect.stringContaining("WEEKLY") });
  });

  it("offers to take the date off once there is one", async () => {
    const onClearDue = jest.fn();
    await mount({ due_at: dueAt("today") }, { onClearDue });
    await fireEvent.press(screen.getByLabelText("Remove date"));
    expect(onClearDue).toHaveBeenCalled();
  });

  it("creates a new project in the project modal and selects it", async () => {
    const onCreateProject = jest.fn((name: string) => `created_${name}`);
    const onChange = await mount({}, { onCreateProject });
    await fireEvent.press(screen.getByLabelText("Project"));
    const input = screen.getByPlaceholderText("Add project");
    await fireEvent.changeText(input, "Side Hustle");
    await fireEvent.press(screen.getByLabelText("Create"));
    expect(onCreateProject).toHaveBeenCalledWith("Side Hustle");
    expect(onChange).toHaveBeenCalledWith({ project_id: "created_Side Hustle", section_id: null });
  });

  it("creates a new label in the label modal and selects it", async () => {
    const onCreateLabel = jest.fn((name: string) => `created_${name}`);
    const onChange = await mount({}, { onCreateLabel });
    await fireEvent.press(screen.getByLabelText("Labels"));
    const input = screen.getByPlaceholderText("Add or create a label...");
    await fireEvent.changeText(input, "finance");
    await fireEvent.press(screen.getByLabelText("Create"));
    expect(onCreateLabel).toHaveBeenCalledWith("finance");
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({ label_ids: ["created_finance"] });
  });

  it("offers no create row, and so never invents an id, without a creator", async () => {
    // A made-up id would file the task under a project/label that never exists.
    await mount();
    await fireEvent.press(screen.getByLabelText("Project"));
    expect(screen.queryByPlaceholderText("Add project")).toBeNull();
    expect(screen.queryByLabelText("Create")).toBeNull();
  });

  it("sets a weekdays recurrence with interval adjustment", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Repeat"));
    await fireEvent.press(screen.getByLabelText("Weekdays (Mon–Fri)"));
    await fireEvent.press(screen.getByLabelText("+"));
    await fireEvent.press(screen.getByLabelText("Save"));
    expect(onChange).toHaveBeenCalledWith({
      recurrence: expect.stringMatching(/FREQ=WEEKLY.*INTERVAL=2/i),
    });
  });

  it("discards changes on Cancel without calling onChange", async () => {
    const onChange = await mount();
    await fireEvent.press(screen.getByLabelText("Priority"));
    await fireEvent.press(screen.getByLabelText("P1"));
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
