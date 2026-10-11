import { describe, it, expect } from "vitest";
import {
  addDays,
  dayKey,
  dayOffset,
  endOfDay,
  isValidTimeZone,
  makeInstant,
  resolveTimeZone,
  shiftWallClockToZone,
  startOfDay,
  zonedParts,
} from "./zonedTime";

const NY = "America/New_York";
const LONDON = "Europe/London";
const UTC = "UTC";

describe("zonedTime", () => {
  it("maps an instant to the correct calendar day per zone", () => {
    // 2026-07-15 02:00 UTC is still 2026-07-14 (22:00) in New York (EDT, UTC-4).
    const ms = Date.UTC(2026, 6, 15, 2, 0, 0);
    expect(dayKey(ms, UTC)).toBe("2026-07-15");
    expect(dayKey(ms, NY)).toBe("2026-07-14");
  });

  it("startOfDay returns local midnight for the zone", () => {
    const noonUtc = Date.UTC(2026, 6, 15, 12, 0, 0);
    // Midnight 2026-07-15 in NY (EDT, UTC-4) is 04:00 UTC.
    expect(startOfDay(noonUtc, NY)).toBe(Date.UTC(2026, 6, 15, 4, 0, 0));
    expect(startOfDay(noonUtc, UTC)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("is correct across a spring-forward DST boundary", () => {
    // DST starts 2026-03-08 in the US: clocks jump 02:00 EST -> 03:00 EDT.
    const noon = Date.UTC(2026, 2, 8, 15, 0, 0); // midday-ish on Mar 8, well after the jump
    // Midnight Mar 8 is still EST (UTC-5) -> 05:00 UTC.
    expect(startOfDay(noon, NY)).toBe(Date.UTC(2026, 2, 8, 5, 0, 0));
    // 23:59 Mar 8 is EDT (UTC-4) -> 03:59 UTC on Mar 9.
    expect(endOfDay(noon, NY)).toBe(Date.UTC(2026, 2, 9, 3, 59, 0));
    // Advancing one calendar day lands on midnight Mar 9 EDT (04:00 UTC) — a 23h physical gap.
    expect(addDays(startOfDay(noon, NY), 1, NY)).toBe(Date.UTC(2026, 2, 9, 4, 0, 0));
  });

  it("makeInstant round-trips with zonedParts", () => {
    const ms = makeInstant(2026, 2, 8, 12, 30, 0, NY);
    const p = zonedParts(ms, NY);
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 2, 8, 12, 30]);
  });

  it("dayOffset compares calendar days in the zone", () => {
    const now = Date.UTC(2026, 6, 15, 2, 0, 0); // NY: 2026-07-14
    const due = Date.UTC(2026, 6, 15, 20, 0, 0); // NY: 2026-07-15
    expect(dayOffset(due, now, NY)).toBe(1);
    expect(dayOffset(due, now, UTC)).toBe(0);
  });

  it("exposes weekday (0=Sun)", () => {
    // 2026-07-15 is a Wednesday.
    expect(zonedParts(Date.UTC(2026, 6, 15, 12, 0, 0), UTC).weekday).toBe(3);
  });

  describe("shiftWallClockToZone", () => {
    it("preserves the wall-clock time in the new zone", () => {
      // 9:00 AM on 2026-07-15 in New York (EDT, UTC-4).
      const nyNineAm = makeInstant(2026, 6, 15, 9, 0, 0, NY);
      const shifted = shiftWallClockToZone(nyNineAm, NY, LONDON);
      const p = zonedParts(shifted, LONDON);
      expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 6, 15, 9, 0]);
      // The instant actually moved (NY 9am and London 9am are different moments).
      expect(shifted).not.toBe(nyNineAm);
    });

    it("is a no-op when the zones match", () => {
      const ms = makeInstant(2026, 6, 15, 17, 30, 0, NY);
      expect(shiftWallClockToZone(ms, NY, NY)).toBe(ms);
    });

    it("keeps the local time across a DST boundary", () => {
      // 08:00 on 2026-03-08 (US spring-forward day) should stay 08:00 in the target zone.
      const ms = makeInstant(2026, 2, 8, 8, 0, 0, NY);
      const p = zonedParts(shiftWallClockToZone(ms, NY, LONDON), LONDON);
      expect([p.hour, p.minute]).toEqual([8, 0]);
    });
  });
});

describe("invalid input", () => {
  it("zonedParts yields NaN parts instead of throwing for an instant that is not a date", () => {
    for (const bad of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1, 1e300]) {
      const p = zonedParts(bad, NY);
      expect(Number.isNaN(p.year)).toBe(true);
      expect(Number.isNaN(p.weekday)).toBe(true);
    }
  });

  it("the helpers built on it degrade to NaN rather than throwing", () => {
    expect(Number.isNaN(startOfDay(NaN, NY))).toBe(true);
    expect(Number.isNaN(endOfDay(Infinity, NY))).toBe(true);
    expect(Number.isNaN(dayOffset(NaN, Date.UTC(2026, 0, 1), NY))).toBe(true);
    expect(dayKey(NaN, NY)).toBe("NaN-NaN-NaN");
  });

  it("still accepts the extremes of the Date range", () => {
    expect(zonedParts(8.64e15, UTC).year).toBe(275760);
    expect(zonedParts(-8.64e15, UTC).year).toBe(-271821);
  });

  it("an unknown zone falls back to the runtime zone instead of throwing", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone(NY)).toBe(true);
    expect(resolveTimeZone("Not/AZone")).toBe(resolveTimeZone(undefined));
    const ms = Date.UTC(2026, 6, 15, 2, 0, 0);
    expect(zonedParts(ms, "Not/AZone")).toEqual(zonedParts(ms));
  });
});

describe("makeInstant in a DST gap", () => {
  it("resolves a skipped wall time forward by the gap's length", () => {
    // US spring-forward 2024-03-10 02:00 -> 03:00 EDT; 02:30 does not exist.
    expect(new Date(makeInstant(2024, 2, 10, 2, 30, 0, "America/New_York")).toISOString()).toBe(
      "2024-03-10T07:30:00.000Z",
    );
    // Lord Howe's 30-minute gap: 02:00 -> 02:30.
    const lh = makeInstant(2024, 9, 6, 2, 15, 0, "Australia/Lord_Howe");
    expect(zonedParts(lh, "Australia/Lord_Howe")).toMatchObject({ hour: 2, minute: 45 });
  });

  it("leaves existing wall times exact", () => {
    expect(new Date(makeInstant(2024, 2, 10, 3, 30, 0, "America/New_York")).toISOString()).toBe(
      "2024-03-10T07:30:00.000Z",
    );
    expect(new Date(makeInstant(2024, 2, 10, 1, 59, 0, "America/New_York")).toISOString()).toBe(
      "2024-03-10T06:59:00.000Z",
    );
  });
});
