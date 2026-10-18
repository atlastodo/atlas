import { describe, it, expect } from "vitest";
import { quickScheduleOptions } from "./quickSchedule";
import { endOfDay, addDays, dayOffset } from "@atlastodo/shared";

const TZ = "UTC";
// 2026-07-07T08:30:00Z; a fixed early-morning instant.
const NOW = Date.UTC(2026, 6, 7, 8, 30, 0);

describe("quickScheduleOptions", () => {
  it("offers today, tomorrow, this weekend and next week in order", () => {
    expect(quickScheduleOptions(NOW, TZ).map((o) => o.key)).toEqual([
      "today",
      "tomorrow",
      "weekend",
      "nextWeek",
    ]);
  });

  it("lands each option at default due time (23:59, end of day) of the right calendar day", () => {
    const opts = quickScheduleOptions(NOW, TZ);
    expect(opts[0]!.dueAt).toBe(endOfDay(NOW, TZ));
    expect(opts[1]!.dueAt).toBe(endOfDay(addDays(NOW, 1, TZ), TZ));
    expect(opts[3]!.dueAt).toBe(endOfDay(addDays(NOW, 7, TZ), TZ));
  });

  it("produces due dates 0, 1, and 7 days out from now", () => {
    const opts = quickScheduleOptions(NOW, TZ);
    expect(dayOffset(opts[0]!.dueAt, NOW, TZ)).toBe(0);
    expect(dayOffset(opts[1]!.dueAt, NOW, TZ)).toBe(1);
    expect(dayOffset(opts[3]!.dueAt, NOW, TZ)).toBe(7);
  });

  it("sets today's target to end of day (23:59)", () => {
    expect(quickScheduleOptions(NOW, TZ)[0]!.dueAt).toBe(endOfDay(NOW, TZ));
  });
});

describe("the weekend option", () => {
  const weekendOffset = (now: number, timeZone = TZ) =>
    dayOffset(
      quickScheduleOptions(now, timeZone).find((o) => o.key === "weekend")!.dueAt,
      now,
      timeZone,
    );

  it("points at the coming Saturday from a weekday", () => {
    // NOW is a Tuesday; Saturday is four days out.
    expect(new Date(NOW).getUTCDay()).toBe(2);
    expect(weekendOffset(NOW)).toBe(4);
  });

  it("means today once the weekend has started", () => {
    const saturday = Date.UTC(2026, 6, 11, 9, 30);
    const sunday = Date.UTC(2026, 6, 12, 9, 30);
    expect(new Date(saturday).getUTCDay()).toBe(6);
    expect(new Date(sunday).getUTCDay()).toBe(0);
    // Asking for "this weekend" on a Sunday must not mean the Saturday six days away.
    expect(weekendOffset(saturday)).toBe(0);
    expect(weekendOffset(sunday)).toBe(0);
  });

  it("reads the weekday in the given zone, not UTC", () => {
    // Friday 23:00 in Copenhagen is still Friday 21:00 UTC; but late on a Saturday in Auckland,
    // where the weekend has already begun.
    const fridayEvening = Date.UTC(2026, 6, 10, 21, 0);
    expect(weekendOffset(fridayEvening, "Europe/Copenhagen")).toBe(1);
    expect(weekendOffset(fridayEvening, "Pacific/Auckland")).toBe(0);
  });
});
