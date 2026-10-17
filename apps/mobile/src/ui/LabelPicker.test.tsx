import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { LocalStore } from "@atlastodo/client-core";
import { withApp } from "../testutil";
import { LabelPicker } from "./LabelPicker";

/** The task label picker, over a real in-memory store: an existing label can be added and removed, and a new name creates and selects one. */
function seedLabel(store: LocalStore, name: string): string {
  const id = store.newEntityId();
  store.set("label", id, "name", name);
  store.set("label", id, "color", "#ef4444");
  return id;
}

/** A stateful host so `onChange` actually re-renders the picker with the new ids, as a screen does. */
function Host() {
  const [ids, setIds] = useState<string[]>([]);
  return <LabelPicker labelIds={ids} onChange={setIds} />;
}

describe("LabelPicker", () => {
  it("adds an existing label from the suggestion list, then removes it", async () => {
    const store = new LocalStore("test");
    seedLabel(store, "work");
    await render(<Host />, { wrapper: withApp(store) });

    // No labels yet.
    expect(screen.getByText("No labels")).toBeTruthy();

    // Type to filter, then tap the "work" suggestion (its accessibilityLabel is the name).
    await fireEvent.changeText(screen.getByLabelText("Add label"), "wo");
    await fireEvent.press(screen.getByLabelText("work"));
    expect(screen.getByText("work")).toBeTruthy();
    expect(screen.queryByText("No labels")).toBeNull();

    // Remove it.
    await fireEvent.press(screen.getByLabelText("Remove work"));
    expect(screen.getByText("No labels")).toBeTruthy();
  });

  it("creates a new label from a novel name and selects it", async () => {
    const store = new LocalStore("test");
    await render(<Host />, { wrapper: withApp(store) });

    await fireEvent.changeText(screen.getByLabelText("Add label"), "urgent");
    await fireEvent.press(screen.getByLabelText('Create "urgent"'));

    // Selected chip shows, and the label now exists in the store.
    expect(screen.getByText("urgent")).toBeTruthy();
    const names = store.list("label").map((e) => e.fields.name);
    expect(names).toContain("urgent");
  });
});
