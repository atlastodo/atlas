import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore, type Task } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { BulkLabelSheet } from "./BulkLabelSheet";

/**
 * The selection toolbar's bulk label sheet, over a real in-memory store (`useLabels` is a store
 * hook). Behavioural, like `LabelPicker.test`: the picker is seeded with the labels the selected
 * tasks share, an add/remove emits the delta for the caller to write, and the clear affordance is
 * only there when there is something to clear.
 */

function seedLabel(store: LocalStore, name: string): string {
  const id = store.newEntityId();
  store.set("label", id, "name", name);
  store.set("label", id, "color", "#ef4444");
  return id;
}

function task(overrides: Partial<Task> = {}): Task {
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

describe("BulkLabelSheet", () => {
  it("stays closed while the title is null", async () => {
    const store = new LocalStore("test");
    await render(
      <BulkLabelSheet
        title={null}
        tasks={[]}
        onApply={jest.fn()}
        onClear={jest.fn()}
        onClose={jest.fn()}
      />,
      {
        wrapper: withApp(store),
      },
    );

    expect(screen.queryByText("Labels")).toBeNull();
  });

  it("seeds the picker with the labels every selected task shares", async () => {
    const store = new LocalStore("test");
    const work = seedLabel(store, "work");
    const urgent = seedLabel(store, "urgent");
    // Only the first task has "urgent", so it is not shared: it must not show as a chip.
    const tasks = [
      task({ id: "a", label_ids: [work, urgent] }),
      task({ id: "b", label_ids: [work] }),
    ];

    await render(
      <BulkLabelSheet
        title="2 selected"
        tasks={tasks}
        onApply={jest.fn()}
        onClear={jest.fn()}
        onClose={jest.fn()}
      />,
      { wrapper: withApp(store) },
    );

    expect(screen.getByText("work")).toBeTruthy();
    // "urgent" shows up as an available suggestion (the picker's design), but carries no remove
    // affordance -- only genuinely shared labels render as removable chips.
    expect(screen.queryByLabelText("Remove urgent")).toBeNull();
    expect(screen.getByLabelText("Remove work")).toBeTruthy();
  });

  it("emits the remove delta when a shared chip is removed", async () => {
    const store = new LocalStore("test");
    const work = seedLabel(store, "work");
    const tasks = [task({ id: "a", label_ids: [work] }), task({ id: "b", label_ids: [work] })];
    const onApply = jest.fn();

    await render(
      <BulkLabelSheet
        title="2 selected"
        tasks={tasks}
        onApply={onApply}
        onClear={jest.fn()}
        onClose={jest.fn()}
      />,
      { wrapper: withApp(store) },
    );

    await fireEvent.press(screen.getByLabelText("Remove work"));
    expect(onApply).toHaveBeenCalledWith({ add: [], remove: [work] });
  });

  it("emits the add delta when a shared-out label is picked", async () => {
    const store = new LocalStore("test");
    const work = seedLabel(store, "work");
    const urgent = seedLabel(store, "urgent");
    // Neither task has "urgent", so it is only a suggestion; picking it assigns it to all.
    const tasks = [task({ id: "a", label_ids: [work] }), task({ id: "b", label_ids: [] })];
    const onApply = jest.fn();

    await render(
      <BulkLabelSheet
        title="2 selected"
        tasks={tasks}
        onApply={onApply}
        onClear={jest.fn()}
        onClose={jest.fn()}
      />,
      { wrapper: withApp(store) },
    );

    await fireEvent.changeText(screen.getByLabelText("Add label"), "ur");
    await fireEvent.press(screen.getByLabelText("urgent"));
    expect(onApply).toHaveBeenCalledWith({ add: [urgent], remove: [] });
  });

  it("offers Clear labels when the selection carries any, and wires it", async () => {
    const store = new LocalStore("test");
    const work = seedLabel(store, "work");
    const tasks = [task({ id: "a", label_ids: [work] }), task({ id: "b", label_ids: [] })];
    const onClear = jest.fn();

    await render(
      <BulkLabelSheet
        title="2 selected"
        tasks={tasks}
        onApply={jest.fn()}
        onClear={onClear}
        onClose={jest.fn()}
      />,
      { wrapper: withApp(store) },
    );

    await fireEvent.press(screen.getByLabelText("Clear labels"));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("hides Clear labels when no selected task has any", async () => {
    const store = new LocalStore("test");
    const tasks = [task({ id: "a" }), task({ id: "b" })];

    await render(
      <BulkLabelSheet
        title="2 selected"
        tasks={tasks}
        onApply={jest.fn()}
        onClear={jest.fn()}
        onClose={jest.fn()}
      />,
      { wrapper: withApp(store) },
    );

    expect(screen.queryByLabelText("Clear labels")).toBeNull();
  });
});
