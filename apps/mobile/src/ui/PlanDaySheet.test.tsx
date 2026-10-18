import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import type { Task } from "@atlastodo/client-core";
import { endOfDay, planDayItems, planDayUpcoming, type PlanDayItem } from "@atlastodo/shared";
import { PlanDaySheet } from "./PlanDaySheet";

/**
 * The sheet is dumb (no store access): it is mounted with a hand-built proposed set. Row controls carry title-scoped labels,
 * so queries need no tree walking. Screen-level wiring is TodayScreen's tests.
 */

const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();
const DAY = 86_400_000;
const TOMORROW = endOfDay(NOW + DAY);

function task(id: string, title: string, dueAt: number | null): Task {
  return {
    id,
    project_id: null,
    section_id: null,
    parent_id: null,
    title,
    notes: "",
    priority: 4,
    start_at: null,
    due_at: dueAt,
    is_completed: false,
    completed_at: null,
    archived_at: null,
    deleted_at: null,
    recurrence: null,
    assignee_id: null,
    estimate_min: null,
    label_ids: [],
    sort_order: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

const formatDue = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

interface MountProps {
  items?: PlanDayItem[];
  upcoming?: Task[];
  apply?: (writes: { id: string; dueAt: number }[]) => void;
}

async function mount(props: MountProps = {}) {
  const onApply = jest.fn(props.apply ?? (() => {}));
  const onClose = jest.fn();
  await render(
    <PlanDaySheet
      open
      items={props.items ?? []}
      upcoming={props.upcoming ?? []}
      now={NOW}
      formatDue={formatDue}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  return { onApply, onClose };
}

describe("PlanDaySheet", () => {
  it("proposes overdue and today's tasks, with each row's source called out", async () => {
    await mount({
      items: planDayItems(
        [task("rent", "Pay the rent", NOW - 2 * DAY), task("milk", "Buy milk", NOW + 3600_000)],
        NOW,
      ),
    });

    expect(screen.getByText("Plan your day")).toBeTruthy();
    expect(screen.getByText("2 tasks to review")).toBeTruthy();
    expect(screen.getByText("Pay the rent")).toBeTruthy();
    expect(screen.getByText("Buy milk")).toBeTruthy();
    // The overdue row says so (in red), the today row reads as today.
    expect(screen.getByText(/Overdue, Jun 30/)).toBeTruthy();
    expect(screen.getAllByText("Today").length).toBeGreaterThan(0);
  });

  it("stages tomorrow as the default postpone and refines it from the day strip", async () => {
    const { onApply, onClose } = await mount({
      items: planDayItems([task("rent", "Pay the rent", NOW - 2 * DAY)], NOW),
    });

    // One press stages the default and opens the day strip to refine it.
    await fireEvent.press(screen.getByLabelText("Postpone: Pay the rent"));
    expect(screen.getByLabelText("Tomorrow: Pay the rent")).toBeTruthy(); // offered first, as the default
    expect(screen.getByText("Moves to Jul 3")).toBeTruthy();

    // Picking a strip day re-stages to that day instead (the horizon's last day).
    await fireEvent.press(screen.getByText("Thu"));
    expect(screen.getByText("Moves to Jul 9")).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Apply changes"));
    expect(onApply).toHaveBeenCalledWith([{ id: "rent", dueAt: endOfDay(NOW + 7 * DAY) }]);
    // Applying closes the pass.
    expect(onClose).toHaveBeenCalled();
  });

  it("keep and later stage without writing; apply offers nothing when nothing moves", async () => {
    const { onApply, onClose } = await mount({
      items: planDayItems(
        [task("rent", "Pay the rent", NOW - 2 * DAY), task("milk", "Buy milk", NOW + 3600_000)],
        NOW,
      ),
    });

    await fireEvent.press(screen.getByLabelText("Keep: Pay the rent"));
    await fireEvent.press(screen.getByLabelText("Later: Buy milk"));

    const applyButton = screen.getByLabelText("Apply changes");
    expect(applyButton.props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(applyButton);
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("applies a mixed pass as one batch of writes and closes", async () => {
    const { onApply } = await mount({
      items: planDayItems(
        [task("rent", "Pay the rent", NOW - 2 * DAY), task("milk", "Buy milk", NOW + 3600_000)],
        NOW,
      ),
    });

    await fireEvent.press(screen.getByLabelText("Postpone: Pay the rent"));
    // Keeping today's task stages no write; the postponed one is the whole batch.
    await fireEvent.press(screen.getByLabelText("Keep: Buy milk"));
    await fireEvent.press(screen.getByLabelText("Apply changes"));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith([{ id: "rent", dueAt: TOMORROW }]);
  });

  it("stays open with an error when applying throws, and can still be closed", async () => {
    const { onApply, onClose } = await mount({
      items: planDayItems([task("rent", "Pay the rent", NOW - 2 * DAY)], NOW),
      apply: () => {
        throw new Error("disk full");
      },
    });

    await fireEvent.press(screen.getByLabelText("Postpone: Pay the rent"));
    await fireEvent.press(screen.getByLabelText("Apply changes"));

    expect(onApply).toHaveBeenCalledTimes(1);
    // Partial failure must not wedge the pass: an honest error, and every way out still works.
    expect(
      screen.getByText("Some changes could not be saved. They will be offered again next time."),
    ).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    const [closeButton] = screen.getAllByLabelText("Close");
    await fireEvent.press(closeButton!);
    expect(onClose).toHaveBeenCalled();
  });

  it("offers the upcoming picker on an empty day and pulls a task into the plan", async () => {
    // Nothing overdue, nothing due today: the pass starts from the empty state.
    const { onApply } = await mount({ upcoming: [task("laundry", "Laundry", NOW + 2 * DAY)] });

    expect(screen.getByText("Nothing to plan")).toBeTruthy();
    await fireEvent.press(screen.getByText("Add from upcoming"));
    await fireEvent.press(screen.getByLabelText("Add from upcoming: Laundry"));

    // Pulled in to be planned: keeping it moves it to today.
    expect(screen.getByText("Moves to Today")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Apply changes"));
    expect(onApply).toHaveBeenCalledWith([{ id: "laundry", dueAt: endOfDay(NOW) }]);
  });

  it("excludes tasks beyond the 7-day horizon and already-pulled ones from the picker", async () => {
    // The pool is the screen's `planDayUpcoming` output -- the same cut the real Today passes in.
    const all = [
      task("laundry", "Laundry", NOW + 2 * DAY),
      task("report", "Next month's report", NOW + 12 * DAY),
    ];
    await mount({ upcoming: planDayUpcoming(all, NOW) });

    await fireEvent.press(screen.getByText("Add from upcoming"));
    expect(screen.getByText("Laundry")).toBeTruthy();
    expect(screen.queryByText("Next month's report")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Add from upcoming: Laundry"));
    // Pulled tasks leave the pool instead of being added twice.
    expect(screen.queryByLabelText("Add from upcoming: Laundry")).toBeNull();
  });

  it("scrolls a long review together with the picker, keeping Apply pinned outside", async () => {
    const review = Array.from({ length: 12 }, (_, i) =>
      task(`r${i}`, `Review ${i}`, NOW - (i + 1) * DAY),
    );
    const upcoming = Array.from({ length: 8 }, (_, i) =>
      task(`u${i}`, `Upcoming ${i}`, NOW + (i % 6) * DAY + DAY),
    );
    await mount({ items: planDayItems(review, NOW), upcoming });
    await fireEvent.press(screen.getByText("Add from upcoming"));

    const scroller = screen.getByTestId("plan-day-scroll");
    // No fixed height: the scroller shrinks to the sheet's room instead of overflowing it.
    expect(StyleSheet.flatten(scroller.props.style)).toMatchObject({ flexShrink: 1 });
    expect(StyleSheet.flatten(scroller.props.style).maxHeight).toBeUndefined();
    const inScroller = (label: string) => within(scroller).queryAllByLabelText(label).length > 0;
    // Every review and picker row scrolls into reach, in the one scroller...
    expect(inScroller("Keep: Review 11")).toBe(true);
    expect(inScroller("Add from upcoming: Upcoming 7")).toBe(true);
    // ...while Apply sits outside it, always on screen.
    expect(screen.getByLabelText("Apply changes")).toBeTruthy();
    expect(inScroller("Apply changes")).toBe(false);
  });
});
