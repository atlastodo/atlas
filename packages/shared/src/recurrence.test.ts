import { describe, it, expect } from "vitest";
import fixture from "../../../test-vectors/recurrence_vectors.json";
import da from "./locales/da.json";
import {
  advanceSeries,
  anchorMonthDay,
  formatRule,
  nextOccurrence,
  nextOccurrenceCivil,
  parseRule,
  pinMonthDay,
  ruleToString,
  type CivilDateTime,
  type Translate,
} from "./recurrence";
import { zonedParts } from "./zonedTime";

/** `2026-03-28T23:59:00(.mmm)` -> civil fields (month 1-12). */
function civil(local: string): CivilDateTime {
  const m = /^(\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?$/.exec(local);
  if (!m) throw new Error(`bad local time in fixture: ${local}`);
  const [, y, mo, d, h, mi, s, ms] = m;
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
    millisecond: Number(ms ?? 0),
  };
}

/** The wall-clock time `ms` shows in `tz`, in the fixture's local format. */
function localOf(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const milli = ((ms % 1000) + 1000) % 1000;
  return (
    `${pad(p.year, 4)}-${pad(p.month + 1)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    (milli ? `.${pad(milli, 3)}` : "")
  );
}

describe("recurrence parity vectors", () => {
  it("has vectors", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
  });

  for (const v of fixture.vectors) {
    it(`instants in ${v.tz}: ${v.name}`, () => {
      expect(nextOccurrence(v.rule, v.anchor, v.from, v.tz)).toBe(v.expected);
    });

    it(`civil engine (as Rust runs it): ${v.name}`, () => {
      const got = nextOccurrenceCivil(v.rule, civil(v.anchor_local), civil(v.from_local));
      expect(got).toEqual(v.expected_local === null ? null : civil(v.expected_local));
    });

    it(`fixture is self-consistent: ${v.name}`, () => {
      // Rust only sees the locals, so they must be exactly what the instants show in the zone.
      expect(localOf(v.anchor, v.tz)).toBe(v.anchor_local);
      expect(localOf(v.from, v.tz)).toBe(v.from_local);
      if (v.expected !== null) expect(localOf(v.expected, v.tz)).toBe(v.expected_local);
    });
  }

  for (const p of fixture.parse) {
    it(`parses like Rust: ${JSON.stringify(p.rule)} is ${p.valid ? "valid" : "invalid"}`, () => {
      expect(parseRule(p.rule) !== null).toBe(p.valid);
    });
  }
});

describe("parseRule", () => {
  it("parses a full rule", () => {
    expect(parseRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;MODE=COMPLETION")).toEqual({
      freq: "weekly",
      interval: 2,
      byday: [0, 2],
      bymonthday: null,
      mode: "after_completion",
    });
  });

  it("defaults interval and mode", () => {
    expect(parseRule("FREQ=DAILY")).toEqual({
      freq: "daily",
      interval: 1,
      byday: [],
      bymonthday: null,
      mode: "on_schedule",
    });
  });

  it("parses a monthly day of month", () => {
    expect(parseRule("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31")).toEqual({
      freq: "monthly",
      interval: 2,
      byday: [],
      bymonthday: 31,
      mode: "on_schedule",
    });
  });

  it("rejects malformed rules", () => {
    for (const bad of [
      "",
      "FREQ=BOGUS",
      "INTERVAL=2",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=WEEKLY;BYDAY=XX",
      "FREQ=DAILY;WUT=1",
    ]) {
      expect(parseRule(bad)).toBeNull();
    }
  });

  it("round-trips through ruleToString", () => {
    for (const s of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;INTERVAL=2",
      "FREQ=WEEKLY;BYDAY=MO,WE",
      "FREQ=MONTHLY;MODE=COMPLETION",
      "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=31",
    ]) {
      expect(ruleToString(parseRule(s)!)).toBe(s);
    }
  });

  it("drops a day of month that does not take effect after completion", () => {
    expect(ruleToString(parseRule("FREQ=MONTHLY;BYMONTHDAY=31;MODE=COMPLETION")!)).toBe(
      "FREQ=MONTHLY;MODE=COMPLETION",
    );
  });
});

describe("anchorMonthDay", () => {
  const utc = (iso: string) => Date.parse(`${iso}Z`);

  it("gives a monthly rule the due date's day of month", () => {
    expect(anchorMonthDay("FREQ=MONTHLY", utc("2023-01-31T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=31",
    );
    expect(anchorMonthDay("FREQ=MONTHLY;INTERVAL=2", utc("2023-01-15T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15",
    );
  });

  it("keeps a day that lands on the due date in a short month", () => {
    expect(anchorMonthDay("FREQ=MONTHLY;BYMONTHDAY=31", utc("2023-02-28T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=31",
    );
    expect(anchorMonthDay("FREQ=MONTHLY;BYMONTHDAY=30", utc("2023-04-30T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=30",
    );
  });

  it("moves a day the due date no longer falls on", () => {
    expect(anchorMonthDay("FREQ=MONTHLY;BYMONTHDAY=31", utc("2023-03-20T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=20",
    );
    // Feb 28 is not the end of a leap February, so 31 no longer lands there.
    expect(anchorMonthDay("FREQ=MONTHLY;BYMONTHDAY=31", utc("2024-02-28T09:00:00"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=28",
    );
  });

  it("reads the day in the user's zone", () => {
    // 2026-01-31 23:59 in New York is already Feb 1 in UTC.
    const due = Date.parse("2026-02-01T04:59:00Z");
    expect(anchorMonthDay("FREQ=MONTHLY", due, "America/New_York")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=31",
    );
    expect(anchorMonthDay("FREQ=MONTHLY", due, "UTC")).toBe("FREQ=MONTHLY;BYMONTHDAY=1");
  });

  it("leaves every other rule as it is", () => {
    const due = utc("2023-01-31T09:00:00");
    for (const rule of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO",
      "FREQ=YEARLY",
      "FREQ=YEARLY;MODE=COMPLETION",
      "FREQ=MONTHLY;MODE=COMPLETION",
      "freq=weekly",
      "nonsense",
    ]) {
      expect(anchorMonthDay(rule, due, "UTC")).toBe(rule);
    }
    expect(anchorMonthDay("FREQ=MONTHLY", NaN, "UTC")).toBe("FREQ=MONTHLY");
  });
});

describe("anchorMonthDay for yearly rules", () => {
  const utc = (iso: string) => Date.parse(`${iso}Z`);

  it("keeps a leap day, and only a leap day", () => {
    expect(anchorMonthDay("FREQ=YEARLY", utc("2024-02-29T09:00:00"), "UTC")).toBe(
      "FREQ=YEARLY;BYMONTHDAY=29",
    );
    expect(anchorMonthDay("FREQ=YEARLY", utc("2024-03-01T09:00:00"), "UTC")).toBe("FREQ=YEARLY");
    // Feb 28 is where the leap day clamps to in a common year.
    const rule = "FREQ=YEARLY;BYMONTHDAY=29";
    expect(anchorMonthDay(rule, utc("2025-02-28T09:00:00"), "UTC")).toBe(rule);
    expect(anchorMonthDay(rule, utc("2025-06-10T09:00:00"), "UTC")).toBe("FREQ=YEARLY");
  });

  it("returns to Feb 29 every leap year instead of settling on the 28th", () => {
    let due = utc("2024-02-29T09:00:00");
    const rule = anchorMonthDay("FREQ=YEARLY", due, "UTC");
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      due = nextOccurrence(rule, due, due, "UTC")!;
      seen.push(new Date(due).toISOString().slice(0, 10));
    }
    expect(seen).toEqual(["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
    expect(formatRule(rule)).toBe(formatRule("FREQ=YEARLY"));
  });
});

describe("pinMonthDay", () => {
  it("adds the due date's day to a monthly rule that has none", () => {
    expect(pinMonthDay("FREQ=MONTHLY", Date.parse("2023-01-31T09:00:00Z"), "UTC")).toBe(
      "FREQ=MONTHLY;BYMONTHDAY=31",
    );
  });

  it("leaves a day the rule already has alone, even one the due date is not on", () => {
    const rule = "FREQ=MONTHLY;BYMONTHDAY=31";
    expect(pinMonthDay(rule, Date.parse("2023-03-20T09:00:00Z"), "UTC")).toBe(rule);
  });

  it("keeps an old rule's next step and stops a short month from shortening it for good", () => {
    const jan31 = Date.parse("2023-01-31T09:00:00Z");
    const pinned = pinMonthDay("FREQ=MONTHLY", jan31, "UTC");
    const feb = nextOccurrence(pinned, jan31, jan31, "UTC")!;
    expect(feb).toBe(nextOccurrence("FREQ=MONTHLY", jan31, jan31, "UTC"));
    expect(new Date(feb).toISOString()).toBe("2023-02-28T09:00:00.000Z");
    expect(new Date(nextOccurrence(pinned, feb, feb, "UTC")!).toISOString()).toBe(
      "2023-03-31T09:00:00.000Z",
    );
  });
});

describe("formatRule", () => {
  it("summarizes rules for humans", () => {
    expect(formatRule("FREQ=DAILY")).toBe("Every day");
    expect(formatRule("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
    expect(formatRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")).toBe("Every 2 weeks on Mon, Wed");
    expect(formatRule("FREQ=MONTHLY;MODE=COMPLETION")).toBe("Every month (after completion)");
    expect(formatRule("FREQ=YEARLY")).toBe("Every year");
    expect(formatRule("FREQ=MONTHLY;BYMONTHDAY=31")).toBe("Every month on day 31");
    expect(formatRule("FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1")).toBe("Every 2 months on day 1");
    // After completion the day of month does not apply, so the summary does not claim it.
    expect(formatRule("FREQ=MONTHLY;BYMONTHDAY=31;MODE=COMPLETION")).toBe(
      "Every month (after completion)",
    );
    expect(formatRule("nonsense")).toBeNull();
  });

  it("summarizes in the translator's language", () => {
    // i18next's lookup, reduced to what the summary keys use: `_one`/`_other` and `{{name}}`.
    const table: Record<string, string> = da.recurrence.summary;
    const danish: Translate = (key, params) => {
      const name = key.replace("recurrence.summary.", "");
      const template = table[name] ?? table[`${name}_${params.count === 1 ? "one" : "other"}`]!;
      return template.replace(/\{\{(\w+)\}\}/g, (_, p: string) => String(params[p]));
    };
    expect(formatRule("FREQ=DAILY", danish)).toBe("Hver dag");
    expect(formatRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", danish)).toBe(
      "Hver 2. uge på man, ons",
    );
    expect(formatRule("FREQ=MONTHLY;BYMONTHDAY=31", danish)).toBe("Hver måned den 31.");
    expect(formatRule("FREQ=YEARLY;MODE=COMPLETION", danish)).toBe("Hvert år (efter fuldførelse)");
  });
});

describe("nextOccurrence modes (UTC)", () => {
  it("on-schedule rules ignore the completion reference entirely", () => {
    expect(
      nextOccurrence("FREQ=DAILY;MODE=SCHEDULE", 1_672_531_200_000, 1_000_000_000_000, "UTC"),
    ).toBe(1_672_617_600_000);
  });

  it("after completion, completing late re-anchors the interval to the completion day", () => {
    // Due 2023-01-01, completed 2023-01-11: the next occurrence is Jan 13, not Jan 3.
    expect(
      nextOccurrence(
        "FREQ=DAILY;INTERVAL=2;MODE=COMPLETION",
        1_672_531_200_000,
        1_673_395_200_000,
        "UTC",
      ),
    ).toBe(1_673_568_000_000);
  });

  it("after completion, completing early re-anchors to the completion day too", () => {
    // Completed a day before the due date: the series continues from the completion day.
    expect(
      nextOccurrence(
        "FREQ=DAILY;INTERVAL=2;MODE=COMPLETION",
        1_673_308_800_000,
        1_673_222_400_000,
        "UTC",
      ),
    ).toBe(1_673_395_200_000);
  });

  it("after completion keeps the anchor's time of day (all-day vs timed dues differ only in that time)", () => {
    // A timed task (09:00 due) completed at 15:00 still rolls forward at 09:00.
    expect(
      nextOccurrence("FREQ=DAILY;MODE=COMPLETION", 1_672_563_600_000, 1_672_930_800_000, "UTC"),
    ).toBe(1_672_995_600_000);
    // An all-day task (00:00 due) rolls forward at midnight of the completion day.
    expect(
      nextOccurrence("FREQ=DAILY;MODE=COMPLETION", 1_672_531_200_000, 1_672_930_800_000, "UTC"),
    ).toBe(1_672_963_200_000);
  });
});

describe("nextOccurrence in a time zone", () => {
  const CPH = "Europe/Copenhagen";

  it("resolves a wall-clock time the spring-forward gap skips to the same instant an hour on", () => {
    const sat0230 = 1_774_661_400_000; // Sat 2026-03-28 02:30 CET
    // Sun 02:30 does not exist in Copenhagen; the clock reads 03:30 CEST at that instant.
    expect(nextOccurrence("FREQ=DAILY", sat0230, sat0230, CPH)).toBe(1_774_747_800_000);
  });

  it("keeps sub-second precision of the anchor", () => {
    const anchor = 1_774_738_740_123; // Sat 2026-03-28 23:59:00.123 CET
    expect(nextOccurrence("FREQ=DAILY", anchor, anchor, CPH)).toBe(1_774_821_540_123);
  });

  it("defaults to the runtime zone", () => {
    const anchor = 1_774_738_740_000;
    expect(nextOccurrence("FREQ=DAILY", anchor, anchor)).toBe(
      nextOccurrence(
        "FREQ=DAILY",
        anchor,
        anchor,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    );
  });
});

describe("nextOccurrence bounds", () => {
  it("returns null, never throws, for an anchor or reference that is not a date", () => {
    for (const bad of [NaN, Infinity, -Infinity, 9e15]) {
      expect(nextOccurrence("FREQ=DAILY", bad, 0, "UTC")).toBeNull();
      expect(nextOccurrence("FREQ=DAILY;MODE=COMPLETION", 0, bad, "UTC")).toBeNull();
    }
  });

  it("rejects an impossible civil anchor", () => {
    const at = { hour: 9, minute: 0, second: 0, millisecond: 0 };
    const from = { year: 2026, month: 1, day: 1 };
    expect(
      nextOccurrenceCivil("FREQ=DAILY", { year: 2026, month: 2, day: 30, ...at }, from),
    ).toBeNull();
    expect(
      nextOccurrenceCivil("FREQ=DAILY", { year: 2026, month: 13, day: 1, ...at }, from),
    ).toBeNull();
    expect(
      nextOccurrenceCivil("FREQ=DAILY", { year: 2026, month: 1, day: 1, ...at, hour: 24 }, from),
    ).toBeNull();
    expect(
      nextOccurrenceCivil("FREQ=YEARLY", { year: 2 ** 31 - 1, month: 1, day: 1, ...at }, from),
    ).toBeNull();
  });

  // ~10,500 nextOccurrence calls: on a loaded CI runner (all test jobs share it) this crossed
  // vitest's 5s default and timed out, so give the brute force room to breathe.
  it("BYDAY matches a day-by-day scan for every weekday set, interval and starting day", () => {
    // The reference is the obvious day-by-day scan.
    const DAY = 86_400_000;
    const scan = (byday: number[], interval: number, anchorDay: number, base: number) => {
      const wd = (d: number) => (((d + 3) % 7) + 7) % 7;
      const refWeek = anchorDay - wd(anchorDay);
      for (let day = base + 1; ; day++) {
        const weeks = (day - wd(day) - refWeek) / 7;
        if (byday.includes(wd(day)) && weeks >= 0 && weeks % interval === 0) return day;
      }
    };
    const anchorDay = 19_359; // Mon 2023-01-02
    for (let mask = 1; mask < 128; mask += 3) {
      const byday = [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
      const tokens = byday.map((d) => ["MO", "TU", "WE", "TH", "FR", "SA", "SU"][d]).join(",");
      for (const interval of [1, 2, 3, 5]) {
        const rule = `FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${tokens};MODE=COMPLETION`;
        for (let base = anchorDay - 20; base < anchorDay + 40; base++) {
          expect(nextOccurrence(rule, anchorDay * DAY, base * DAY, "UTC")).toBe(
            scan(byday, interval, anchorDay, base) * DAY,
          );
        }
      }
    }
  }, 30_000);
});

describe("parseRule modes", () => {
  it("round-trips the after-completion mode", () => {
    for (const s of ["FREQ=DAILY;MODE=COMPLETION", "FREQ=WEEKLY;BYDAY=MO;MODE=COMPLETION"]) {
      expect(ruleToString(parseRule(s)!)).toBe(s);
    }
  });

  it("rejects unknown modes", () => {
    expect(parseRule("FREQ=DAILY;MODE=BOGUS")).toBeNull();
  });
});

describe("advanceSeries across a DST gap", () => {
  const NY = "America/New_York";
  const local = (ms: number) => {
    const p = zonedParts(ms, NY);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${p.year}-${pad(p.month + 1)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
  };
  // 2024-03-09 02:30 EST, the night before the US spring-forward (02:00 -> 03:00).
  const mar9 = Date.parse("2024-03-09T07:30:00Z");

  it("shows the skipped time forward, then returns to the series' own time", () => {
    const first = advanceSeries("FREQ=DAILY", mar9, mar9, NY)!;
    expect(local(first.next)).toBe("2024-03-10 03:30");
    expect(first.rule).toBe("FREQ=DAILY;BYHOUR=2;BYMINUTE=30");
    const second = advanceSeries(first.rule, first.next, first.next, NY)!;
    expect(local(second.next)).toBe("2024-03-11 02:30");
    expect(second.rule).toBe("FREQ=DAILY");
  });

  it("leaves a series that is really at 03:30 alone", () => {
    const at330 = Date.parse("2024-03-09T08:30:00Z");
    const first = advanceSeries("FREQ=DAILY", at330, at330, NY)!;
    expect([local(first.next), first.rule]).toEqual(["2024-03-10 03:30", "FREQ=DAILY"]);
    const second = advanceSeries(first.rule, first.next, first.next, NY)!;
    expect([local(second.next), second.rule]).toEqual(["2024-03-11 03:30", "FREQ=DAILY"]);
  });

  it("keeps the time while it fits the due date and drops it on a manual reschedule", () => {
    const { next, rule } = advanceSeries("FREQ=DAILY", mar9, mar9, NY)!;
    expect(anchorMonthDay(rule, next, NY)).toBe(rule);
    expect(anchorMonthDay(rule, next + 3_600_000, NY)).toBe("FREQ=DAILY");
  });

  it("parses the time only as a pair", () => {
    expect(parseRule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30")?.at).toEqual({ hour: 2, minute: 30 });
    expect(parseRule("FREQ=DAILY;BYHOUR=2")).toBeNull();
    expect(parseRule("FREQ=DAILY;BYHOUR=24;BYMINUTE=0")).toBeNull();
    expect(parseRule("FREQ=DAILY;BYHOUR=1;BYMINUTE=60")).toBeNull();
    expect(formatRule("FREQ=DAILY;BYHOUR=2;BYMINUTE=30")).toBe(formatRule("FREQ=DAILY"));
  });
});
