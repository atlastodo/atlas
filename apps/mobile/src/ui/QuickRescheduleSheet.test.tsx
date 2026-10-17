import { fireEvent, render, screen } from "@testing-library/react-native";
import { quickScheduleOptions } from "@atlastodo/shared";
import { QuickRescheduleSheet } from "./QuickRescheduleSheet";

/**
 * The sheet's net-new logic is the choice-to-instant mapping; the swipe *gesture* that opens it and
 * its rules live in `@atlastodo/shared/swipe` (tested there, without a touchscreen). So these assert
 * the sheet maps a choice to the right instant and closes, not the swipe.
 */

const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime();

async function mount(props: Partial<React.ComponentProps<typeof QuickRescheduleSheet>> = {}) {
  const onPick = jest.fn();
  const onClose = jest.fn();
  await render(
    <QuickRescheduleSheet
      title="Call the dentist"
      now={NOW}
      onPick={onPick}
      onClose={onClose}
      {...props}
    />,
  );
  return { onPick, onClose };
}

describe("QuickRescheduleSheet", () => {
  it("offers the four quick targets and a clear", async () => {
    await mount();
    expect(screen.getByLabelText("Today")).toBeTruthy();
    expect(screen.getByLabelText("Tomorrow")).toBeTruthy();
    expect(screen.getByLabelText("This weekend")).toBeTruthy();
    expect(screen.getByLabelText("Next week")).toBeTruthy();
    expect(screen.getByLabelText("No date")).toBeTruthy();
  });

  it("reschedules to the weekend", async () => {
    const { onPick } = await mount();
    const weekend = quickScheduleOptions(NOW).find((o) => o.key === "weekend")!;
    await fireEvent.press(screen.getByLabelText("This weekend"));
    expect(onPick).toHaveBeenCalledWith(weekend.dueAt);
  });

  it("picks the instant `quickScheduleOptions` computes", async () => {
    // The sheet must not invent its own dates -- the phone and the web reschedule to the same instant.
    const { onPick } = await mount();
    const tomorrow = quickScheduleOptions(NOW).find((o) => o.key === "tomorrow")!;
    await fireEvent.press(screen.getByLabelText("Tomorrow"));
    expect(onPick).toHaveBeenCalledWith(tomorrow.dueAt);
  });

  it("clears the due date", async () => {
    const { onPick } = await mount();
    await fireEvent.press(screen.getByLabelText("No date"));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("is not visible with no task", async () => {
    // `title === null` is the closed state; a Modal with visible=false renders nothing.
    await mount({ title: null });
    expect(screen.queryByLabelText("Tomorrow")).toBeNull();
  });

  it("closes on the backdrop", async () => {
    const { onClose } = await mount();
    // Two "Close" controls (backdrop + header X); pressing either dismisses.
    const [backdrop] = screen.getAllByLabelText("Close");
    await fireEvent.press(backdrop!);
    expect(onClose).toHaveBeenCalled();
  });
});
