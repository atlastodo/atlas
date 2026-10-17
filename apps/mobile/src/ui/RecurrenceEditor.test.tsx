import { fireEvent, render, screen } from "@testing-library/react-native";
import { parseRule } from "@atlastodo/shared";
import { RecurrenceEditor } from "./RecurrenceEditor";

/**
 * The recurrence engine (parse/format/roll-forward) is `@atlastodo/shared`, tested there; these assert
 * the editor emits the right rule string for a choice and turns recurrence off. The rule string is
 * parsed back with the shared `parseRule` so the test never hard-codes the wire format.
 */

describe("RecurrenceEditor", () => {
  it("emits a rule when a frequency is chosen for a one-off task", async () => {
    const onChange = jest.fn();
    await render(<RecurrenceEditor value={null} onChange={onChange} />);

    await fireEvent.press(screen.getByLabelText("Weekly"));

    const rule = parseRule(onChange.mock.calls[0][0]);
    expect(rule?.freq).toBe("weekly");
    expect(rule?.interval).toBe(1);
  });

  it("turns recurrence off with 'Does not repeat'", async () => {
    const onChange = jest.fn();
    await render(
      <RecurrenceEditor value="FREQ=DAILY;INTERVAL=1;MODE=SCHEDULE" onChange={onChange} />,
    );

    await fireEvent.press(screen.getByLabelText("Does not repeat"));

    // null is "one-off"; anything else would keep the task recurring.
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("bumps the interval", async () => {
    const onChange = jest.fn();
    await render(
      <RecurrenceEditor value="FREQ=DAILY;INTERVAL=1;MODE=SCHEDULE" onChange={onChange} />,
    );

    await fireEvent.press(screen.getByLabelText("+"));
    expect(parseRule(onChange.mock.calls[0][0])?.interval).toBe(2);
  });

  it("never drops the interval below one", async () => {
    const onChange = jest.fn();
    await render(
      <RecurrenceEditor value="FREQ=DAILY;INTERVAL=1;MODE=SCHEDULE" onChange={onChange} />,
    );

    await fireEvent.press(screen.getByLabelText("-"));
    // An interval of 0 would mean "every 0 days" -- never advancing.
    expect(parseRule(onChange.mock.calls[0][0])?.interval).toBe(1);
  });

  it("offers weekday toggles only for a weekly rule", async () => {
    const { rerender } = await render(
      <RecurrenceEditor value="FREQ=DAILY;INTERVAL=1;MODE=SCHEDULE" onChange={() => {}} />,
    );
    // Daily has no weekday picker.
    expect(screen.queryByLabelText("Mon")).toBeNull();

    await rerender(
      <RecurrenceEditor value="FREQ=WEEKLY;INTERVAL=1;MODE=SCHEDULE" onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Mon")).toBeTruthy();
  });

  it("toggles a weekday into the rule", async () => {
    const onChange = jest.fn();
    await render(
      <RecurrenceEditor value="FREQ=WEEKLY;INTERVAL=1;MODE=SCHEDULE" onChange={onChange} />,
    );

    await fireEvent.press(screen.getByLabelText("Wed")); // index 2
    expect(parseRule(onChange.mock.calls[0][0])?.byday).toEqual([2]);
  });

  it("keeps a monthly rule's day of month through an interval change", async () => {
    const onChange = jest.fn();
    await render(<RecurrenceEditor value="FREQ=MONTHLY;BYMONTHDAY=31" onChange={onChange} />);

    expect(screen.getByText("Every month on day 31")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("+"));
    expect(parseRule(onChange.mock.calls[0][0])).toMatchObject({ interval: 2, bymonthday: 31 });
  });

  it("switches to schedule-from-completion", async () => {
    const onChange = jest.fn();
    await render(
      <RecurrenceEditor value="FREQ=DAILY;INTERVAL=1;MODE=SCHEDULE" onChange={onChange} />,
    );

    await fireEvent.press(screen.getByLabelText("Schedule next from completion date"));
    expect(parseRule(onChange.mock.calls[0][0])?.mode).toBe("after_completion");
  });

  it("shows nothing to configure for a one-off task", async () => {
    await render(<RecurrenceEditor value={null} onChange={() => {}} />);
    // No interval stepper until a frequency is picked.
    expect(screen.queryByLabelText("+")).toBeNull();
    expect(screen.getByLabelText("Does not repeat")).toBeTruthy();
  });
});
