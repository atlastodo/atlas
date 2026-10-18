import { parseQuickAdd, type QuickAddResult } from "@atlastodo/shared";
import { composeInput, composeValue, mergeDraft, type ComposeDraft } from "./composeDraft";

/**
 * The precedence quick-add's compose bar rests on: a screen's default, beaten by what was typed,
 * beaten by what was tapped. Pure, so it is asserted here rather than through a rendered input --
 * the bar's own test covers the chips, and `QuickAdd`'s covers the two meeting.
 */

const NOW = Date.parse("2026-07-17T12:00:00Z"); // a Friday
const parse = (text: string): QuickAddResult => parseQuickAdd(text, NOW, { timeZone: "UTC" });

describe("composeInput", () => {
  it("lets what was typed beat the default", () => {
    const input = composeInput({ priority: 4 }, parse("buy milk p2"), {});
    expect(input.priority).toBe(2);
  });

  it("lets what was tapped beat both", () => {
    const input = composeInput({ due_at: 111 }, parse("buy milk tomorrow"), { due_at: 222 });
    expect(input.due_at).toBe(222);
  });

  it("can say no to a date the screen assumed", () => {
    // "No date" has to be a real value, not an absent key: a missing key means "nobody chose", which
    // is exactly when the default applies.
    const input = composeInput({ due_at: 111 }, parse("buy milk tomorrow"), { due_at: null });
    expect(input.due_at).toBeNull();
  });

  it("gathers labels from the title and the picker together", () => {
    // Both mean "also give it this one", so neither replaces the other; the typed name's id is
    // whatever resolving it produced.
    const input = composeInput(undefined, parse("water plants @home"), { label_ids: ["l2"] }, [
      "l1",
    ]);
    expect(input.label_ids).toEqual(["l1", "l2"]);
  });

  it("drops the screen's section when a project is chosen by hand", () => {
    // A section belongs to one project; carrying it across would file the task in a section of a
    // project it is no longer in.
    const input = composeInput({ project_id: "p1", section_id: "s1" }, parse("x"), {
      project_id: "p2",
    });
    expect(input.project_id).toBe("p2");
    expect(input.section_id).toBeNull();
  });

  it("keeps explicit section when chosen with or after project", () => {
    const input = composeInput({ project_id: "p1", section_id: "s1" }, parse("x"), {
      project_id: "p2",
      section_id: "s2",
    });
    expect(input.project_id).toBe("p2");
    expect(input.section_id).toBe("s2");
  });
});

describe("mergeDraft", () => {
  it("adds a field without disturbing the others", () => {
    const draft: ComposeDraft = { due_at: 1, priority: 2 };
    expect(mergeDraft(draft, { project_id: "p1" })).toEqual({
      due_at: 1,
      priority: 2,
      project_id: "p1",
    });
  });

  it("unpins a field rather than setting it to nothing", () => {
    // Having the key at all is what "chosen by hand" means, so an unpinned field has to lose its key
    // -- otherwise it would go on beating the default it was meant to fall back to.
    const unpinned = mergeDraft({ due_at: 1 }, { due_at: undefined });
    expect("due_at" in unpinned).toBe(false);
    expect(composeInput({ due_at: 111 }, parse("x"), unpinned).due_at).toBe(111);
  });
});

describe("composeValue", () => {
  it("reads no priority as unset, so its chip stays blank", () => {
    expect(composeValue(undefined, parse("x"), { priority: 4 }).priority).toBeNull();
    expect(composeValue(undefined, parse("x p1"), {}).priority).toBe(1);
  });

  it("separates the labels the bar can toggle from the ones the title carries", () => {
    const value = composeValue(undefined, parse("water plants @home"), { label_ids: ["l1"] });
    expect(value.typedLabels).toEqual(["home"]);
    expect(value.label_ids).toEqual(["l1"]);
  });
});
